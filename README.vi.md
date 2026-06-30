# Movie Cast Browser

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://github.com/thuongtin/movie-cast-browser/actions/workflows/ci.yml/badge.svg)](https://github.com/thuongtin/movie-cast-browser/actions/workflows/ci.yml)
[![Electron](https://img.shields.io/badge/Electron-39-47848F.svg?logo=electron&logoColor=white)](https://www.electronjs.org/)

Trình duyệt desktop nhỏ để phát hiện link video trực tiếp trong trang web và cast media đó sang Chromecast hoặc TV có Chromecast built-in. App không cast nguyên màn hình: nó gửi link media để TV tự tải và phát. Renderer dùng React, Tailwind CSS và các component theo kiểu shadcn/ui.

> Read this in English: [README.md](README.md)

## Tính năng

- Phát hiện thẻ `video` và file media trực tiếp (`.mp4`, `.m3u8`, `.mpd`, `.webm`) khi bạn lướt web.
- Phát hiện phụ đề rời từ `<track>`, nhóm phụ đề trong HLS, và các URL phụ đề phổ biến.
- Cast media đã chọn sang Chromecast cùng mạng LAN, không cast màn hình.
- Tự quét thiết bị khi mở app và ghi nhớ thiết bị cast gần nhất.
- Preview link đã chọn ngay trong app, gồm cả phát HLS qua `hls.js`.
- Hiển thị thời lượng và độ phân giải khi có dữ liệu.
- Điều khiển TV: phát, tạm dừng, tua, âm lượng, tắt tiếng, dừng và hàng đợi media.
- Ghi nhớ cấu hình tắt tiếng âm thanh của app.
- Tự resume vị trí xem theo từng media URL khi cast lại cùng link.
- Xử lý cast thông minh, tự thử lại khi TV đang bật còn chưa sẵn sàng.

## Yêu cầu

- Node.js 20 trở lên.
- Một Chromecast hoặc TV có Chromecast built-in cùng mạng nội bộ.
- Mạng cho phép mDNS để có thể phát hiện thiết bị.

## Cài đặt và chạy

```bash
npm install
npm start
```

`npm start` tự kiểm tra Electron binary trước khi mở app. Trên macOS, hãy cho phép quyền Local Network khi được hỏi để app tìm được Chromecast.

## Cách dùng

1. Mở app. Nếu đã dùng trước đó, app tự mở lại trang cuối. Nếu chưa, nhập URL trang phim.
2. Khi trang có thẻ `video` hoặc file `.mp4`, `.m3u8`, `.mpd`, `.webm`, link sẽ hiện trong mục "Link phim".
3. Dùng danh sách lịch sử để mở lại trang đã xem gần đây.
4. Bấm "Quét" để tìm Chromecast trong cùng mạng LAN.
5. Chọn video, chọn thiết bị, rồi bấm "Cast video".
6. Sau khi cast, dùng phần điều khiển TV để phát, tạm dừng, tua, chỉnh âm lượng, tắt tiếng hoặc dừng.
7. Nếu TV đã có phiên cast đang chạy, chọn thiết bị rồi bấm "Kết nối TV" để lấy lại quyền điều khiển.
8. Khi đang cast, chọn link khác rồi bấm "Thêm hàng đợi" để thêm vào hàng đợi TV.

## Preview

Link được chọn có khung preview ngay bên dưới. Với HLS `.m3u8`, app dùng `hls.js` để thử phát preview trong app trước khi cast. Nếu CDN chặn preview bằng CORS hoặc header riêng, bạn vẫn có thể thử cast link đó sang TV.

## Cast nâng cao

- App lưu vị trí xem theo media URL và tự resume khi cast lại cùng link.
- Phụ đề WebVTT, TTML và phụ đề HLS rời có thể được gắn vào Cast media request. File SRT public được chuyển sang WebVTT qua proxy local tạm thời.
- Các nút điều khiển TV tự bật/tắt theo capability mà Chromecast trả về, ví dụ seek, skip, volume hoặc mute.
- Hàng đợi dùng queue API của Default Media Receiver nên chỉ hoạt động khi receiver hỗ trợ queue cho media đó.

## Giới hạn kỹ thuật

- App chỉ cast direct media URL mà TV tự tải được.
- Phụ đề rời chỉ hoạt động khi TV tự tải được URL phụ đề, hoặc khi desktop app tải được file SRT public và proxy lại dưới dạng WebVTT.
- Video có DRM như Netflix, Disney+, Prime Video, hoặc stream bắt buộc cookie, token ngắn hạn, header riêng thường sẽ không cast được qua Default Media Receiver.
- TV và máy tính phải cùng mạng LAN, và mạng phải cho phép mDNS.
- Bản này tập trung Chromecast. AirPlay và DLNA có thể thêm sau dưới dạng adapter riêng.

## Dùng có trách nhiệm

Dự án này là công cụ cast media đa dụng. Nó không lưu trữ, không index, không giải mã và không phân phối bất kỳ nội dung nào, đồng thời không có cơ chế bẻ khóa DRM hay các biện pháp bảo vệ kỹ thuật khác.

Chỉ dùng app với nội dung bạn sở hữu hoặc được phép truy cập hợp pháp, và tôn trọng điều khoản dịch vụ của trang web bạn truy cập cùng luật bản quyền tại quốc gia của bạn. Bạn hoàn toàn chịu trách nhiệm về cách mình sử dụng phần mềm này. Tác giả không cổ vũ hay hỗ trợ vi phạm bản quyền hoặc bất kỳ hành vi trái pháp luật nào.

## Phát triển

```bash
npm test        # chạy kiểm tra tĩnh và build production
npm run smoke   # build và chạy smoke capture của Electron với trang sample local
```

Smoke test mở một trang sample đi kèm và xác nhận có ít nhất một media candidate được phát hiện. Nó cần màn hình hiển thị và dành cho chạy local.

Xem [CONTRIBUTING.md](CONTRIBUTING.md) để biết cách cài đặt, kiểm tra và gửi thay đổi.

## Giấy phép

[MIT](LICENSE)
