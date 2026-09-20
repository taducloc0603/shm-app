# Định dạng file nhị phân của TradeDesktop (Madeo)

Kết quả giải mã bằng cách đọc ngược từ dữ liệu — **không có tài liệu chính thức nào**.

> **Dữ liệu mẫu KHÔNG nằm trong repo.** Bộ file dưới đây (16 MB) bị `.gitignore` loại ra vì quá
> lớn để commit. Muốn kiểm chứng lại tài liệu này thì phải có chúng: một phiên `OneLegHidden.00`
> dài 25,6 phút, ngày 2026-06-09, do TradeDesktop sinh ra, đặt ở thư mục `OneLegHidden.00/` tại
> gốc repo. Mọi con số dưới đây đo trên đúng bộ file này.

| File | Kích thước |
|---|---|
| `20260609T020153.xml` | 20 166 B |
| `20260609T020153.trace` | 9 492 402 B |
| `20260609T020153_0____Fast Feed Fix____Gold (Spot).v1.ticks` | 1 675 264 B |
| `20260609T020153_1____MT5.00____GOLD.v1.ticks` | 2 739 968 B |
| `20260609T020153_2____MT5.00____GOLD.v1.ticks` | 2 739 968 B |

Bộ đọc: [tools/madeoReader.mjs](../tools/madeoReader.mjs), CLI [tools/madeo.mjs](../tools/madeo.mjs).

Tài liệu này ghi rõ **phần nào đã kiểm chứng và phần nào là suy đoán**. Đừng dựa vào phần suy đoán
để ra quyết định.

---

## Khung chung

Cả `.ticks` lẫn `.trace` dùng chung một khung, little-endian:

```
[i32 recordType][i32 payloadSize][payload đúng payloadSize byte]   nối đuôi nhau
```

**Không có header file, không magic, không version trong file.** Cách duy nhất để biết đã đọc đúng
định dạng là đi hết khung và xem con trỏ có dừng đúng byte cuối file không — `madeo.mjs info` làm
việc đó và in ra kết quả. Trên cả bốn file mẫu, con trỏ dừng **đúng byte cuối cùng**.

| File | type | payloadSize | tổng/bản ghi | số bản ghi (mẫu) |
|---|---|---|---|---|
| `.ticks` | 100 | 56 | 64 B | 26 176 / 42 812 / 42 812 |
| `.trace` | 1 | 232 | 240 B | 39 548 |
| `.trace` | 1000 | thay đổi (51–406) | 8 + size | 7 |

### Quy ước .NET

Đây là chương trình .NET, gần như chắc chắn ghi bằng `BinaryWriter`:

- **Thời gian** = `DateTime.Ticks`: `i64`, đơn vị 100 ns, gốc `0001-01-01`.
  Đổi sang epoch ms: `Number(ticks / 10000n) − 62135596800000`.
- **Chuỗi** = `[i32 độ dài][chuỗi UTF-8 kết thúc bằng NUL]`. Độ dài **đã tính cả byte NUL**
  (chuỗi `" Madeo OneLegHidden.00 started"` dài 30 ký tự nhưng trường độ dài ghi 31).

---

## `.ticks` — type 100, payload 56 byte

Một file cho mỗi feed. **Toàn bộ danh tính nằm ở tên file**, không có gì trong file:

```
{yyyyMMddTHHmmss}_{chỉ số}____{tên feed}____{symbol}.v1.ticks
```

Kể cả `.v1` cũng ở tên file. Đổi tên file là mất sạch ý nghĩa của dữ liệu.

