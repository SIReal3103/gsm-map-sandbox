# A3 — Passenger Demand, Booking & Dispatch

Ngày nghiệm thu: 2026-10-12. Phạm vi: Proof of Concept, dữ liệu địa lý local của A1/A2.

## 1. Executive Summary

**GO A4 trong phạm vi PoC.** A1/A2 tiếp tục hoạt động; A3 tạo demand deterministic, precompute dispatch theo OSRM Table ETA và hai leg OSRM, rồi replay bằng một FleetClock chung. Desktop/mobile WebGL, scenario 5 xe/20 bookings, stress 10 xe/30 bookings và nhánh unserved đã được kiểm tra thực tế.

Backend **91 PASS, 0 SKIPPED**; frontend **39 PASS**; typecheck/build PASS. Đối chiếu độc lập **226 vị trí xe**, trạng thái booking và **5 snapshot metrics** PASS. Không có core check FAIL/BLOCKED. Không triển khai A4.

Đây không phải mô hình khai thác/GPS/hành khách GSM thực tế. Routing kế thừa giới hạn A1: 50 invalid restrictions đã bị loại trong preprocess lịch sử, kiểm toán lượt rẽ chỉ theo mẫu; boundary connectivity và độ chính xác OSM không được chứng nhận tuyệt đối.

## 2. Git và phạm vi thay đổi

- Repository root xác minh: `D:\ThS\VinAI\Phase3_VRIC\gsm-map-sandbox`.
- Branch: `feature/a3-passenger-dispatch`.
- HEAD trước/sau implementation: `a30bb9dc0ade1541c4a0d921f25d9bbd8f380cf3`.
- `main`: `cb36196c638c638bef39d323826592af02e3e9f7`, merge PR A2, chứa commit `80011da`.
- Branch A3 đã chứa code A2. HEAD và main khác lịch sử README; diff code nền A2 không khác. Giữ README của branch A3 và thêm hướng dẫn A3, không tự merge/cherry-pick.
- Working tree ban đầu sạch; cuối lượt có các thay đổi A3 chưa stage/commit. `git diff --check` PASS.
- Không commit, push, merge, reset, stash, clean hoặc init Git. Không sửa repository `gms-voucher-research-demo`; mọi file ghi nằm trong sandbox.

## 3. Modules thêm/sửa

| File | Vai trò |
|---|---|
| `backend/app/booking.py` | Models, demand, OSRM Table/nearest, dispatch engine, plan validation |
| `backend/app/main.py` | Endpoint prepare; reuse route helper với cùng guards A1 |
| `frontend/src/lib/booking.ts` | Typed plan và pure projection/metrics/validation |
| `frontend/src/lib/use-booking.ts` | Prepare request, abort/stale guards, reuse FleetClock |
| `frontend/src/components/booking-panel.tsx` | Config, playback, bookings, fleet, metrics, timeline |
| `frontend/src/components/booking-map.tsx` | Xe, pickup/dropoff, selected legs và focus |
| `frontend/src/App.tsx`, `App.css`, `components/sandbox-map.tsx` | Mode thứ ba và cleanup; giữ một map chính |
| `tests/test_a3.py`, `frontend/tests/booking.test.tsx`, `frontend/tests/dashboard.test.tsx` | Unit/integration/regression |
| `scripts/audit_bookings.py`, `scripts/audit_booking_positions.py` | Audit API thật và independent projection |
| `README.md`, `docs/A3-report.md`, `docs/evidence/a3/` | Hướng dẫn và bằng chứng |

Không thêm dependency. FleetClock, Single Trip RouteProgress/RouteMarker, A2 fleet engine, GIS pipeline và artifact không bị viết lại.

## 4. Data model và demand

`PrepareRequest`: seed 1–80 ký tự, fleetSize 1–10 (default 5), bookingCount 10–30 (default 20), horizonSeconds 60–3600 (default 1800), maxWaitSeconds 10–900 (default 300), preset Low/Medium/High. Pydantic từ chối extra fields/config ngoài bounds.

