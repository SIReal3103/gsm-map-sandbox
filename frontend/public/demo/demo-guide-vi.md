# Demo Voucher & đội xe — 5 phút

Bản chuẩn bị ngày 13/10/2026. Mở **http://127.0.0.1:5173/**. Trang nghiên cứu phụ: **http://127.0.0.1:4173/**. Demo local, chưa xuất bản.

## Trước buổi demo

1. Kết nối SSD `Hiep SDD` và volume `ChatGPT Projects`. Giữ máy thức và Docker Desktop chạy.
2. Kiểm tra `http://127.0.0.1:5173/` mở trang 5 bước; mở bản đồ thấy đường và báo “Bản đồ sẵn sàng”.
3. Chạy trước kịch bản mặc định: **3 xe, 18 báo giá, 8 phút nhận báo giá, trần 50.000 ₫**, mã `hcm-demo-20261013`.
4. Để tốc độ 20×. Thử tạm dừng, kéo thời gian, chọn xe, đổi cách chọn ưu đãi. Có ba lượt chạy cùng đầu vào.
5. Tải JSON bằng nút JSON trong phần tổng cuối lượt chạy. Nếu cần phương án dự phòng, mở PDF và ảnh chụp đã chuẩn bị. Ảnh/số ghi trước phải được giới thiệu là ghi lại, không giả vờ đang chạy trực tiếp.

Không cần đăng nhập PriorLabs, không cần token hay GPU. Lượt trình diễn nhỏ không thuộc bộ kiểm 36 kịch bản khóa; không suy ra đạt mục tiêu từ lượt này.

## Lời trình bày và thao tác

| Thời gian | Màn hình / thao tác | Câu nói chính |
|---|---|---|
| 0:00–0:45 | Bước 1 — Bài toán | “Khách đặt thêm chưa chắc thành chuyến. Chúng tôi muốn dùng cùng ngân sách để hoàn tất thêm chuyến. Đường thật; khách và phản ứng voucher là mô phỏng.” |
| 0:45–1:30 | Bước 2 — WP1; chọn chuyến mẫu | “WP1 ước tính xác suất đặt từ báo giá. So cùng loại mô hình, thêm lịch sử có sẵn trước báo giá. Đây là số đọc từ mô hình đã lưu, không phải khách chắc chắn sẽ đặt.” |
| 1:30–2:15 | Bước 3 — WP2 | “WP2 so từng mức ưu đãi và giá khách phải trả. Mức không đủ điều kiện không được ước tính. WP2 dự đoán trực tiếp, không cộng xác suất WP1.” |
| 2:15–4:00 | Bước 4 → Mở mô phỏng → Chạy mô phỏng | “Xe rảnh phù hợp gần nhất luôn nhận booking; khách vẫn có thể không đặt. Xe đi theo OSM/OSRM. Đổi giữa không voucher, chỉ xét khách, xét đội xe; cùng thời điểm và cùng kịch bản.” |
| 4:00–5:00 | Về Luồng demo → Bước 5 — Kết quả | “Luồng kỹ thuật đã kiểm. WP1 giảm log-loss 1,56%, dưới mục tiêu 2%. WP3 tăng 1.536 lên 1.537 chuyến: 0,065%, dưới 5%. Chưa có bằng chứng SOTA hay hiệu quả trên Green SM thật.” |

Khi chờ tính WP3, giải thích quy tắc xe rảnh và ba loại số: số tại thời điểm trên map, tổng cuối lượt chạy, kết quả của bộ kiểm khóa. Thời gian xử lý thực tế phụ thuộc máy; không hứa tức thì.

## Trả lời câu hỏi thường gặp

**“100% nhận chuyến” nghĩa gì?** Xe rảnh phù hợp gần nhất luôn nhận booking theo khoảng thời gian đi đường. Đây không phải 100% khách đặt hoặc 100% booking hoàn tất. Chưa có xe phù hợp thì khách chờ; hết hạn có thể thất bại.

**Map thật tới đâu?** Đường OSM từ Geofabrik, tuyến ô tô và thời gian từng đoạn OSRM. Vùng kỹ thuật nhỏ quanh Quận 1 cũ, không phải ranh giới hành chính. Không có GPS xe thật hay giao thông đo trực tiếp. Hệ số thời gian 1 là thời gian profile OSRM, không phải hiệu chỉnh bằng hành trình thực đo.

