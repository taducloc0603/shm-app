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

Chạy test (Node test runner có sẵn, không cần cài thêm):

```bash
npm test
```

## Log tick theo cặp sàn

Mỗi lần bấm **Start** một config, app tạo **một file cho mỗi cặp sàn** trong `Desktop\ticks` (thư mục được tạo
tự động). Config có N sàn thì có N·(N−1)/2 cặp. Bấm **End** (hoặc đóng app) sẽ ghi nốt hàng đợi và dòng kết thúc.

- Tên file: `{yyyyMMdd_HHmmss}-{group}-{A}-{B}.log`, ví dụ `20260919_093000-XAU_Group-MT5_A-MT5_B.log`.
  `A`/`B` là tên map đã bỏ `Local\`/`Global\`, theo đúng thứ tự trong config (A là sàn đứng trước).
  Hai lần Start trong cùng một giây thì file sau có hậu tố `_2`.
- Mỗi lần poll (30 ms) ghi một dòng cho mỗi cặp, kể cả khi giá không đổi; thiếu dữ liệu thì ghi `-`.
  Định dạng giống kênh `-gap-tick.log` của TradeDesktop để dùng chung công cụ phân tích:

  ```
  [14:32:07.412] [GAP_TICK] gap_buy=12 gap_sell=-3 a_sym=XAUUSD a_bid=2412.35 a_ask=2412.55 a_spread=0.2 a_lat=8 b_sym=XAUUSD.m b_bid=2412.67 b_ask=2412.88 b_spread=0.21 b_lat=11 point=100
  ```

  Timestamp là giờ local của máy lúc poll. `gap_buy=(B.Bid−A.Ask)·point`, `gap_sell=(B.Ask−A.Bid)·point`
  (làm tròn về số nguyên); `spread=ask−bid` (giá thô, đã khử sai số dấu phẩy động); `lat` là latency ms.
- Đầu file có header (`GAP TICK START`, ngày, host, cặp, legend); cuối file có `GAP TICK STOP`.
- Dòng tick chỉ có giờ; khi chạy qua 00:00 file có thêm dòng `[00:00:00.xxx] Date: yyyy-MM-dd` trước dòng đầu của ngày mới.
- Mỗi lần Start, file tick (đúng mẫu tên `{yyyyMMdd_HHmmss}-....log`) cũ hơn **7 ngày** trong `Desktop\ticks` bị xóa.
  File khác trong thư mục không bị đụng.
- Dung lượng ước tính: khoảng 33 dòng/giây, ~20 MB/giờ **cho mỗi cặp**.
- Khi file đủ **50 MB** thì tách sang file tiếp theo: `...-MT5_A-MT5_B.log` → `.001.log` → `.002.log`…
  Tách đúng ranh giới dòng (không cắt ngang, không mất dòng).
  - File trước kết thúc bằng `===== GAP TICK PART END -> tiep tuc o <file tiếp theo> =====`.
  - File sau có **header đầy đủ** (START, ngày, host, cặp, legend) và thêm dòng
    `Part: 001 (tiep theo cua <file đầu>, phien bat dau ...)`, nên mở riêng từng file vẫn biết là cặp nào, phiên nào.
  - Chỉ file cuối cùng có `GAP TICK STOP`.
- Ghi không chặn vòng poll: dòng vào hàng đợi (tối đa 50 000 dòng/cặp), ghi đĩa theo lô mỗi 200 ms. Hàng đợi đầy
  thì bỏ dòng và đếm; số dòng bị bỏ được ghi cuối file và trong `[TICK_LOGGER][HEALTH]` (console, mỗi 60 s).
- Code: `src/main/tickLogger.js` (ghi file), `src/renderer/utils/gapTickLine.js` (định dạng dòng),
  gọi từ vòng poll trong `src/renderer/app.js`.

## Build ứng dụng

```bash
npm run build
```

## Doưnload exe release

```bash
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Invoke-WebRequest -Uri "https://github.com/taducloc0603/split-files/releases/download/v1.0.1/GapLogger.App-1.0.1.exe" -OutFile GapLogger.exe
```

## PowerShell đọc Shared Memory

````
# ============================
# CONFIG
# ============================
$mapName = "Local\MT5_A"   # đổi nếu cần

# HEADER
$H_QUOTE_SEQ = 0
$H_CMD_SEQ   = 4
$H_ACK_SEQ   = 8
$H_ACK_CODE  = 12

$HEADER_SIZE = 16

# QUOTE RING
$QUOTE_RING_OFFSET = 16
$QUOTE_RING_SIZE   = 64
$QUOTE_MSG_SIZE    = 48

$Q_TS_OFFSET     = 8
$Q_BID_OFFSET    = 16
$Q_ASK_OFFSET    = 24
$Q_SYMBOL_OFFSET = 32

# ============================
# OPEN MEMORY
# ============================
$mmf  = [System.IO.MemoryMappedFiles.MemoryMappedFile]::OpenExisting($mapName)
$view = $mmf.CreateViewAccessor()

function Read-AsciiString($view, $offset, $len) {
    $bytes = New-Object byte[] $len
    $view.ReadArray($offset, $bytes, 0, $len) | Out-Null
    return ([System.Text.Encoding]::ASCII.GetString($bytes)).TrimEnd([char]0)
}

$lastSeq = -1

while ($true) {

    Clear-Host

    # ============================
    # HEADER
    # ============================
    $quote_seq = $view.ReadUInt32($H_QUOTE_SEQ)
    $cmd_seq   = $view.ReadUInt32($H_CMD_SEQ)
    $ack_seq   = $view.ReadUInt32($H_ACK_SEQ)
    $ack_code  = $view.ReadInt32($H_ACK_CODE)

    Write-Host "================ HEADER ================"
    Write-Host ("quote_seq : {0}" -f $quote_seq)
    Write-Host ("cmd_seq   : {0}" -f $cmd_seq)
    Write-Host ("ack_seq   : {0}" -f $ack_seq)
    Write-Host ("ack_code  : {0}" -f $ack_code)
    Write-Host ""

    # ============================
    # QUOTE INFO
    # ============================
    if ($quote_seq -gt 0) {
        $slot = $quote_seq % $QUOTE_RING_SIZE
        $base = $QUOTE_RING_OFFSET + ($slot * $QUOTE_MSG_SIZE)

        $time_msc = $view.ReadInt64($base + $Q_TS_OFFSET)
        $bid      = $view.ReadDouble($base + $Q_BID_OFFSET)
        $ask      = $view.ReadDouble($base + $Q_ASK_OFFSET)
        $symbol   = Read-AsciiString $view ($base + $Q_SYMBOL_OFFSET) 16

        Write-Host "================ QUOTE ================="
        Write-Host ("slot      : {0}" -f $slot)
        Write-Host ("base addr : 0x{0:X}" -f $base)
        Write-Host ("symbol    : {0}" -f $symbol)
        Write-Host ("bid       : {0}" -f $bid)
        Write-Host ("ask       : {0}" -f $ask)
        Write-Host ("time_msc  : {0}" -f $time_msc)
        Write-Host ""
    }
    else {
        Write-Host "No quote yet (quote_seq = 0)"
        Write-Host ""
    }

    # ============================
    # COMMAND STATUS
    # ============================
    Write-Host "============== COMMAND STATUS ==========="
    if ($cmd_seq -eq 0) {
        Write-Host "No command sent yet."
    }
    else {
        Write-Host ("Last command seq : {0}" -f $cmd_seq)

        if ($ack_seq -eq $cmd_seq) {
            Write-Host "EA has processed this command."
            Write-Host ("Result code : {0}" -f $ack_code)
        }
        else {
            Write-Host "EA has NOT processed latest command yet."
        }
    }

    Start-Sleep -Milliseconds 500
}
````


## Ghi chú bảo mật

- Không commit password/key nhạy cảm vào source code hoặc README.
- Nên đưa thông tin nhạy cảm vào biến môi trường hoặc file cấu hình riêng (không đẩy lên git).