| offset | kiểu | trường | Trạng thái |
|---|---|---|---|
| 0 | i32 | luôn = `1001` | **Kiểm chứng.** Hằng số ở **cả ba** file mẫu → đây là tag schema, **không phải feed id**. |
| 4 | f64 | `bid` | Kiểm chứng |
| 12 | f64 | `ask` | Kiểm chứng |
| 20 | f64 | luôn = 0 | **Kiểm chứng.** Bằng 0 ở toàn bộ 111 800 bản ghi. |
| 28 | f64 | luôn = 0 | **Kiểm chứng.** Như trên. |
| 36 | i64 | `DateTime.Ticks` | Kiểm chứng |
| 44 | f64 | `durMs` | **Suy đoán.** Phân bố như một phép đo `Stopwatch`: p50 = 0,05 · p90 = 0,29 · p99 = 9 957 · max = 29 145. **Không đơn điệu tăng** → không phải đồng hồ. Ngoại lệ lớn có thể là GC pause hoặc reconnect. |
| 52 | i32 | `field52` | **Chưa giải thích được.** 98 % bằng `1`, đuôi dài với 22–26 giá trị khác nhau; riêng giá trị `1481` xuất hiện 714 lần ở cả hai file MT5 và tương quan với `durMs` rất lớn (trung bình 14 348). |

**16 trong 56 byte payload là hai double luôn bằng 0** — chỗ để dành cho `last`/`volume` chưa dùng
tới. Sao chép nguyên format này sang chỗ khác là chấp nhận lãng phí 25 % dung lượng bản ghi.

---

## `.trace` — type 1000: dòng log chữ

```
[i32 subtype][i32 strLen][chuỗi UTF-8 + NUL][i32 mức độ][i64 DateTime.Ticks]
```

`subtype` trùng với `recordType` (1000). Mức độ: `0` = info, `2` = error — quan sát được trên mẫu
(hai dòng mức 2 đúng là hai lỗi `Timeout exception` và `Cleanup: Object reference not set`).
Chỉ có 7 dòng trong cả phiên, nên `.trace` **không phải** file log thông thường.

---

## `.trace` — type 1: ảnh chụp của CẶP, payload 232 byte

Đây là phần đáng chú ý nhất: **không phải tick thô**, mà là ảnh chụp cả hai chân cùng lúc kèm các
đại lượng đã quy ra point — đúng thứ app này gọi là `gap_buy`/`gap_sell`.

| offset | kiểu | trường | Trạng thái |
|---|---|---|---|
| 0 | i32 | `subtype` = 1004 | Kiểm chứng |
| 12 | i64 | `DateTime.Ticks` | Kiểm chứng |
| 32 / 40 | f64 | `leg1.bid` / `leg1.ask` | **Kiểm chứng bằng số học** |
| 64 | i32 | `leg1.spread` (point) | **Kiểm chứng**: `(4333.52 − 4333.36) × 100 = 16` |
| 96 / 104 | f64 | `leg2.bid` / `leg2.ask` | **Kiểm chứng bằng số học** |
| 120 | i32 | `leg2.spread` (point) | **Kiểm chứng**: `(4333.71 − 4333.37) × 100 = 34` |
| 144 | i32 | `gap1` (point) | **Kiểm chứng**: `(leg1.bid − leg2.ask) × 100 = −35` |
| 148 | i32 | `gap2` (point) | **Kiểm chứng**: `(leg1.ask − leg2.bid) × 100 = 15` |

Quy ước dấu của họ **ngược chiều A/B** so với app này (`gap_buy = (B.bid − A.ask) × point`), nên
đừng gán nhãn buy/sell cho `gap1`/`gap2`. Các offset còn lại (16, 20, 24, 48, 56, 76–92, 128–140,
152–207) chưa giải mã — trong đó có vài `DateTime.Ticks` lặp lại và các hằng số `10000`, `1481`.

---

## Nhịp ghi: event-driven, không phải lấy mẫu định kỳ

Đây là điểm dễ hiểu nhầm nhất và đáng nhớ nhất.

