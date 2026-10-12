# GSM Map Sandbox

PoC bản đồ TP.HCM dùng dữ liệu OpenStreetMap cục bộ và OSRM local: một hành trình, đội xe nhỏ hoặc mô phỏng booking/điều phối xe.

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