- `DemandBooking`: ID, SIM passenger ID, request time, pickup/dropoff và candidate IDs; không chứa dispatch outcome.
- `InitialVehicle`: ID, candidate ID, initial position được OSRM nearest xác minh.
- `Assignment`: vehicle/booking IDs, assigned/pickup/dropoff times, Table ETA, route-confirmed ETA, full pickup/trip routes và các ETA candidate được xét.
- `SimulationEvent`: ID, timestamp, type, booking/vehicle reference, validated payload.
- `ScenarioPlan`: config, demand, initial vehicles, assignments, events, duration, seed, fingerprint, provenance, assumptions, versions, routing counters và preparation time.
- Frontend projected state: booking `scheduled → waiting → assigned → picked_up → completed`, hoặc `waiting → unserved`; vehicle `idle → en_route_to_pickup → on_trip → idle`.

Candidate lấy từ catalog OSM A2, deduplicate tọa độ và giữ trong vùng sampling `[106.685,10.759,106.715,10.786]`. Candidate chưa được coi là car-accessible trước khi OSRM kiểm tra. Không sửa catalog/bbox.

Generator `demand-v1` dùng SHA-256 counter draws theo seed/fingerprint; không dùng Math.random. Pickup và dropoff khác tọa độ. Low trải request theo slot có jitter; Medium uniform seeded arrivals; High uniform trong ¼ đầu horizon. Preset không đổi số booking; booking đầu tiên ở t=0 để demo. Cùng config/seed/catalog tạo cùng demand và lịch ban đầu; đổi maxWait không thay demand. Geometry/outcomes không được hứa bất biến nếu dataset/profile/router thay đổi.

## 5. Dispatch và event architecture

Backend precompute toàn bộ plan trước Play. Một preparation dùng HTTP client local chung, route/Table cache trong plan và routing tuần tự; endpoint semaphore giới hạn tối đa hai preparations. Không gọi routing theo animation frame. Hủy request được kiểm tra giữa event/booking; timeout mỗi OSRM call theo cấu hình A1.

Ở timestamp kế tiếp: giải phóng xe hoàn tất trước, xử lý arrivals/requests, dispatch FIFO theo `(requestTime,bookingId)`, rồi deadline. Event log được chuẩn hóa thứ tự cùng timestamp: **TRIP_COMPLETED → BOOKING_REQUESTED → BOOKING_ASSIGNED → VEHICLE_ARRIVED_PICKUP → TRIP_STARTED → BOOKING_UNSERVED**, sau đó booking ID/event ID. Tests kiểm tra release-before-request/deadline và stationary pickup cùng timestamp.

Với từng booking đang chờ: xác minh trip route, lấy Table ETA từ các xe idle tới snapped pickup, bỏ null/unreachable và ETA vượt deadline, chọn ETA nhỏ nhất, tie theo vehicle ID. Xác minh full pickup route trước atomic assignment; nếu leg lỗi có thể xét candidate kế tiếp. Không gán xe busy/hai booking đồng thời. Thời hạn tính **đến lúc đón thực sự dự kiến**, không chỉ assignment: `pickupAt − requestTime ≤ maxWait`, inclusive.

Table dùng `annotations=duration`, sources/destination rõ ràng, radiuses 100 m, không fallback_speed. Route dùng A1 `geometries=geojson&overview=full`, giữ snap/metrics/geometry/local URL guards. A3 thêm display coverage và continuity giữa các leg ≤1 m. OSRM/response/timeout lỗi global khiến preparation thất bại có cấu trúc; invalid/unreachable booking được unserved tại deadline với failureReason, không route thẳng hoặc retry bằng public API.

