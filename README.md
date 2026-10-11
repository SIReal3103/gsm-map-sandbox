# GSM Map Sandbox

PoC local độc lập cho **một xe mô phỏng** trên đường phố OpenStreetMap thật ở trung tâm TP.HCM. React/mapcn/MapLibre hiển thị GeoJSON local; FastAPI gọi OSRM local, profile ô tô MLD. Không dùng GPS GSM, giao thông live, public routing/basemap, database hoặc repository GSM chính.

**A1 đã được kiểm chứng bằng dữ liệu thật và browser WebGL desktop/mobile. GO A2 trong phạm vi PoC; chưa triển khai A2.** Xem [báo cáo A1](docs/A1-report.md) và [báo cáo A0 lịch sử](docs/A0-report.md). Bằng chứng trong báo cáo thuộc lần chạy 2026-10-11; kiểm tra lại runtime khi mở ứng dụng.

## Windows / PowerShell

Python 3.11+, Node tương thích Vite 8 (20.19+ hoặc 22.12+); đã dùng Python 3.11.9 / Node 24.18.0. Docker Desktop cần Linux Engine. Không cần Osmium trong Windows PATH hoặc quyền admin cho package dự án.

Thiết lập khi chuyển sang máy mới; không ghi đè `.env` đang có:

```powershell
Set-Location 'D:\ThS\VinAI\Phase3_VRIC\gsm-map-sandbox'
if (-not (Test-Path -LiteralPath .venv)) { py -3.11 -m venv .venv }
.\.venv\Scripts\python.exe -m pip install -r backend\requirements.lock.txt
if (-not (Test-Path -LiteralPath .env)) { Copy-Item -LiteralPath .env.example -Destination .env }
Set-Location frontend
npm.cmd ci
```

Dùng Python trực tiếp, không cần activate `.venv` hoặc sửa execution policy. `npm.cmd` tránh trường hợp `npm.ps1` bị chặn.

Khởi động router từ graph đã có, không preprocess lại mỗi lần:

```powershell
Set-Location 'D:\ThS\VinAI\Phase3_VRIC\gsm-map-sandbox'
docker version
docker info --format '{{.OSType}}'   # linux
.\.venv\Scripts\python.exe scripts\pipeline.py serve --detach
```

Backend — terminal riêng:

```powershell
Set-Location 'D:\ThS\VinAI\Phase3_VRIC\gsm-map-sandbox'
.\.venv\Scripts\python.exe -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8000 --reload --reload-dir backend
# Hoặc: .\scripts\start-backend.ps1 -Reload
```

Frontend — terminal riêng:

```powershell
Set-Location 'D:\ThS\VinAI\Phase3_VRIC\gsm-map-sandbox\frontend'
npm.cmd run dev
# Hoặc từ project root: .\scripts\start-frontend.ps1
```