**WP1 tốt chưa?** So M1/M2 cùng logistic. Trên cohort mô phỏng đang dùng cho map, giảm log-loss tương đối 1,556% trên 36 ngày kiểm tra: chưa đạt 2%. Các nghiên cứu riêng sau đó đạt 1,133% và 1,647% trên Test; chưa kích hoạt lên map.

**WP2 có chứng minh voucher gây tăng đặt không?** Chưa. Phản ứng học từ mô phỏng, có kiểm support và giá. Cần dữ liệu báo giá gồm cả không đặt, và thiết kế thí nghiệm phù hợp để đánh giá tác động thật.

**WP3 vì sao chưa đạt 5%?** Trên đúng 36 kịch bản khóa, trần chẩn đoán biết cả tương lai chỉ 1.545 chuyến, tăng tối đa 0,586%; 5% cần 1.613 chuyến. Tối ưu tiếp trong cùng thế giới không đủ. Đây là trần của tập cố định, không phải định lý về dân số khách hay thực địa.

**Tiết kiệm tiền có thay mục tiêu không?** Không. Tiết kiệm trợ giá là chỉ số phụ. Mục tiêu chính vẫn +5% chuyến hoàn tất với ngân sách và ngưỡng phục vụ đã chốt.

**Service đã đạt hết chưa?** Chưa. Bộ kiểm có kịch bản quá tải ngay ở baseline. “Không làm xấu hơn baseline” không đồng nghĩa đạt tuyệt đối ngưỡng phục vụ.

**SOTA / TabPFN?** Chưa có bằng chứng SOTA. TabPFN 3.5 chưa chạy vì quyền truy cập weights/giấy phép chưa hoàn tất; đăng nhập web không tự chứng minh quyền tải weights. Các phương pháp công khai đã chạy; không cần tài khoản này để demo.

**OASIS/MiroFish đã xong?** Chưa tích hợp hoàn tất. Không gọi bản hiện tại là hoàn thành toàn bộ đề xuất ban đầu.

**Tính năng từ GitHub đâu?** Công cụ nâng cao giữ một hành trình, đội xe, đặt/điều xe và thí nghiệm voucher/phân tích/xuất. Sandbox cũ có giả định riêng; không gộp kết quả của nó vào WP3 đang dùng model.

## Chạy và khôi phục local

Ứng dụng map nằm `/Volumes/ChatGPT Projects/gsm-map-sandbox`. Lệnh từ thư mục này:

```sh
bash scripts/start-local.sh
```

Script kiểm Docker và artifact rồi khởi động frontend, backend, OSRM. Web cổng 5173; API cổng 8000; OSRM cổng 5001. Nếu chỉ thay UI, dùng script chuẩn để build đúng bản. Không chạy máy chủ thứ hai trên các cổng này.

Ứng dụng nghiên cứu phụ nằm `/Volumes/Hiep SDD/GMS Research/p06-ai-product-demo`. Lệnh từ thư mục này:

```sh
npm run dev -- --host 127.0.0.1 --port 4173 --strictPort
```

Chỉ dùng web phụ khi cần tài liệu cũ. Luồng trình diễn chính luôn là cổng 5173.

**Không thấy map:** kiểm SSD/volume, Docker, API; bấm Kiểm tra lại bản đồ. Không đổi sang dữ liệu giả để che lỗi.

**Lượt chạy báo lỗi:** đọc thông báo, kiểm bộ tính tuyến, chạy lại cùng cấu hình. Nếu chưa phục hồi kịp, dùng PDF/ảnh ghi trước và nói rõ demo ghi lại.

**Lượt demo không tăng chuyến:** vẫn trình bày kết quả; không tìm seed thắng để nói đạt mục tiêu. Ba cách chọn có thể bằng nhau trong lượt nhỏ.

**Dừng toàn bộ stack sau buổi demo:** chỉ khi bạn muốn tắt dịch vụ:

```sh
bash scripts/start-local.sh stop
```

Mốc dừng nghiên cứu đã tạm hiểu 06:00 ngày 14/10/2026 giờ Việt Nam, chờ câu trả lời xác nhận. Dừng việc nghiên cứu không tự tắt dịch vụ cần cho demo.

## Kết luận cần nhớ

Luồng 3 WP có bản demo kiểm được trên đường thật. Các mục tiêu nghiên cứu 2%/5% chưa đạt; chưa kiểm trên dữ liệu vận hành Green SM. Bước tiếp theo cần dữ liệu và phạm vi mô phỏng được chốt trước, không đổi ngưỡng hoặc chọn seed thắng sau khi xem kết quả.