Nếu xe đã tại snapped pickup trong 0.1 m: `pickupRoute=null`, duration/distance pickup=0; ghi arrival/trip start ngay, không tạo geometry giả. Tất cả trip routes vẫn là OSRM thật. Sau completion xe idle tại snapped dropoff, có thể nhận booking tiếp theo.

## 6. API và OSRM thực tế

Endpoint mới: `POST /api/booking-simulation/prepare`. JSON `{}` sử dụng defaults. Trả typed immutable-in-use plan sau lifecycle validation. Config lỗi: `INVALID_SCENARIO_CONFIG`; readiness/router errors giữ structured code. Client không gửi router URL.

API cũ `health`, `dataset/status`, candidates, map layers và `/api/route` giữ contract. [API responses](evidence/a3/api-responses.json) ghi health, dataset ready và route Single Trip thật. [Plan default](evidence/a3/scenario-5-20.json), [plan stress](evidence/a3/scenario-10-30.json), [summary audit](evidence/a3/real-integration-summary.json).

Docker 29.6.2 Linux, container `gsm-map-osrm` running, bind `127.0.0.1:5000`. Image `ghcr.io/project-osrm/osrm-backend:v5.27.1`, digest `sha256:855614a38f464b0558a2ad6eaa7cb8c139f39887da9b38b485ce453c6e6e6124`, car profile/MLD. Backend `127.0.0.1:8000`, frontend `127.0.0.1:5173`. Không preprocess lại.

Display bbox `[106.675,10.750,106.725,10.795]`; routing bbox `[106.660,10.735,106.740,10.810]`. Provenance chứa extract/streets/profile hash, image digest, algorithm, local URL, snap limit, sampling/display bbox và candidate version 2.

| Scenario thực | Assigned/completed | Unserved | Events | Duration (s) | Prepare (ms) | Nearest / Table / Route calls |
|---|---:|---:|---:|---:|---:|---|
| Default 5/20 | 15 | 5 | 85 | 2092.397 | 2434 | 5 / 36 / 33 |
| Cùng default chạy lại | 15 | 5 | 85 | 2092.397 | 3145 | 5 / 36 / 33 |
| Stress 10/30 | 28 | 2 | 144 | 2092.397 | 5277 | 10 / 49 / 53 |
| 1/30, High, horizon60, wait10 | 1 | 29 | 63 | 148.954 | 954 | 1 / 7 / 8 |

Các phép đo trên chạy cùng regression/browser QA; thời gian phụ thuộc máy/tải. Trong browser stress 10/30 lần riêng preparation khoảng 2.21 s. Default có 59 route-cache/43 Table-cache hits; stress có 50/30. Audit kiểm tra unique IDs, full geometries, snaps, coverage, min eligible ETA/tie, non-overlap, deadlines và terminal counts. Repeat giữ nguyên ID/demand/initial vehicles/assignments/event log; createdAt/preparation time không thuộc deterministic identity.

Ví dụ default BK-001: GSM-02, assigned 0 s, Table ETA/full pickup duration 267.4 s, trip duration 399.6 s, dropoff 667.0 s. Browser Seek tại pickup/trip/completion và ngược về 0 xác nhận đúng lifecycle. Không dùng mock để chứng minh các kết quả này.

## 7. Replay, UI và metrics

Reuse FleetClock một RAF và absolute simulation time. Pure projection đọc plan/event log tại t, không tích lũy state từ frame cũ. Vehicle đi theo khoảng cách dọc full OSRM polyline; heading reuse tangent helper A2. Pause đứng yên; Seek ngược bỏ sự kiện tương lai; Reset t=0 (booking đầu tiên đã được yêu cầu/assigned tại t=0); completed dừng clock. Play/Pause/Seek/Reset/Speed không gọi OSRM. Regenerate/mode switch abort request cũ và dispose/reset clock; response cũ không ghi đè plan mới.

