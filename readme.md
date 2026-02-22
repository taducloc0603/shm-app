# ShmHub Desktop UI

Ứng dụng desktop (Electron) để tạo và quản lý danh sách cấu hình, lưu dữ liệu lên Supabase.

## Chức năng hiện có

- Tạo cấu hình mới qua modal (`group_name`, `point`, `open_pts`, `confirm_gap_pts`, `hold_confirm_ms`, `sans`)
- Hiển thị danh sách cấu hình đã lưu từ Supabase
- Mỗi record có nút **Show/Hide** để mở rộng phần thông tin chi tiết
- Toggle trạng thái **Start / End** theo từng record (UI state)
- Bảng ngang theo `sans` với 2 hàng `Bid/Ask` (placeholder `-`)
- Có loading overlay khi:
  - Đang tải danh sách
  - Đang lưu dữ liệu

## Cấu trúc project

```text
src/
  main/
    index.js       # bootstrap main process
    window.js      # tạo BrowserWindow
    ipc.js         # đăng ký IPC handlers
    checkShm.js    # nghiệp vụ check shm
  preload/
    index.js       # expose API an toàn sang renderer
  renderer/
    index.html     # markup UI
    styles.css     # giao diện
    app.js         # logic renderer
```

File ở root:

- `main.js`, `preload.js`: wrapper tương thích ngược
- `index.html`: wrapper mỏng chuyển hướng sang `src/renderer/index.html`

## Cài đặt & chạy

```bash
npm install
npm run dev
```

## Build ứng dụng

```bash
npm run build
```

## Ghi chú bảo mật

- Không commit password/key nhạy cảm vào source code hoặc README.
- Nên đưa thông tin nhạy cảm vào biến môi trường hoặc file cấu hình riêng (không đẩy lên git).

