# GSM Map Sandbox

PoC bản đồ TP.HCM dùng dữ liệu OpenStreetMap cục bộ, OSRM để tìm đường ô tô và mô phỏng hành trình của một xe.

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