Map giữ một canvas/instance, tối đa 10 xe và 8 active pickup markers cộng booking selected. Chỉ vẽ hai leg của booking/xe chọn; future bookings không tự render pickup. Có focus xe, fit booking/vùng scenario, selected details, filtered booking list và 16 events gần nhất. Hai mode A1/A2 vẫn giữ tương tác cũ. Desktop 1440×1080, mobile 390×844 đã kiểm tra; mobile clientWidth=scrollWidth=375 (15 px scrollbar), không overflow ngang.

Metrics **Observed** tại t; **Planned** là projection tại cuối plan:

| Metric | Định nghĩa |
|---|---|
| Requested / Assigned / Completed / Unserved | Số booking đã tới event tương ứng tại t; Assigned là đã từng assigned |
| Service rate | Bookings đã picked up / bookings đã requested |
| Completion rate | Bookings completed / bookings đã requested |
| Average waiting (s) | pickupAt − requestTime, chỉ bookings đã picked up |
| Average passenger trip (s) | OSRM trip duration, chỉ trips completed |
| Average pickup ETA (s) | Full-route estimated pickup duration, chỉ bookings đã assigned |
| Empty/occupied distance (m) | Route distance × progress của từng leg tới t |
| Utilization | Tổng busy seconds (pickup+trip) tới t / (fleetSize × t); null tại t=0 |
| Vehicle completed trips | Booking IDs có dropoffAt ≤ t của xe |

Denominator rỗng trả null/“—”. Duration/distance là profile estimates, waiting/utilization là mô phỏng. Không live traffic, dwell, congestion hoặc GPS measurements.

Default tại t=500: requested7/assigned5/completed0, empty11.932 km, occupied5.686 km, utilization61.37%. Cuối default: 15/20 completed (75%), wait TB179.506 s, trip TB237.447 s, pickup ETA TB164.247 s, empty28.999 km, occupied41.416 km, utilization57.59%. [Browser telemetry](evidence/a3/browser-qa.json) lưu cả 5 snapshot; [independent Python audit](evidence/a3/projection-audit.json) xác minh mọi metric và 226 positions với sai số tọa độ dưới 1e-10 độ. Snapshot Seek ban đầu thiếu nhãn planCase đã được gắn bổ sung theo scenario đang chạy; quan sát DOM gốc không bị thay đổi.

## 8. Tests và browser QA

| Check | Kết quả | Bằng chứng/phạm vi |
|---|---|---|
| Baseline backend A2 | PASS | 56, RUN_REAL_DATA=1, không skipped |
| Baseline frontend A2 | PASS | 27; build/typecheck |
| Final backend | PASS | 91, không skipped: 56 cũ + 35 A3 (gồm real integration) |
| Final frontend | PASS | 39: 27 cũ + 12 A3 |
| Final production build/typecheck | PASS | tsc + Vite build |
| Demand/dispatch unit | PASS | seed, bounds/IDs, min ETA/tie, busy/queue/deadline, same timestamp, null Table, invalid routes, timeout/outage, payload/plan/cancellation |
| Replay/hook/UI unit | PASS | deterministic projection, geometry, backward Seek/metrics, stationary leg, controls, stale requests, cleanup, missing readiness |
| OSRM integration | PASS | 4 API prepare runs; assignments/geometry/provenance audit |
| Projection/metrics independent audit | PASS | 36 browser snapshots, 226 vehicles, visible booking histories, 5 metrics |
| A1 browser desktop/mobile | PASS | Click A/B, route, Play/Pause/Seek/Reset/4x; local route ~2.59km/313.6s, snaps52.2/58m |
| A2 browser desktop/mobile | PASS | 5 routes/markers, Play/Pause/Seek/end/Reset; warmed cache không phát route request |
| A3 browser desktop/mobile | PASS | 5/20, 10/30, Play/Pause/Resume/Seek/backward/end/Reset, 1/2/4x, select/focus while playing, pan/zoom |
| Unserved browser | PASS | Scenario riêng 1/30 High/wait10, 29 unserved với PICKUP_WAIT_LIMIT |
| Regenerate/mode cleanup | PASS | Hai seed liên tiếp: plan cuối là seed mới; chỉ marker mode hiện tại |
| Local resource/console audit | PASS | Không external URL quan sát được; warn/error console rỗng |
| Artifact integrity | PASS | 40 entries trước/sau giống bytes/hash |

