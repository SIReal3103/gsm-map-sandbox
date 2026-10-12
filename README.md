# GSM Map Sandbox

PoC mô phỏng hành trình, đội xe và voucher trên bản đồ OSM thật tại trung tâm TP.HCM, dùng OSRM chạy local. Booking, giá cước và voucher là giả định nghiên cứu, không phải dữ liệu vận hành hay GPS thực tế của GSM.

## Chạy ứng dụng Live trên Windows

Cần Python 3.11+, Node.js 20.19+ hoặc 22.12+, và Docker Desktop với Linux Engine. PBF, GeoJSON và graph OSRM không được lưu trong Git; cần có dữ liệu và artifact đã chuẩn bị theo [báo cáo A1](docs/A1-report.md). Không chạy lại pipeline dữ liệu nếu artifact hiện có đã dùng được.

Tại PowerShell, từ project root:

```powershell
if (-not (Test-Path .venv)) { py -3.11 -m venv .venv }
.\.venv\Scripts\python.exe -m pip install -r backend\requirements.lock.txt
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
Set-Location frontend
npm.cmd ci
Set-Location ..
docker start gsm-map-osrm
```

Mở hai terminal tại project root. Chạy backend trong terminal thứ nhất:

```powershell
.\.venv\Scripts\python.exe -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8000 --reload --reload-dir backend
```

Chạy frontend trong terminal thứ hai:

```powershell
Set-Location frontend
npm.cmd run dev
```

Mở <http://127.0.0.1:5173>. Chọn một trong bốn chế độ: **Single Trip**, **Fleet Simulation**, **Booking & Dispatch** hoặc **Voucher Experiment Studio**. API docs ở <http://127.0.0.1:8000/docs>. Nếu OSRM container đang chạy, bỏ qua `docker start`. Nếu graph đã có nhưng container chưa được tạo, chạy `python scripts\pipeline.py serve --detach`. Kiểm tra port 5000, 8000 và 5173 trước nếu ứng dụng đã mở.

Nếu chưa có PBF, bản đồ/render GeoJSON hoặc graph OSRM, xem [hướng dẫn dữ liệu A1](docs/A1-report.md). Không có fallback sang dịch vụ bản đồ hay routing công cộng.

## Saved Replay và Batch Analysis

Saved Replay chạy riêng, không cần FastAPI hoặc OSRM. Sau khi có render assets và sample A4 trên máy, trong PowerShell:

```powershell
Set-Location frontend
npm.cmd ci
npm.cmd run package:replay
npm.cmd run verify:replay
npm.cmd run build
Set-Location ..
py -3 scripts\serve_replay.py
```

Mở <http://127.0.0.1:4173/?runtime=saved> rồi chọn **Load Saved Demo** hoặc import file **Export Portable v1**. Server chỉ phục vụ static files và chặn `/api/*`. Khi chia sẻ demo, gửi thư mục `frontend/dist` đã build; không cần gửi PBF hay graph OSRM.

Batch cần Live backend và OSRM: trong Voucher Experiment Studio, Prepare Experiment rồi mở **Phân tích kinh doanh nâng cao → Batch Experiment Analysis**. Hướng dẫn batch, định nghĩa chỉ số và giới hạn được ghi trong [báo cáo A5](docs/A5-report.md). Legacy A4 JSON cần đóng gói trước khi import vào Saved Replay; xem README A5 trong báo cáo để biết lệnh.

## Tài liệu theo giai đoạn

- [A1 — bản đồ và routing local](docs/A1-report.md)
- [A2 — mô phỏng đội xe](docs/A2-report.md)
- [A3 — booking và điều phối](docs/A3-report.md)
- [A4 — voucher experiment](docs/A4-report.md)
- [A4.1 — workspace và responsive UI](docs/A4.1-report.md)
- [A5 — Saved Replay, batch analysis và handoff WP3](docs/A5-report.md)
- [A5 — hướng dẫn tích hợp WP3](docs/A5-integration-handoff.md)
