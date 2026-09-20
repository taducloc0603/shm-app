# ShmHub Desktop UI

Ứng dụng desktop (Electron) đọc báo giá MT5 từ Windows shared memory, tính gap giữa các cặp sàn
và ghi log tick. **Chạy hoàn toàn offline** — không gọi mạng, không mở port; cấu hình và log nằm
ở thư mục Desktop của người dùng.

## Chức năng hiện có

- Tạo cấu hình mới qua modal (`group_name`, `point`, `open_pts`, `confirm_gap_pts`, `hold_confirm_ms`, `sans`)
- Hiển thị danh sách cấu hình đã lưu (file `Desktop\shm-config.csv`)
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
    index.js           # bootstrap main process
    window.js          # tạo BrowserWindow
    ipc.js             # đăng ký IPC handlers
    checkShm.js        # nghiệp vụ check shm
    configCsvStore.js  # lưu config ra Desktop\shm-config.csv
    tickLogger.js      # ghi file tick theo cặp (hàng đợi, flush, xoay file, retention)
    gapTickFile.js     # header file tick nhị phân .gtick
    csvLogger.js       # (đang tắt) log CSV cũ
  preload/
    index.js           # expose API an toàn sang renderer
  renderer/
    index.html         # markup UI
    styles.css         # giao diện
    app.js             # entrypoint renderer (orchestrator)
    services/
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
      gapTickRecord.js # bản ghi tick 64 byte (encode/decode)
      gapTickStream.js # lúc nào thì ghi: dedup theo quote_seq + heartbeat
      gapTickLine.js   # định dạng dòng GAP_TICK text
      quoteSeq.js      # hiệu quote_seq (có xử lý quay vòng uint32)
tools/
  gapTickReader.mjs    # đọc .gtick theo luồng
  ticks.mjs            # CLI .gtick: info / export / slice / stats
  madeoReader.mjs      # đọc .ticks/.trace của TradeDesktop
  madeo.mjs            # CLI Madeo: info / export / log
packaging/
  win/
    ticks.cmd          # chạy bộ giải mã bằng ShmHub.exe ở chế độ Node
    madeo.cmd
docs/
  tradedesktop-binary-format.md   # đặc tả .ticks/.trace giải mã được
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

- `services/`
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
   - đọc `Desktop\shm-config.csv` qua IPC `config:list`
   - render danh sách
   - hide loading
5. Khi submit form tạo config:
   - validate dữ liệu sàn
   - append một dòng vào `Desktop\shm-config.csv`
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
tự động). Config có N sàn thì có N·(N−1)/2 cặp. Bấm **End** (hoặc đóng app) sẽ ghi nốt hàng đợi và dấu kết thúc.

File ghi ở **định dạng nhị phân `.gtick`**: bản ghi cố định **64 byte**, little-endian. So với định dạng text cũ
(`~185 byte/dòng`, ghi mỗi lần poll) thì nhẹ hơn **13,7 lần** mà **không mất thông tin nào** — đo trên một
phiên mô phỏng 10 phút ở nhịp thật: **24,56 MB/giờ → 1,80 MB/giờ cho mỗi cặp**.

Hai thứ tạo ra mức giảm đó:

1. **Bỏ tên trường lặp lại.** Trong dòng text, ~70 byte mỗi dòng là tên trường (`gap_buy=`, `a_bid=`…), còn
   `a_sym`/`b_sym`/`point` là hằng số cho cả file nhưng vẫn ghi lại mỗi 30 ms. Trong `.gtick` chúng nằm ở header.
2. **Chỉ ghi khi có thay đổi.** Poller chạy 30 ms/lần nhưng feed MT5 chỉ đổi giá vài lần mỗi giây — đo trên file
   mẫu `.ticks` của TradeDesktop, **84 % bản ghi có bid/ask y hệt bản ghi liền trước**. App chỉ ghi khi `quote_seq`
   của A hoặc B đổi (so số nguyên, chính xác tuyệt đối), cộng một **heartbeat mỗi giây**.