Không có FAIL/BLOCKED trong core scope. Mocks/fixtures trong unit tests chỉ kiểm tra nhánh lỗi và edge cases, không làm bằng chứng routing thực tế. Real unserved branch được thử riêng thay vì dựa vào random scenario. Backend có một warning deprecation Starlette/httpx TestClient hiện có; không ảnh hưởng PASS. Lint không có errors, còn warnings thuộc pattern hiện có/mapcn/effect; không dành A3 để refactor debt này.

Screenshot desktop/mobile:

- [5 xe, đang đón/chở khách](evidence/a3/desktop-5-20-final.jpg)
- [10 xe playback](evidence/a3/desktop-10-30-playing.jpg)
- [Mobile map 10 xe](evidence/a3/mobile-10-30-map.jpg), [mobile controls](evidence/a3/mobile-10-30-controls.jpg)
- [Unserved mobile](evidence/a3/mobile-unserved.jpg)
- [A1 desktop](evidence/a3/desktop-a1-regression.jpg), [A1 mobile](evidence/a3/mobile-a1-regression.jpg)
- [A2 desktop](evidence/a3/desktop-a2-regression.jpg), [A2 mobile](evidence/a3/mobile-a2-regression.jpg)
- [Pickup](evidence/a3/desktop-5-20-pickup.jpg), [trip start](evidence/a3/desktop-5-20-trip-start.jpg)

## 9. Performance và network

Stress 10 xe: đúng 10 vehicle DOM markers và một map canvas; 1766 RAF samples, mean interval18.06 ms, max gap36.4 ms trong đoạn quan sát. Đây không phải chứng nhận 60 FPS hay benchmark hardware chuẩn. Projection tối đa 30 bookings, chỉ publish clock tối đa30Hz; chưa cần checkpoints/thư viện animation mới.

Clock đo theo DOM timestamp/wall time: 1x=1.0013, 2x=2.0008, 4x=3.9993. Pause giữ nguyên simulation time/tọa độ trong các snapshot; zoom/pan đổi screen transform nhưng không đổi paused coordinates. Các booking controls không phát thêm prepare/route calls; dataset status vẫn poll định kỳ và có thể probe OSRM nearest như A1.

| Bundle Vite (decimal kB) | A2 baseline | A3 | Tăng |
|---|---:|---:|---:|
| JS | 1385.80 | 1407.79 | 21.99 |
| JS gzip | 394.83 | 399.64 | 4.81 |
| CSS | 136.16 | 138.08 | 1.92 |
| CSS gzip | 21.61 | 21.95 | 0.34 |

Plan 10/30 JSON khoảng174.4 kB. Không thêm thư viện/dependency. Browser resource audit [network-resources.json](evidence/a3/network-resources.json) và console ghi **0 external URLs, 0 warn/error** trong lượt QA. Local GeoJSON/font/worker assets kế thừa A1; không CARTO/Mapbox/Overpass/OSM API/public OSRM/CDN fallback. Liên kết attribution/Geofabrik chỉ mở khi người dùng click, không tải ngầm. Resource audit là quan sát browser kết hợp source review, không phải packet capture toàn hệ điều hành hay chứng nhận offline toàn bộ máy.

## 10. Checksum và bảo toàn dữ liệu

Không extraction, preprocessing, download PBF hoặc thay graph/render. [Inventory trước](evidence/a3/integrity-before.json) và [sau](evidence/a3/integrity-after.json) gồm 40 entries, SHA-256 và bytes bằng nhau (3 input PBF + 37 routing/render entries, có .gitkeep).

