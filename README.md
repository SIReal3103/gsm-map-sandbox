# GSM Map Sandbox

PoC bản đồ TP.HCM dùng dữ liệu OpenStreetMap cục bộ, OSRM để tìm đường ô tô và mô phỏng một hành trình hoặc đội xe nhỏ.

## Chạy trên Windows

Cần Python 3.11+, Node.js 20.19+ hoặc 22.12+, Docker Desktop chạy Linux Engine. Chuẩn bị hai PBF đầu vào tại `data/raw/vietnam-latest.osm.pbf` và `data/processed/hcm-q1.osm.pbf`; dữ liệu bản đồ và graph không được tải kèm repo.

Cài dependencies từ thư mục repo:

```powershell
if (-not (Test-Path .venv)) { py -3.11 -m venv .venv }
.\.venv\Scripts\python.exe -m pip install -r backend\requirements.lock.txt
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
Set-Location frontend
npm.cmd ci
Set-Location ..
```

Lần đầu, tạo dữ liệu bản đồ và router (cần Docker Linux Engine):

```powershell
docker pull iboates/osmium:1.19.0
docker pull ghcr.io/project-osrm/osrm-backend:v5.27.1
.\.venv\Scripts\python.exe scripts\pipeline.py verify
.\.venv\Scripts\python.exe scripts\pipeline.py extract
.\.venv\Scripts\python.exe scripts\pipeline.py display
.\.venv\Scripts\python.exe scripts\pipeline.py routing
.\.venv\Scripts\python.exe scripts\pipeline.py serve --detach
```

Sau đó mở hai terminal tại thư mục repo:

```powershell
.\.venv\Scripts\python.exe -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8000 --reload --reload-dir backend
```

```powershell
Set-Location frontend
npm.cmd run dev
```

Mở ứng dụng tại <http://127.0.0.1:5173>; API docs tại <http://127.0.0.1:8000/docs>. Nếu graph và dữ liệu đã được tạo, bỏ qua bước pipeline và chỉ chạy `serve --detach`.

## A2 — Fleet Simulation

Single Trip giữ click A/B và RouteProgress của A1. Chọn tab **Fleet Simulation**, giữ mặc định **5 xe**, seed `hcm-fleet-2026`, rồi bấm **Generate Scenario**. Hỗ trợ 1–10 xe; chỉ bật Play sau khi có route hợp lệ từ OSRM local. Có thể dùng seed mới để đổi kịch bản.

Candidate lấy từ các vertex đường OSM thật trong vùng trung tâm của display bbox. OSRM vẫn phải xác nhận snapping và route. Seed/fingerprint quyết định cặp điểm cùng departure offsets; geometry có thể thay đổi khi dataset/profile thay đổi. Route lỗi bị loại và được liệt kê, không có tuyến thay thế giả. Tối đa 2 route requests đồng thời; cache trong phiên giới hạn 100 routes và tách theo dataset/routing fingerprint.

Play/Pause/Resume/Reset, thanh Fleet Timeline và 1x/2x/4x dùng chung một clock. Seek sẽ pause. Chọn xe qua marker hoặc danh sách; Focus xe / Fit tuyến không reset thời gian. Đổi mode sẽ xóa scenario/trip cũ và hủy request đang chờ. **Simulated fleet — not live GPS**: khoảng cách đã đi là phép chiếu tiến độ trên geometry; duration là OSRM car-profile estimate, không phải giao thông thực tế.

Fleet Panel có thống kê scheduled/moving/completed, planned/traveled distance, danh sách xe, snapping và provenance. Mục hiệu năng playback ghi RAF samples/mean/max gap; không chứng nhận 60 FPS. Marker có thể chồng khi xe gần nhau; dùng danh sách để chọn chính xác xe.

API bổ sung: `GET /api/fleet/candidates` cung cấp candidate OSM và fingerprint; mọi tuyến vẫn qua `POST /api/route` của A1. Không batch routing endpoint mới, không database, không external fallback. Readiness poll 10 giây của A1 vẫn hoạt động; playback controls không gửi route request.

## Kiểm thử A2

Không cần chạy lại extraction/preprocessing nếu artifact A1 hợp lệ. Kiểm tra port trước khi khởi động process mới:

```powershell
Set-Location 'D:\ThS\VinAI\Phase3_VRIC\gsm-map-sandbox'
Get-NetTCPConnection -State Listen -LocalPort 5000,8000,5173 -ErrorAction SilentlyContinue
$env:RUN_REAL_DATA='1'
.\.venv\Scripts\python.exe -m pytest -q --basetemp=data/processed/pytest-a2-user-temp
Remove-Item Env:\RUN_REAL_DATA
Set-Location frontend
npm.cmd test
npm.cmd run build
# Audit real fleet: Node 22.18+ hoặc Node 24, backend + OSRM đang chạy.
node scripts/audit-fleet.mjs
Set-Location ..
```

Audit tạo lại bằng chứng integration trong `docs/evidence/a2/`, không sửa PBF/graph. `scripts/audit_fleet_positions.py` kiểm tra telemetry browser đã lưu; không tự chạy browser. [Báo cáo A2](docs/A2-report.md) ghi kết quả desktop/mobile, checksum, bundle và performance. Giữ các giới hạn mạng đường/turn restrictions được nêu trong [báo cáo A1](docs/A1-report.md).