| File | bản ghi/s | khoảng cách giữa 2 bản ghi | trùng bid/ask liền trước |
|---|---|---|---|
| Fast Feed Fix / Gold (Spot) | 17,1 | p50 = **12 ms**, p90 = 179, max = 2 336 | **0,0 %** (10/26 176) |
| MT5.00 / GOLD | 27,9 | p50 = **0 ms**, p90 = 101, max = 1 830 | **84,1 %** (36 019/42 812) |

`p50 = 0 ms` và những cụm tới **237 bản ghi cùng một mốc millisecond**, cộng với
`<SleepMs>1</SleepMs>` trong XML, cho thấy: họ chạy vòng lặp 1 ms và mỗi vòng **vét sạch hàng đợi
sự kiện** của MT5 API, ghi ra từng sự kiện với cùng một mốc thời gian của vòng lặp.

→ 84 % trùng bid/ask **không phải** do lấy mẫu thừa. Đó là vì MT5 API bắn sự kiện cả khi
top-of-book không đổi. Feed "Fast Feed Fix" thì gần như không có sự kiện thừa nào.

**Hệ quả cho app này:** vòng poll 30 ms chắc chắn bỏ sót tick. Vì vậy bản ghi `.gtick` từ version 2
lưu `ticksA`/`ticksB` — số tick đã xảy ra kể từ bản ghi trước, tính từ hiệu `quote_seq` — để
`ticks.mjs stats` báo được độ phủ thật của dữ liệu.

### Dung lượng

9,5 MB `.trace` + 7,1 MB `.ticks` cho **25,6 phút một cặp 3 feed** ≈ **39 MB/giờ**. Nhị phân nhưng
vẫn nặng, vì hai lý do: ghi mọi sự kiện (kể cả 84 % không mang thông tin mới), và dữ liệu giá bị
**ghi trùng ở cả hai luồng** (`.ticks` và `.trace` type 1).

---

## `.xml` — ảnh chụp cấu hình

XML tuần tự hóa `TradeModel` (`Guid`, `Algo`, `Title`, các khối `Open`/`Close`, ngưỡng...).
Đáng chú ý: `<SleepMs>1</SleepMs>`, `<Point>0.00001</Point>`, `<SaveTrace>true</SaveTrace>`.

**Cảnh báo:** XML ghi `<SaveTicks>false</SaveTicks>` và `<Log>false</Log>` **nhưng file `.ticks`
vẫn tồn tại** trong cùng thư mục. Nên XML là ảnh chụp cấu hình *tại thời điểm lưu*, không phải thứ
sinh ra đống file này. Không rút ra kết luận nào khác từ hai cờ đó.

---

## Ba điểm thiết kế, và vì sao `.gtick` làm khác

| TradeDesktop | `.gtick` của app này |
|---|---|
| Danh tính (feed, symbol, version) **chỉ ở tên file** | Header tự mô tả: magic `SHMTICK1` + version + khối JSON (map, symbol, point, ngưỡng, host, thời điểm). Đổi tên file không mất gì. |
| **Không có dấu đóng file** — không phân biệt được crash với kết thúc bình thường | Bản ghi điều khiển cuối file, kèm số bản ghi bị bỏ vì hàng đợi đầy |
| Ghi mọi sự kiện, 84 % không mang thông tin mới; dữ liệu giá trùng ở hai luồng | Chỉ ghi khi `quote_seq` đổi + heartbeat 1 Hz; `gap` suy ra được nên không lưu |
| 16/56 byte payload luôn bằng 0 | Mọi byte đều mang dữ liệu, còn 1 byte dự phòng |

Điểm nên học từ họ: khung `[type][size][payload]` cho phép **trộn nhiều loại bản ghi trong một
file** (tick, quyết định, log chữ) mà bộ đọc cũ vẫn bỏ qua được type lạ. `.gtick` dùng bản ghi cố
định 64 byte nên không có khả năng đó — đổi lại được tính chống hỏng: file bị cắt cụt chỉ mất bản
ghi cuối, còn ở khung `[type][size]` thì một `size` sai là lệch toàn bộ phần đuôi.
