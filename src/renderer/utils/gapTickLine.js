// Định dạng một dòng log tick của một cặp sàn. Port 1-1 từ GapTickLineFormatter (TradeDesktop)
// để hai app cùng dùng được một công cụ phân tích log.
//
// [HH:mm:ss.fff] [GAP_TICK] gap_buy= gap_sell= a_sym= a_bid= a_ask= a_spread= a_lat= b_sym= b_bid= b_ask= b_spread= b_lat= point=
//
// - timestamp là giờ LOCAL của máy tại lúc poll (không phải giờ tick của broker).
// - giá trị thiếu / không hợp lệ ghi "-".
// - số luôn dùng dấu "." (không phụ thuộc locale).

export const MISSING_VALUE = "-";

function pad(value, length) {
  return String(value).padStart(length, "0");
}

export function formatTickTime(timeMs) {
  const d = new Date(Number(timeMs));
  if (Number.isNaN(d.getTime())) return MISSING_VALUE;
  return `${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)}.${pad(d.getMilliseconds(), 3)}`;
}

function formatNumber(value) {
  if (value === null || value === undefined || value === "") return MISSING_VALUE;
  const n = Number(value);
  if (!Number.isFinite(n)) return MISSING_VALUE;
  // Khử sai số dấu phẩy động (vd ask-bid = 0.20000000000027285 -> 0.2); 10 chữ số thập phân dư cho mọi giá.
  // String(n) luôn dùng "." và không có dấu phân cách hàng nghìn; "+ 0" đổi -0 thành 0.
  return String(Number(n.toFixed(10)) + 0);
}

function formatGap(value) {
  if (value === null || value === undefined || value === "") return MISSING_VALUE;
  const n = Number(value);
  // Gap tính bằng point; làm tròn để khử sai số dấu phẩy động (vd 11.999999999).
  return Number.isFinite(n) ? String(Math.round(n)) : MISSING_VALUE;
}

function formatLatency(value) {
  if (value === null || value === undefined || value === "") return MISSING_VALUE;
  const n = Number(value);
  return Number.isFinite(n) ? String(Math.round(n)) : MISSING_VALUE;
}

function formatSymbol(value) {
  const s = String(value ?? "").trim();
  return s ? s : MISSING_VALUE;
}

function formatSide(prefix, side) {
  const q = side || {};
  return (
    `${prefix}_sym=${formatSymbol(q.sym)} ` +
    `${prefix}_bid=${formatNumber(q.bid)} ` +
    `${prefix}_ask=${formatNumber(q.ask)} ` +
    `${prefix}_spread=${formatNumber(q.spread)} ` +
    `${prefix}_lat=${formatLatency(q.lat)}`
  );
}

/**
 * @param {{ timeMs: number, gapBuy?: number|null, gapSell?: number|null,
 *           a?: { sym?: string, bid?: number, ask?: number, spread?: number, lat?: number },
 *           b?: { sym?: string, bid?: number, ask?: number, spread?: number, lat?: number },
 *           point?: number }} tick
 */
export function formatGapTickLine(tick) {
  const t = tick || {};
  return (
    `[${formatTickTime(t.timeMs)}] [GAP_TICK] ` +
    `gap_buy=${formatGap(t.gapBuy)} gap_sell=${formatGap(t.gapSell)} ` +
    `${formatSide("a", t.a)} ` +
    `${formatSide("b", t.b)} ` +
    `point=${formatNumber(t.point)}`
  );
}
