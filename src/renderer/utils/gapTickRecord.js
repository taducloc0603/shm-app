// Bản ghi tick nhị phân của một cặp sàn: 64 byte cố định, little-endian.
//
// Mọi bản ghi trong một file đều cùng kích thước và KHÔNG mã hóa delta: file bị cắt cụt
// (crash, mất điện) chỉ mất bản ghi cuối, phần trước vẫn đọc được bình thường.
//
//   off  0  f64  wallMs     Date.now() lúc poll (epoch ms; f64 đủ chính xác tới năm 287396)
//   off  8  f64  timeMscA   time_msc thô của sàn A đúng như app nhận được (NaN = không có)
//   off 16  f64  timeMscB   time_msc thô của sàn B
//   off 24  f64  bidA       (NaN = không có)
//   off 32  f64  askA
//   off 40  f64  bidB
//   off 48  f64  askB
//   off 56  u16  latA       ms đã làm tròn; LAT_MISSING = không có
//   off 58  u16  latB
//   off 60  u8   flags      xem FLAG_*
//   off 61  u8   ticksA     số tick của A đã xảy ra KỂ TỪ bản ghi trước (0 = không có tick mới,
//                           1 = bắt đúng một tick, N = có N tick nhưng chỉ thấy cái cuối); xem TICKS_MAX
//   off 62  u8   ticksB
//   off 63  u8   dự phòng
//
// Suy ra được nên KHÔNG lưu: spread = ask - bid; gap_buy = (bidB - askA) * point;
// gap_sell = (askB - bidA) * point; symbol / point / host nằm ở header file.
//
// File này chạy được cả trong renderer (không có Buffer vì contextIsolation) lẫn Node thuần:
// chỉ dùng ArrayBuffer/DataView/Uint8Array.

export const RECORD_SIZE = 64;

export const OFF_WALL_MS = 0;
export const OFF_TIME_MSC_A = 8;
export const OFF_TIME_MSC_B = 16;
export const OFF_BID_A = 24;
export const OFF_ASK_A = 32;
export const OFF_BID_B = 40;
export const OFF_ASK_B = 48;
export const OFF_LAT_A = 56;
export const OFF_LAT_B = 58;
export const OFF_FLAGS = 60;
export const OFF_TICKS_A = 61;
export const OFF_TICKS_B = 62;

export const FLAG_A_VALID = 1 << 0;
export const FLAG_B_VALID = 1 << 1;
export const FLAG_HEARTBEAT = 1 << 2; // ghi dù không có tick mới, để phân biệt "giá đứng yên" với "app treo"
export const FLAG_DATA_GAP = 1 << 3; // nghi ngờ mất dữ liệu ngay trước bản ghi này

export const LAT_MISSING = 0xffff;
const LAT_MAX = 0xfffe;

// Vòng poll 30 ms không thấy hết tick của feed; hiệu quote_seq cho biết đã có bao nhiêu tick.
// Lưu SỐ TICK chứ không lưu "số bỏ sót": 0 và 1 phải phân biệt được thì mới tính ra độ phủ
// (bao nhiêu bản ghi bắt được tick / tổng số tick thật). Trường 1 byte nên 255 nghĩa là ">= 255".
export const TICKS_MAX = 255;

const LITTLE_ENDIAN = true;

