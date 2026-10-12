# GSM Map Sandbox

PoC bản đồ TP.HCM dùng dữ liệu OpenStreetMap cục bộ và OSRM local: một hành trình, đội xe nhỏ, booking/điều phối xe và paired voucher experiments. Giá cước, phản ứng giá và voucher là giả định nghiên cứu, chưa hiệu chỉnh từ dữ liệu kinh doanh GSM.

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

## Trải nghiệm Booking & Dispatch (A3)

Chọn tab **Booking & Dispatch**, giữ mặc định **5 xe / 20 bookings**, seed `hcm-booking-2026`, rồi bấm **Generate Booking Scenario**. Backend chuẩn bị các quyết định điều phối và tuyến đón/chở khách bằng OSRM local trước khi mở Play. Xe được chọn theo ETA, không theo khoảng cách đường thẳng.

Dùng Play/Pause/Resume, slider hoặc **Seek (s)**, Reset và 1x/2x/4x. Chọn booking hoặc xe để focus; **Fit vùng scenario** đưa bản đồ về vùng demo. Playback/Seek không tính lại routing. Hai tab Single Trip và Fleet Simulation vẫn hoạt động.

Low trải request đều có jitter; Medium sinh thời điểm đều theo seed; High dồn request trong ¼ đầu horizon. Mặc định horizon 1800 s, giới hạn chờ **tới lúc được đón** 300 s. Tối đa 10 xe / 30 bookings. Để thử unserved: 1 xe, 30 bookings, High, horizon 60 s, max wait 10 s.

Metrics **Observed** chỉ tính đến simulation time; **Planned** tính toàn scenario. Đây là demand/dispatch mô phỏng, không phải dữ liệu hành khách hoặc GPS GSM thực tế; thời gian chạy là ước tính profile OSRM, không live traffic.

API mới: `POST /api/booking-simulation/prepare`. Chi tiết model, chính sách, giới hạn và bằng chứng: [báo cáo A3](docs/A3-report.md).

Kiểm thử và audit (giữ nguyên PBF/graph, không preprocess):

```powershell
$env:RUN_REAL_DATA='1'
.\.venv\Scripts\python.exe -m pytest -q --basetemp=data/processed/pytest-a3-manual
Remove-Item Env:\RUN_REAL_DATA
.\.venv\Scripts\python.exe scripts\audit_bookings.py
# Cần browser-qa.json đã ghi từ browser QA để chạy audit vị trí:
.\.venv\Scripts\python.exe scripts\audit_booking_positions.py
Set-Location frontend
npm.cmd test
npm.cmd run build
```

## Trải nghiệm Voucher Experiment Studio (A4)

Giữ nguyên ba tab A1–A3. Nút **Voucher Experiment Studio** đứng riêng dưới divider mở workspace A4 trong cùng bản đồ.

Với artifact A1 đã có, **không chạy lại extract/display/routing**. Từ PowerShell tại project root, kiểm tra process/port trước khi mở thêm terminal:

```powershell
Set-Location 'D:\ThS\VinAI\Phase3_VRIC\gsm-map-sandbox'
docker ps --filter name=gsm-map-osrm
Get-NetTCPConnection -State Listen -LocalPort 5000,8000,5173 -ErrorAction SilentlyContinue
# Nếu router đã tồn tại nhưng stopped:
docker start gsm-map-osrm
# Nếu chưa có container, dùng graph hiện có:
# .\.venv\Scripts\python.exe scripts\pipeline.py serve --detach
```

Backend (terminal 1, nếu port 8000 chưa có listener):

```powershell
.\.venv\Scripts\python.exe -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8000 --reload --reload-dir backend
```

Frontend (terminal 2):

```powershell
Set-Location 'D:\ThS\VinAI\Phase3_VRIC\gsm-map-sandbox\frontend'
npm.cmd ci
npm.cmd run dev
```

Mở <http://127.0.0.1:5173>, chọn Studio, bấm **Prepare Experiment** với mặc định 5 xe / 30 potential trips. Backend quote các tuyến thật, rồi xử lý hai arms bằng cùng A3 dispatcher. Giá mặc định: 10.000 VND + 12.000 VND/km OSRM; sigmoid alpha 1,5, beta 2, reference fare 50.000 VND; voucher fixed 20.000 VND, budget 200.000 VND. Cấu hình nâng cao chứa fare/behavior/minimum fare/cap/max wait. Percentage mặc định 30%, cap 25.000 VND.

Play/Pause/Resume/Reset/Seek và 1x/2x/4x dùng một clock. Đổi Baseline/Treatment giữ timestamp, chỉ đổi arm được render. **Observed** xem KPI đến thời điểm hiện tại; **Planned / Final** xem toàn experiment, không Seek bản đồ. Hai chart mặc định là conversion funnel và completed trips. Bấm **Phân tích kinh doanh nâng cao** để tải thêm charts; đóng analytics giữ nguyên clock.

JSON chứa toàn config, potential/draws, hai plans, decisions, ledger, KPI, events và provenance. CSV gồm summary, decisions, bookings, ledger, series, UTF-8 BOM/CRLF để mở Excel. Exports luôn là final/full-history của experiment đã chuẩn bị, không phải snapshot Observed.

Các thử nghiệm dễ trình diễn:

- Zero control: fixed discount = 0 (hai arms tương đương, spend = 0).
- Exhaustion: budget = 20.000 VND (chỉ giữ voucher khi đủ toàn bộ mức giảm).
- Capacity: 1 xe, High, horizon = 60 s, max pickup wait = 60 s, budget = 1.000.000 VND. Có unserved/release; accepted tăng nhưng completed không tăng.
- Stress: 10 xe / 30 potential trips.

Không gọi OSRM trong playback/export. Không có public routing/map fallback. GFV là tổng fare giả định của chuyến hoàn tất; **không phải profit**. Cost/incremental completion hiển thị N/A nếu increment ≤ 0. Báo cáo đầy đủ công thức, tham số, QA và bằng chứng: [A4 report](docs/A4-report.md).

Kiểm thử A4 (không preprocess, có router local):

```powershell
Set-Location 'D:\ThS\VinAI\Phase3_VRIC\gsm-map-sandbox'
$env:RUN_REAL_DATA='1'
.\.venv\Scripts\python.exe -m pytest -q --basetemp=data/processed/pytest-a4-manual
Remove-Item Env:\RUN_REAL_DATA
.\.venv\Scripts\python.exe scripts\audit_voucher.py
# Audit browser evidence đã lưu; không thay thế thao tác QA browser thật:
.\.venv\Scripts\python.exe scripts\audit_voucher_browser.py
Set-Location frontend
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
```