Mở [ứng dụng](http://127.0.0.1:5173) / [Swagger](http://127.0.0.1:8000/docs). Các port bind loopback; Vite proxy `/api` sang FastAPI. Nếu sandbox đang chiếm port, dùng phiên đang chạy. `serve` tái sử dụng container cùng cấu hình. Ctrl+C dừng terminal; `docker stop gsm-map-osrm` dừng router `--rm`, giữ graph trên ổ đĩa.

## Sử dụng

Nhấp A rồi B trên bản đồ; chờ tuyến ô tô mới. Mở **Điểm trên đường đã snap** để xem tên/toạ độ. A/B là vị trí nhấp; xe bắt đầu/kết thúc tại điểm trên đường đã snap. Tuyến xanh lam là phần còn lại; xanh lá là phần đã đi.

Play, Pause, Play để tiếp tục; kéo Route Progress hoặc dùng phím mũi tên/Home/End để seek. Chọn 1x/2x/4x. Reset về 0%; tới B tự completed. Nhấp lại bắt đầu A mới hoặc Xóa điểm A/B: tuyến/playback cũ được reset, response cũ bị bỏ qua, chỉ có một xe.

Animation dựa trên duration OSRM và chiều dài cộng dồn của **full route geometry**, không phải tốc độ từng đoạn, GPS hoặc giao thông thực tế. Không sinh đường thẳng fallback. `NOSEGMENT` thường có nghĩa điểm quá xa đường ô tô trong ngưỡng snap 100 m.

## Cấu hình và dữ liệu

Hai input được bảo vệ:

```text
data/raw/vietnam-latest.osm.pbf       # Geofabrik, người dùng cung cấp
data/processed/hcm-q1.osm.pbf         # complete_ways thủ công, giữ nguyên
```

Manual extract không bao phủ display bbox và thiếu 14 way member của restriction. A1 tạo **file mới** `data/extracted/hcm-center.osm.pbf`. Display bbox `[106.675,10.750,106.725,10.795]`; routing bbox `[106.660,10.735,106.740,10.810]`, buffer 0.015° mỗi phía. Đây là vùng kỹ thuật, không phải ranh giới hành chính.

`.env` đọc từ project root; PBF path tương đối resolve theo project root, không phụ thuộc cwd:

```dotenv
OSM_PBF_PATH=data/raw/vietnam-latest.osm.pbf
REGION_CONFIG_PATH=config/region.json
OSRM_BASE_URL=http://127.0.0.1:5000
OSRM_TIMEOUT_SECONDS=3
MAX_SNAP_METERS=100
OSRM_IMAGE=ghcr.io/project-osrm/osrm-backend:v5.27.1
OSMIUM_IMAGE=iboates/osmium:1.19.0
```

Backend chỉ đọc nguồn được cấu hình và artifact cố định. Docker pipeline hiện yêu cầu input trong project root để mount readonly có kiểm soát. Không upload, không nhận URL/path tùy ý từ client. OSRM URL chỉ HTTP loopback. Thiếu PBF không làm backend crash; thiếu artifact/router thì controls khóa.

Full `osmium fileinfo -e` được cache ở `data/processed/source-verification.json` theo path/size/mtime. Polling không hash lại file 330 MB; cache không thay thế checksum audit trước/sau. Dataset phân biệt `graph_built` và `graph_ready`; graph_ready cần router phản hồi.

## Pipeline tái tạo

Không tải lại Geofabrik. Trên máy mới, người dùng tự bổ sung input và lưu checksum. Docker Linux Engine cần đủ RAM/đĩa; extraction cap 5 GiB / 4 CPU, OSRM preprocess cap 2 GiB / 4 CPU. Nếu Engine chưa chạy, mở Docker Desktop rồi kiểm tra lại; không tự sửa WSL2/BIOS/settings hoặc cài hệ thống bằng admin.

```powershell
Set-Location 'D:\ThS\VinAI\Phase3_VRIC\gsm-map-sandbox'
docker info --format '{{.OSType}}'
docker pull iboates/osmium:1.19.0
docker pull ghcr.io/project-osrm/osrm-backend:v5.27.1
docker run --rm iboates/osmium:1.19.0 --version
.\.venv\Scripts\python.exe scripts\pipeline.py verify
.\.venv\Scripts\python.exe scripts\pipeline.py extract
.\.venv\Scripts\python.exe scripts\pipeline.py display
.\.venv\Scripts\python.exe scripts\pipeline.py routing
.\.venv\Scripts\python.exe scripts\pipeline.py serve --detach
```

Mỗi action có `--dry-run`, `--pbf`, `--region-config`. Input readonly, chỉ output directory được ghi. Extraction dùng `smart -S types=multipolygon,restriction` với buffer. `check-refs` kiểm tra node của way; XML audit do Osmium xuất kiểm tra restriction members. Không lọc đường nhỏ/không tên khỏi routing input. Working copy là `data/routing/hcm-center.osm.pbf`, không preprocess trực tiếp hai PBF bảo vệ.

OSRM: `osrm-extract -p /opt/car.lua` → `osrm-partition` → `osrm-customize` → `osrm-routed --algorithm mld`. Manifest lưu image tag/digest, profile hash, input hash, bbox, version và kích thước artifacts. `.incomplete` chặn serving khi preprocess dở dang. Output hợp lệ khớp provenance được tái sử dụng; output thiếu/dở dang/lệch cấu hình bị từ chối, không tự cleanup/overwrite. Muốn làm lại, xem log và tự sao lưu output sinh ra; không đụng raw/manual PBF. Đổi vùng cần bộ artifact phù hợp mới.

Renderer giảm thuộc tính, chọn feature theo display bbox + 0.005°, tách line/polygon/point vào streets/water/green/buildings/places. Khoảng 7.89 MiB GeoJSON, chưa cần PMTiles. Renderer không sửa routing input hoặc simplify full route. Font Geist, worker/shared module, style và map sources đều local. CSP chỉ cho cùng origin và WebSocket Vite loopback; link attribution/Geofabrik chỉ mở khi người dùng nhấp.

## API

| Endpoint | Kết quả |
|---|---|
| `GET /api/health` | Backend readiness, không phải bằng chứng graph/map ready |
| `GET /api/dataset/status` | PBF verification, artifact manifests, graph_built/graph_ready, OSRM probe |
| `GET /api/map/streets` | GeoJSON đường, giữ endpoint A0 |
| `GET /api/map/{water,green,buildings,places}` | Allowlist lớp local |
| `POST /api/route` | `{start:[lon,lat],end:[lon,lat]}` → coordinates/distance/duration/snap_points |

OSRM dùng `geometries=geojson&overview=full&radiuses=100;100`. Kiểm tra WGS84/bbox, LineString ≥2 điểm khác nhau, metrics dương, snap distance và geometry endpoint khớp snap. Structured error `{error:{code,message}}`: `DATASET_NOT_READY`, `ROUTER_UNAVAILABLE`, `ROUTER_TIMEOUT`, `ROUTER_BAD_RESPONSE`, `NOSEGMENT`, `NOROUTE`, `SNAP_TOO_FAR`, `OUTSIDE_ROUTING_REGION`, `ROUTE_OUTSIDE_REGION`, `INVALID_COORDINATES`. Không fallback.

## Kiểm thử

```powershell
Set-Location 'D:\ThS\VinAI\Phase3_VRIC\gsm-map-sandbox'
.\.venv\Scripts\python.exe -m pytest -q --basetemp=data/processed/pytest-a1-temp
# 51 contract tests; 2 integration tests skip khi chưa opt-in.
$env:RUN_REAL_DATA = '1'
.\.venv\Scripts\python.exe -m pytest -q --basetemp=data/processed/pytest-a1-temp
# 53 tests: real GeoJSON/checksum/local OSRM; cần router chạy.
Remove-Item Env:\RUN_REAL_DATA
.\.venv\Scripts\python.exe scripts\audit_dataset.py
Set-Location frontend
npm.cmd run test
npm.cmd run build
```

`pytest-a1-temp` dành riêng cho disposable test fixtures; không đặt dữ liệu người dùng vào đó. Fixture không phải tuyến/map thật. Browser WebGL QA ghi riêng trong báo cáo, không dùng jsdom làm bằng chứng render. Unit NoRoute/timeout/malformed dùng mock; route success và NoSegment đã chạy thật. Audit: 9 điểm nearest, 81/81 kết nối, 53 cạnh một chiều trên tuyến smoke, 10 node-via restriction thật. Không chứng nhận toàn bộ mạng/restriction/conditional/via-way.

## Cấu trúc

```text
frontend/src/components/      Dashboard, mapcn, MapLibre, shadcn
frontend/src/lib/             API, local style, playback
backend/app/                 Settings, dataset, schema, REST API
scripts/pipeline.py          Pipeline Docker được hoàn thiện từ A0
scripts/render_data.py       Validate/reduce export của Osmium
scripts/audit_dataset.py     Real coverage/refs/connectivity/oneway/restriction audit
config/region.json           Display bbox và buffer
data/raw/                    PBF nguồn bảo vệ
data/extracted/              Extract mới + metadata
data/processed/render/       Các lớp map + manifest
data/processed/graph-audit/  XML/filtered PBF audit
data/routing/                Working PBF, MLD graph + manifest
tests/                       Contract + integration opt-in
docs/evidence/a1/            Log, JSON và ảnh thực thi
docs/A1-report.md             Bàn giao A1
```

PBF/GeoJSON/OSRM sinh ra, virtualenv, node_modules, build/cache/log và `.env` được ignore. Không commit dữ liệu lớn. Không tạo nested Git repo, không Git mutation ở root cha `D:\ThS\VinAI`; không sửa `gms-voucher-research-demo`.

Attribution **© OpenStreetMap contributors**, Geofabrik Vietnam; timestamp `2026-10-09T20:21:04Z`. Khi chia sẻ artifact dẫn xuất, giữ provenance/attribution và kiểm tra giấy phép theo [OpenStreetMap copyright](https://www.openstreetmap.org/copyright).

Tài liệu chính thức đã đối chiếu với package thực tế: [mapcn routes](https://mapcn.vercel.app/docs/routes), [Osmium extract](https://docs.osmcode.org/osmium/latest/osmium-extract.html), [OSRM Backend](https://github.com/Project-OSRM/osrm-backend), [MapLibre font-faces](https://maplibre.org/maplibre-style-spec/font-faces/).
#   g s m - m a p - s a n d b o x  
 