function numberOrNaN(value) {
  if (value === null || value === undefined || value === "") return NaN;
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

function encodeLatency(value) {
  const n = numberOrNaN(value);
  if (!Number.isFinite(n)) return LAT_MISSING;
  const rounded = Math.round(n);
  if (rounded <= 0) return 0;
  return rounded > LAT_MAX ? LAT_MAX : rounded;
}

function decodeLatency(raw) {
  return raw === LAT_MISSING ? null : raw;
}

function encodeTicks(value) {
  const n = numberOrNaN(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const rounded = Math.round(n);
  return rounded > TICKS_MAX ? TICKS_MAX : rounded;
}

/**
 * @param {{ wallMs: number,
 *           a?: { bid?: number, ask?: number, lat?: number, timeMsc?: number, ticks?: number }|null,
 *           b?: { bid?: number, ask?: number, lat?: number, timeMsc?: number, ticks?: number }|null,
 *           heartbeat?: boolean, dataGap?: boolean }} tick
 *   a / b là null (hoặc bỏ trống) khi phía đó không có dữ liệu ở lần poll này.
 * @param {Uint8Array} [out] đệm sẵn 64 byte để tránh cấp phát trong vòng poll.
 * @returns {Uint8Array} đúng 64 byte.
 */
export function encodeGapTickRecord(tick, out) {
  const bytes = out && out.byteLength >= RECORD_SIZE ? out : new Uint8Array(RECORD_SIZE);
  const view = new DataView(bytes.buffer, bytes.byteOffset, RECORD_SIZE);
  const t = tick || {};
  const a = t.a || null;
  const b = t.b || null;

  let flags = 0;
  if (a) flags |= FLAG_A_VALID;
  if (b) flags |= FLAG_B_VALID;
  if (t.heartbeat) flags |= FLAG_HEARTBEAT;
  if (t.dataGap) flags |= FLAG_DATA_GAP;

  view.setFloat64(OFF_WALL_MS, numberOrNaN(t.wallMs), LITTLE_ENDIAN);
  view.setFloat64(OFF_TIME_MSC_A, a ? numberOrNaN(a.timeMsc) : NaN, LITTLE_ENDIAN);
  view.setFloat64(OFF_TIME_MSC_B, b ? numberOrNaN(b.timeMsc) : NaN, LITTLE_ENDIAN);
  view.setFloat64(OFF_BID_A, a ? numberOrNaN(a.bid) : NaN, LITTLE_ENDIAN);
  view.setFloat64(OFF_ASK_A, a ? numberOrNaN(a.ask) : NaN, LITTLE_ENDIAN);
  view.setFloat64(OFF_BID_B, b ? numberOrNaN(b.bid) : NaN, LITTLE_ENDIAN);
  view.setFloat64(OFF_ASK_B, b ? numberOrNaN(b.ask) : NaN, LITTLE_ENDIAN);
  view.setUint16(OFF_LAT_A, a ? encodeLatency(a.lat) : LAT_MISSING, LITTLE_ENDIAN);
  view.setUint16(OFF_LAT_B, b ? encodeLatency(b.lat) : LAT_MISSING, LITTLE_ENDIAN);
  view.setUint8(OFF_FLAGS, flags);
  view.setUint8(OFF_TICKS_A, a ? encodeTicks(a.ticks) : 0);
  view.setUint8(OFF_TICKS_B, b ? encodeTicks(b.ticks) : 0);
  view.setUint8(63, 0);

  return bytes;
}

/**
 * @param {Uint8Array} bytes
 * @param {number} [offset] vị trí đầu bản ghi trong bytes.
 */
export function decodeGapTickRecord(bytes, offset = 0) {
  if (!bytes || bytes.byteLength - offset < RECORD_SIZE) {
    throw new Error(`decodeGapTickRecord: thiếu byte tại offset ${offset}.`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, RECORD_SIZE);
  const flags = view.getUint8(OFF_FLAGS);

  return {
    wallMs: view.getFloat64(OFF_WALL_MS, LITTLE_ENDIAN),
    flags,
    aValid: (flags & FLAG_A_VALID) !== 0,
    bValid: (flags & FLAG_B_VALID) !== 0,
    heartbeat: (flags & FLAG_HEARTBEAT) !== 0,
    dataGap: (flags & FLAG_DATA_GAP) !== 0,
    a: (flags & FLAG_A_VALID) === 0 ? null : {
      bid: view.getFloat64(OFF_BID_A, LITTLE_ENDIAN),
      ask: view.getFloat64(OFF_ASK_A, LITTLE_ENDIAN),
      lat: decodeLatency(view.getUint16(OFF_LAT_A, LITTLE_ENDIAN)),
      timeMsc: view.getFloat64(OFF_TIME_MSC_A, LITTLE_ENDIAN),
      ticks: view.getUint8(OFF_TICKS_A),
    },
    b: (flags & FLAG_B_VALID) === 0 ? null : {
      bid: view.getFloat64(OFF_BID_B, LITTLE_ENDIAN),
      ask: view.getFloat64(OFF_ASK_B, LITTLE_ENDIAN),
      lat: decodeLatency(view.getUint16(OFF_LAT_B, LITTLE_ENDIAN)),
      timeMsc: view.getFloat64(OFF_TIME_MSC_B, LITTLE_ENDIAN),
      ticks: view.getUint8(OFF_TICKS_B),
    },
  };
}

// Gap chỉ có khi CẢ HAI phía có dữ liệu — cùng điều kiện với calcPairGaps trong poller.
export function calcRecordGaps(record, point) {
  const p = Number(point);
  if (!record?.a || !record?.b || !Number.isFinite(p)) return { gapBuy: null, gapSell: null };
  const { bid: bidA, ask: askA } = record.a;
  const { bid: bidB, ask: askB } = record.b;
  if (![bidA, askA, bidB, askB].every(Number.isFinite)) return { gapBuy: null, gapSell: null };

  const gapBuy = (bidB - askA) * p;
  const gapSell = (askB - bidA) * p;
  if (!Number.isFinite(gapBuy) || !Number.isFinite(gapSell)) return { gapBuy: null, gapSell: null };
  return { gapBuy, gapSell };
}

// Dựng lại đúng object mà formatGapTickLine nhận, để xuất ra file text tương thích công cụ cũ.
export function toGapTickLineInput(record, { symA, symB, point } = {}) {
  const { gapBuy, gapSell } = calcRecordGaps(record, point);
  const side = (q, sym) =>
    q ? { sym, bid: q.bid, ask: q.ask, spread: q.ask - q.bid, lat: q.lat } : {};

  return {
    timeMs: record.wallMs,
    gapBuy,
    gapSell,
    a: side(record.a, symA),
    b: side(record.b, symB),
    point,
  };
}

// ----------------------------------------------------------------------------
// Bản ghi điều khiển: cùng 64 byte, phân biệt bằng FLAG_CONTROL, không mang giá.
// Dùng để đánh dấu đóng file sạch (phân biệt với file bị cắt cụt do crash) và
// số dòng đã bỏ vì hàng đợi đầy. Bộ đọc chỉ quan tâm giá thì lọc bỏ cờ này.
//
//   OFF_BID_A  f64  controlCode (CONTROL_*)
//   OFF_ASK_A  f64  dropped (số bản ghi bị bỏ, chính xác tới 2^53)
// ----------------------------------------------------------------------------

export const FLAG_CONTROL = 1 << 4;

export const CONTROL_SESSION_END = 1; // phiên đóng bình thường (Stop / thoát app)
export const CONTROL_PART_END = 2; // file đầy, ghi tiếp sang part kế tiếp

export function encodeControlRecord({ wallMs, code, dropped = 0 }, out) {
  const bytes = out && out.byteLength >= RECORD_SIZE ? out : new Uint8Array(RECORD_SIZE);
  bytes.fill(0, 0, RECORD_SIZE);
  const view = new DataView(bytes.buffer, bytes.byteOffset, RECORD_SIZE);

  view.setFloat64(OFF_WALL_MS, numberOrNaN(wallMs), LITTLE_ENDIAN);
  view.setFloat64(OFF_BID_A, Number(code) || 0, LITTLE_ENDIAN);
  view.setFloat64(OFF_ASK_A, Number(dropped) || 0, LITTLE_ENDIAN);
  view.setUint16(OFF_LAT_A, LAT_MISSING, LITTLE_ENDIAN);
  view.setUint16(OFF_LAT_B, LAT_MISSING, LITTLE_ENDIAN);
  view.setUint8(OFF_FLAGS, FLAG_CONTROL);

  return bytes;
}

export function isControlRecord(record) {
  return ((record?.flags ?? 0) & FLAG_CONTROL) !== 0;
}

export function decodeControlRecord(bytes, offset = 0) {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, RECORD_SIZE);
  return {
    wallMs: view.getFloat64(OFF_WALL_MS, LITTLE_ENDIAN),
    code: view.getFloat64(OFF_BID_A, LITTLE_ENDIAN),
    dropped: view.getFloat64(OFF_ASK_A, LITTLE_ENDIAN),
  };
}