| PBF | Bytes | SHA-256 trước = sau |
|---|---:|---|
| `data/raw/vietnam-latest.osm.pbf` | 330248138 | `2FBD2EE6B4DC151EECF04FA6823CDDF584B47423E190118B10FCE8B6115E9D8A` |
| `data/processed/hcm-q1.osm.pbf` | 1321521 | `48B3FD8935B55F65D1A7E4296016A62C36D704B77EE1329F2BA0BEB4F978D3DC` |
| `data/extracted/hcm-center.osm.pbf` | 3290221 | `3A939D15AC7B775ABA3F5A0324064CEB3D1B19AB0D176F2B10B94448C36AFDA0` |

## 11. PowerShell chạy/trải nghiệm

Các services đã chạy tại thời điểm bàn giao. Không khởi động thêm nếu port đã occupied. Khi chạy lại, mở Docker Desktop Linux Engine, kiểm tra:

```powershell
Set-Location 'D:\ThS\VinAI\Phase3_VRIC\gsm-map-sandbox'
docker ps --filter name=gsm-map-osrm
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalPort -in 5000,8000,5173 }
```

Nếu container đã có nhưng dừng: `docker start gsm-map-osrm`. Nếu container chưa có nhưng graph A1 còn hợp lệ:

```powershell
.\.venv\Scripts\python.exe scripts\pipeline.py serve --detach
```

Chỉ chạy các lệnh dưới ở port chưa có service, hai terminal riêng:

```powershell
Set-Location 'D:\ThS\VinAI\Phase3_VRIC\gsm-map-sandbox'
.\.venv\Scripts\python.exe -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8000 --reload --reload-dir backend
```

```powershell
Set-Location 'D:\ThS\VinAI\Phase3_VRIC\gsm-map-sandbox\frontend'
npm.cmd run dev
```

Mở http://127.0.0.1:5173 → Booking & Dispatch → Generate Booking Scenario → Play. Seek 267.4/667/500/1000 s để xem lifecycle/metrics; thử Pause/Resume/Reset/1x2x4x, chọn booking/xe và fit. Stress:10 xe30 bookings. Unserved:1 xe30 bookings, High, horizon60, wait10. API docs http://127.0.0.1:8000/docs.

Không còn thao tác hệ thống thủ công bắt buộc tại bàn giao. Nếu máy khởi động lại cần start Docker/services; không chạy pipeline extract/display/routing lại theo mặc định. Các lệnh regression/audit trong README. Test fixtures là synthetic-labelled, artifacts địa lý thật không bị ghi đè.

## 12. Hạn chế/technical debt

FIFO + minimum ETA là greedy policy, không fleet optimization. Constant distance progress theo OSRM duration; không dwell, traffic, acceleration, cancellation, pooling hoặc passenger behavior. Waiting không vô hạn và assignment phải đáp ứng pickup deadline.

Preparation không lưu DB/background jobs; cache chỉ trong plan, JSON nằm trong browser session. UI loading tổng thể, chưa progress từng booking. Một xe đã ở pickup dùng stationary leg hợp lệ; không nhất thiết có geometry pickup cho trường hợp đó. Markers xe idle cùng dropoff có thể trùng hình trên map, danh sách vẫn đủ IDs. Event panel chỉ 16 events gần nhất, full event log trong plan.

Giới hạn A1 về OSM turn restrictions/connectivity tiếp tục áp dụng. Stress kiểm tra 10/30 và mẫu seeds, không chứng nhận mọi OSM candidate/scenario. Local resource audit giới hạn ở lượt kiểm chứng; port loopback/local URL guards không thay đổi.

Không voucher, baseline/treatment comparison, passenger/GPS thực tế, authentication, database, cloud hoặc tích hợp repository GSM chính. **Kết thúc A3 và dừng; chưa commit/push/merge.**
