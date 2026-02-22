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
    app.js         # entrypoint renderer (orchestrator)
    config/
      constants.js
    services/
      supabaseService.js
      platformService.js
    state/
      appState.js
    ui/
      configListView.js
      sanRows.js
      loadingOverlay.js
    utils/
      escapeHtml.js
      normalizeSans.js
```

## Giải thích cấu trúc chi tiết

### 1) `src/main` (Electron Main Process)
- Chịu trách nhiệm lifecycle app, tạo cửa sổ, đăng ký IPC.
- Không chứa UI.

Module chính:
- `index.js`: bootstrap app (`app.whenReady`, sự kiện `activate`, `window-all-closed`)
- `window.js`: cấu hình `BrowserWindow`, đường dẫn preload/renderer
- `ipc.js`: gom toàn bộ IPC handlers tại một nơi
- `checkShm.js`: nghiệp vụ kiểm tra shared memory (hiện tại theo cơ chế PowerShell cho Windows)

### 2) `src/preload` (Bridge an toàn)
- Dùng `contextBridge` để expose API tối thiểu từ main sang renderer.
- Giúp tách biệt security boundary, tránh bật `nodeIntegration` trong renderer.

### 3) `src/renderer` (UI Layer)

`app.js` chỉ làm điều phối (orchestrator):
- lấy DOM refs
- khởi tạo service/module
- nối event handlers
- gọi `loadConfigs()` lúc khởi động

Các nhóm module:

- `config/`
  - `constants.js`: hằng số hệ thống (URL/key...)

- `services/`
  - `supabaseService.js`: đọc/ghi cấu hình từ Supabase (kèm fallback REST)
  - `platformService.js`: lấy platform từ preload API

- `state/`
  - `appState.js`: state dùng chung cho renderer (active config, run state...)

- `ui/`
  - `configListView.js`: render danh sách config và bind sự kiện Show/Hide, Start/End
  - `sanRows.js`: quản lý danh sách sàn trong form (add/validate/reset)
  - `loadingOverlay.js`: quản lý loading overlay dùng chung

- `utils/`
  - `escapeHtml.js`: chống inject khi render HTML string
  - `normalizeSans.js`: chuẩn hóa dữ liệu `sans` về mảng

## Luồng hoạt động tổng quan

1. App mở → `src/main/index.js` tạo window.
2. Window load `src/renderer/index.html` + `app.js` (module script).
3. `app.js` khởi tạo services/state/ui modules.
4. Gọi `loadConfigs()`:
   - show loading
   - fetch từ Supabase
   - render danh sách
   - hide loading
5. Khi submit form tạo config:
   - validate dữ liệu sàn
   - insert Supabase
   - reload danh sách

## Nguyên tắc mở rộng đề xuất

- Tính năng mới ưu tiên thêm theo đúng lớp:
  - gọi API/DB → `services/`
  - state dùng chung → `state/`
  - giao diện → `ui/`
  - hàm tiện ích thuần → `utils/`
- Giữ `app.js` mỏng, tránh biến thành "God file".
- Khi nghiệp vụ phức tạp hơn, có thể thêm `features/` để đóng gói theo domain.

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

