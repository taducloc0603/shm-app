// Quyết định LÚC NÀO ghi một bản ghi tick cho một cặp sàn, và đóng gói nó thành 64 byte.
//
// Poller chạy 30 ms/lần nhưng feed MT5 chỉ đổi giá vài lần mỗi giây: đo trên file mẫu của
// TradeDesktop, 84 % bản ghi có bid/ask y hệt bản ghi liền trước. Ghi mỗi lần poll là ghi thừa.
//
// Quy tắc:
// - Ghi khi quote_seq của A HOẶC B đổi (so số nguyên, chính xác tuyệt đối, không so float).
// - Ghi khi một phía đổi trạng thái có/không có dữ liệu.
// - Không có gì đổi thì vẫn ghi HEARTBEAT mỗi heartbeatMs. Đây là phần bắt buộc: thiếu nó thì
//   "giá đứng yên" và "app treo / feed chết" nhìn giống hệt nhau trong file.
// - Bản ghi cách bản ghi trước quá lâu (stallFactor lần heartbeatMs) được gắn cờ DATA_GAP.
//
// Poll 30 ms không thể thấy hết tick: feed của TradeDesktop là event-driven, có lúc bắn hàng trăm
// tick trong cùng một millisecond. Hiệu quote_seq so với LẦN GHI TRƯỚC cho biết đã có bao nhiêu
// tick, và con số đó đi vào bản ghi (ticksA/ticksB) để phân tích sau tính được độ phủ dữ liệu.
//
// Module thuần, không đụng DOM/IPC, để test được bằng Node thuần.

import { encodeGapTickRecord } from "./gapTickRecord.js";
import { calcQuoteSeqDelta } from "./quoteSeq.js";

export const DEFAULT_HEARTBEAT_MS = 1000;
const DEFAULT_STALL_FACTOR = 3;

// Một phía (A hoặc B) của bản ghi; map chưa có dữ liệu -> null (bản ghi tắt cờ *_VALID).
// spread không lưu vì suy ra được từ ask - bid.
export function toRecordSide(quote) {
  if (quote?.status !== "FOUND") return null;
  return {
    sym: quote.symbol,
    bid: Number(quote.bid),
    ask: Number(quote.ask),
    lat: quote.latencyMs,
    timeMsc: Number(quote.time_msc),
  };
}

// quote_seq là bộ đếm vòng quote của MT5: đổi = có tick mới. Thiếu quote_seq (fallback PowerShell
// cũ, hoặc map lỗi) thì lùi về so giá + time_msc để không im lặng bỏ hết bản ghi.
function changeKeyOf(quote, side) {
  if (!side) return "none";
  const seq = seqOf(quote);
  if (seq !== null) return `s${seq}`;
  return `v${side.bid}|${side.ask}|${side.timeMsc}`;
}

function seqOf(quote) {
  const seq = Number(quote?.quote_seq);
  return Number.isFinite(seq) ? seq : null;
}

// Số tick đã xảy ra kể từ lần ghi trước. Bản ghi đầu tiên chưa có mốc so sánh nhưng vẫn đang cầm
// một tick trên tay -> 1. Không có quote_seq thì không đo được -> 0 (bên đọc hiểu là "không biết").
function ticksSince(currSeq, prevSeq) {
  if (currSeq === null) return 0;
  if (prevSeq === null) return 1;
  const delta = calcQuoteSeqDelta(currSeq, prevSeq);
  return delta === null ? 0 : Math.max(0, delta);
}

/**
 * @param {{ heartbeatMs?: number, stallFactor?: number }} [options]
 */
export function createPairTickStream(options = {}) {
  const heartbeatMs = Number.isFinite(Number(options.heartbeatMs))
    ? Number(options.heartbeatMs)
    : DEFAULT_HEARTBEAT_MS;
  const stallFactor = Number(options.stallFactor) || DEFAULT_STALL_FACTOR;

  let lastKeyA = null;
  let lastKeyB = null;
  let lastSeqA = null;
  let lastSeqB = null;
  let lastEmitAt = null;
  const scratch = new Uint8Array(64); // dùng lại đệm; giá trị được sao chép ngay khi tạo ArrayBuffer

  return {
    /**
     * @param {object|null} quoteA quote đã chuẩn hóa của sàn A (như trong quoteByMap)
     * @param {object|null} quoteB
     * @param {number} nowMs
     * @returns {{ bytes: ArrayBuffer, symA?: string, symB?: string, heartbeat: boolean,
     *             ticksA: number, ticksB: number }|null}
     *   null = lần poll này không cần ghi gì.
     */
    next(quoteA, quoteB, nowMs) {
      const a = toRecordSide(quoteA);
      const b = toRecordSide(quoteB);
      const keyA = changeKeyOf(quoteA, a);
      const keyB = changeKeyOf(quoteB, b);

      const changed = keyA !== lastKeyA || keyB !== lastKeyB;
      const sinceLast = lastEmitAt === null ? Infinity : nowMs - lastEmitAt;
      const dueHeartbeat = sinceLast >= heartbeatMs;
      if (!changed && !dueHeartbeat) return null;

      const seqA = seqOf(quoteA);
      const seqB = seqOf(quoteB);
      const ticksA = ticksSince(seqA, lastSeqA);
      const ticksB = ticksSince(seqB, lastSeqB);

      // a/b là object vừa tạo trong lần gọi này nên gán thẳng, không cần sao chép.
      if (a) a.ticks = ticksA;
      if (b) b.ticks = ticksB;

      const record = encodeGapTickRecord(
        {
          wallMs: nowMs,
          a,
          b,
          heartbeat: !changed,
          dataGap: lastEmitAt !== null && sinceLast > heartbeatMs * stallFactor,
        },
        scratch
      );

      lastKeyA = keyA;
      lastKeyB = keyB;
      if (seqA !== null) lastSeqA = seqA;
      if (seqB !== null) lastSeqB = seqB;
      lastEmitAt = nowMs;

      // slice() tạo bản sao rời khỏi scratch — bắt buộc vì mục nằm trong hàng đợi tới lúc flush.
      return {
        bytes: record.slice().buffer,
        symA: a?.sym,
        symB: b?.sym,
        heartbeat: !changed,
        ticksA,
        ticksB,
      };
    },

    reset() {
      lastKeyA = null;
      lastKeyB = null;
      lastSeqA = null;
      lastSeqB = null;
      lastEmitAt = null;
    },
  };
}