Heartbeat là phần bắt buộc, không phải tùy chọn: thiếu nó thì "giá đứng yên" và "app treo / feed chết" nhìn
giống hệt nhau trong file.

### Cấu trúc file

- Tên file: `{yyyyMMdd_HHmmss}-{group}-{A}-{B}.gtick`, ví dụ `20260919_093000-XAU_Group-MT5_A-MT5_B.gtick`.
  `A`/`B` là tên map đã bỏ `Local\`/`Global\`, theo đúng thứ tự trong config. Hai lần Start trong cùng một giây
  thì file sau có hậu tố `_2`.
- **Header tự mô tả** (đệm tới bội số 64 byte): magic `SHMTICK1`, version (hiện tại **2**, bộ đọc
  vẫn mở được file v1 cũ), recordSize, rồi một khối JSON chứa
  `mapA/mapB`, `symA/symB`, `group`, `point`, `confirmGapPts`, `openPts`, `holdConfirmMs`, `host`, `startedAtMs`,
  `tzOffsetMin`, `part`, `baseFile`. Sai magic hoặc sai version thì bộ giải mã **từ chối đọc** thay vì diễn giải bừa.
- **Bản ghi 64 byte**:

  | offset | kiểu | trường |
  |---|---|---|
  | 0 | f64 | `wallMs` — `Date.now()` lúc poll (epoch ms, **đủ cả ngày**, không còn phải chèn dòng `Date:` lúc qua 00:00) |
  | 8 / 16 | f64 | `timeMscA` / `timeMscB` — giờ tick thô của broker (**text cũ không ghi trường này**) |
  | 24 / 32 | f64 | `bidA` / `askA` |
  | 40 / 48 | f64 | `bidB` / `askB` |
  | 56 / 58 | u16 | `latA` / `latB` (ms; `0xFFFF` = không có) |
  | 60 | u8 | cờ: A hợp lệ, B hợp lệ, heartbeat, data gap, control |
  | 61 / 62 | u8 | `ticksA` / `ticksB` — số tick của sàn đó đã xảy ra **kể từ bản ghi trước** |
  | 63 | u8 | dự phòng |

  Không lưu vì suy ra được: `spread = ask − bid`, `gap_buy = (bidB − askA)·point`,
  `gap_sell = (askB − bidA)·point`. Giá lưu nguyên `f64` nên **chính xác hơn** text cũ (text làm tròn `toFixed(10)`).
- **`ticksA`/`ticksB` — độ phủ dữ liệu.** Feed MT5 là event-driven (xem
  [docs/tradedesktop-binary-format.md](docs/tradedesktop-binary-format.md)), nên vòng poll 30 ms
  **chắc chắn bỏ sót tick**. Hiệu `quote_seq` so với bản ghi trước cho biết đã có bao nhiêu tick:
  `0` = không có tick mới, `1` = bắt đúng một tick, `N` = có N tick nhưng chỉ thấy cái cuối.
  Trường 1 byte nên **255 nghĩa là "≥ 255"**, `stats` cảnh báo khi chạm trần. File v1 không có
  trường này và bộ đọc trả `null` (= "không biết", khác hẳn `0`).
- **Bản ghi điều khiển** (cùng 64 byte, cờ control) đánh dấu đóng file sạch kèm số bản ghi bị bỏ, và dấu hết part.
  File không có dấu đóng = app crash hoặc đang ghi dở.
- **Cố tình không dùng delta-encoding và không nén.** Nhỏ hơn nữa được (~16–20 byte/bản ghi) nhưng một byte hỏng
  sẽ làm lệch khung toàn bộ phần đuôi file. Bản ghi cố định 64 byte thì file bị cắt cụt (crash, mất điện) chỉ mất
  bản ghi cuối; `info` báo đúng số byte dư.
- Khi file đủ **50 MB** thì tách sang `...-MT5_A-MT5_B.gtick` → `.001.gtick` → `.002.gtick`… Tách đúng biên 64 byte.
  Mỗi part có **header đầy đủ riêng** (kể cả symbol) nên mở riêng từng file vẫn biết là cặp nào, phiên nào.
- Mỗi lần Start, file tick (đúng mẫu tên `{yyyyMMdd_HHmmss}-....{gtick|log}`) cũ hơn **7 ngày** trong `Desktop\ticks`
  bị xóa. File khác trong thư mục không bị đụng.
- Ghi không chặn vòng poll: bản ghi vào hàng đợi (tối đa 50 000/cặp), ghi đĩa theo lô mỗi 200 ms. Hàng đợi đầy thì
  bỏ và đếm; số bị bỏ nằm trong bản ghi điều khiển cuối file và trong `[TICK_LOGGER][HEALTH]` (console, mỗi 60 s).

### Đọc file: `tools/ticks.mjs`

Chạy bằng Node thuần, không cần Electron:

```bash
npm run ticks -- info   "C:\Users\<user>\Desktop\ticks\20260919_093000-XAU_Group-MT5_A-MT5_B.gtick"
npm run ticks -- stats  <file.gtick> [--anonymize] [--confirm <pts>] [--open <pts>]
npm run ticks -- export <file.gtick> --log            # dựng lại ĐÚNG định dạng GAP_TICK text cũ
npm run ticks -- export <file.gtick> --csv --out x.csv
npm run ticks -- slice  <file.gtick> --from 09:34:00 --to 09:34:06
```

Truyền file gốc thì các part `.001`/`.002`… được nạp theo, đúng thứ tự.

`export --log` dựng lại dòng text **đúng từng ký tự** như writer cũ sẽ ghi — đã kiểm bằng cách so 4 896 dòng xuất
từ `.gtick` với log text sinh song song từ cùng một chuỗi quote: khớp 100 %. Nhờ đó **tương thích với công cụ phân
tích `-gap-tick.log` của TradeDesktop được giữ bằng chuyển đổi, không phải bằng lưu trữ**.

Cần soi log bằng tay tại hiện trường thì chạy app với `SHM_TICK_FORMAT=text` để quay lại writer text cũ
(`.log`, một dòng mỗi lần poll, không dedup).

### Đọc file trên máy đã cài app (không có repo, không có Node)

Bộ giải mã đi kèm bộ cài, nằm ở `resources\decoder\`. Hai file `.cmd` ở đó gọi chính `ShmHub.exe`
chạy ở chế độ Node, nên **máy giao dịch không cần cài Node riêng**:

```bat
cd "C:\Program Files\ShmHub\resources\decoder"
ticks.cmd stats "%USERPROFILE%\Desktop\ticks\<file>.gtick"
ticks.cmd export "<file>.gtick" --csv --out "%USERPROFILE%\Desktop\tick.csv"
madeo.cmd info  "<file.trace>"
```

Nguồn của hai file `.cmd` ở `packaging/win/`; `extraResources` trong package.json chép chúng cùng
`tools/` và vài file trong `src/` ra `resources\decoder\` dưới dạng file thường (không nằm trong
`app.asar`), giữ nguyên bố cục thư mục mà các import cần.

### Đưa dữ liệu cho AI phân tích

Dùng `stats`, **không dán file thô**. Định dạng text không giúp gì cho AI: một giờ chạy vượt xa context window của
mọi model, và đưa vài dòng đầu file rồi hỏi kết luận tổng thể là cách chắc chắn nhất để nhận về kết luận bịa.
Đường đi đúng là: script đọc **hết** dữ liệu → báo cáo vài KB → AI đọc báo cáo đó.

`stats` in ra (ví dụ thật: **1,9 KB** cho phiên 10 phút):

- khoảng thời gian, số bản ghi, tần suất đổi giá, MB/giờ, tỉ lệ thiếu dữ liệu mỗi sàn, số bản ghi bị bỏ;
- **độ phủ**: bắt được bao nhiêu trên tổng số tick thực tế (`bắt được 5257 / 7238 tick thực tế (72.6%)`);
  sai số ±0,1 % vì bản ghi đầu tiên chưa có mốc so sánh và các tick sau bản ghi cuối không được đếm;
- phân vị `gap_buy`/`gap_sell` (min/p50/p90/p99/max);
- số lần và tổng thời lượng gap vượt `confirm_gap_pts` / `open_pts` (ngưỡng lấy từ header, không phải tra lại config);
- phân vị latency mỗi sàn và độ lệch `time_msc` giữa hai sàn;
- **danh sách các khoảng heartbeat bị thiếu** — bằng chứng app treo / feed chết;
- bảng theo thời gian (tự gộp để không quá 60 dòng dù chạy cả ngày).

`--anonymize` thay `host`, tên shared memory map và symbol bằng bí danh trước khi in. Dùng nó khi gửi báo cáo ra
ngoài: bản thân giá vàng không nhạy cảm, nhưng cấu hình sàn và ngưỡng gap thì có.

Cần soi sâu một thời điểm đáng ngờ thì thêm một `slice` quanh thời điểm đó — vẫn nhỏ, vẫn đọc được.

### Đọc file của TradeDesktop

`OneLegHidden.00/` chứa file mẫu `.ticks`/`.trace` do TradeDesktop (Madeo) sinh ra. Định dạng đã
được giải mã và ghi lại ở [docs/tradedesktop-binary-format.md](docs/tradedesktop-binary-format.md):

```bash
npm run madeo -- info   "OneLegHidden.00/20260609T020153.trace"
npm run madeo -- export "<file.ticks|file.trace>" --csv [--out x.csv]
npm run madeo -- log    "<file.trace>"
```

File Madeo không có magic hay version, nên `info` đi hết khung và báo rõ có dừng đúng byte cuối file
không — đó là bằng chứng duy nhất cho thấy đã đọc đúng định dạng.

Dùng để **đối chiếu chéo**: chạy song song hai hệ thống trên cùng một phiên rồi so `gap1/gap2` trong
`.trace` của họ với `gap_buy`/`gap_sell` tính từ `.gtick` của mình.

### Code

- `src/renderer/utils/gapTickRecord.js` — mã hóa/giải mã bản ghi 64 byte (chạy được cả ở renderer lẫn Node thuần).
- `src/renderer/utils/gapTickStream.js` — quyết định lúc nào ghi (dedup theo `quote_seq` + heartbeat).
- `src/main/gapTickFile.js` — header file; `src/main/tickLogger.js` — hàng đợi, flush, xoay file, retention.
- `src/renderer/utils/gapTickLine.js` — định dạng dòng text (dùng cho `export --log` và chế độ `SHM_TICK_FORMAT=text`).
- `src/renderer/utils/quoteSeq.js` — hiệu `quote_seq`, xử lý quay vòng uint32 (dùng cho cả TPS lẫn `ticksA/B`).
- `tools/gapTickReader.mjs` + `tools/ticks.mjs` — bộ đọc và CLI cho `.gtick`.
- `tools/madeoReader.mjs` + `tools/madeo.mjs` — bộ đọc và CLI cho `.ticks`/`.trace` của TradeDesktop.

## Build ứng dụng

```bash
npm run build
```

## Tải bộ cài

Mỗi lần push lên nhánh `dev`, workflow `.github/workflows/release-windows-dev.yml` build và tạo một
**pre-release** `dev-<số run>` kèm file cài NSIS:

  https://github.com/taducloc0603/shm-app/releases

Tải file `.exe` mới nhất ở đó rồi cài. Máy đích **không cần** Node, Python hay Visual Studio —
native addon `.node` đã được build sẵn trong bộ cài. Có `gh` CLI thì nhanh hơn:

```powershell
gh release download --repo taducloc0603/shm-app --pattern "*.exe"
```

## Triển khai lên VPS

Những điều kiện dưới đây đều bắt buộc, và **phần lớn khi sai sẽ hỏng trong im lặng** chứ không
báo lỗi — đọc kỹ trước khi mất thời gian dò.

### 1. Phải có phiên Windows đồ hoạ

Vòng poll shared memory 30 ms nằm ở **renderer** (`src/renderer/app.js`), không có chế độ headless.
Cửa sổ không chạy thì không ghi được dòng tick nào.

- **Không** chạy được dưới dạng Windows service (session 0 không có desktop).
- Phải đăng nhập bằng một tài khoản thật (RDP hoặc console).

### 2. MT5 và ShmHub phải cùng một phiên Windows

Đây là chỗ mất thời gian nhất. Prefix mặc định `Local\MT5_` chỉ thấy được shared memory do tiến
trình trong **cùng phiên** tạo ra — native addon quét
`\Sessions\<session của chính ShmHub>\BaseNamedObjects`. Sai phiên thì `OpenFileMappingW` trả về
`NOT_FOUND`, **app báo "không tìm thấy" chứ không báo lỗi**.

| Cách bố trí | Việc phải làm |
|---|---|
| **Cùng phiên** (khuyên dùng) | Mở MT5 và ShmHub trong cùng một phiên RDP, cùng tài khoản. Giữ prefix `Local\MT5_`. Không cần quyền admin. |
| **Khác phiên** (MT5 chạy service / scheduled task) | EA phải tạo map tên `Global\…` (cần quyền admin để có `SeCreateGlobalPrivilege`), rồi đổi prefix trong UI thành `Global\MT5_`. App hỗ trợ sẵn cả hai namespace. |

Bấm **Scan danh sách sàn** mà không ra gì thì đọc thông báo — nó nhắc đúng chuyện phiên này.

### 3. EA phía MT5 không nằm trong repo này

App chỉ **đọc** shared memory (không có `CreateFileMapping` ở đâu cả). Phần ghi là một Expert
Advisor riêng phải tự cài lên từng terminal MT5, ghi đúng layout ở `src/main/checkShm.js`:
header 16 byte + ring 64 slot × 48 byte. Không có EA đó thì cài app cũng vô nghĩa.

### 4. Tài khoản phải có thư mục Desktop ghi được

App ghi thẳng vào Desktop, **không có fallback sang `userData`**:

- `Desktop\shm-config.csv` — tạo ngay lúc mở app. Thiếu quyền ghi là chết ở màn hình đầu tiên.
- `Desktop\ticks\` — log tick.

Có thể chép sẵn `shm-config.csv` lên VPS để khỏi nhập lại cấu hình bằng tay.

### 5. Ngắt phiên RDP

App đã tắt `backgroundThrottling` và ba cơ chế backgrounding của Chromium (`src/main/window.js`,
`src/main/index.js`) để vòng poll không bị hạ nhịp khi cửa sổ bị che hoặc phiên RDP bị ngắt.

**Nên tự kiểm một lần trên VPS của mình**: chạy 10 phút lúc còn kết nối, End, xem **độ phủ** bằng
`stats`; rồi chạy 10 phút nữa có ngắt RDP giữa chừng và so lại. Hai con số phải xấp xỉ nhau, và mục
"Ngắt quãng (heartbeat bị thiếu)" phải trống.

```bat
cd "C:\Program Files\ShmHub\resources\decoder"
ticks.cmd stats "%USERPROFILE%\Desktop\ticks\<file>.gtick"
```

### 6. Vận hành

- Thoát app bằng nút đóng, **không `taskkill`** — app chờ tối đa 5 s để ghi nốt hàng đợi tick.
- Đĩa: ~1,8 MB/giờ cho mỗi cặp sàn, file xoay ở 50 MB, tự xóa sau 7 ngày. Riêng `Desktop\shm-data\`
  (CSV cũ, hiện đã tắt) **không có cơ chế tự xóa**.
- Không cần mở port, không cần internet: app không gọi mạng.

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

