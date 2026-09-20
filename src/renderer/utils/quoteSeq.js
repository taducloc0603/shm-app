// quote_seq của MT5 là bộ đếm quote kiểu uint32, tăng 1 mỗi tick và quay vòng khi tràn.
// Hiệu của hai lần đọc = số tick THẬT đã xảy ra giữa hai lần đó, kể cả những tick mà vòng poll
// 30 ms không kịp nhìn thấy.
//
// Dùng ở hai nơi: tính TPS trong vòng poll (app.js) và tính số tick bỏ sót ghi vào bản ghi
// .gtick (gapTickStream.js).

const UINT32_MOD = 2 ** 32;

/**
 * @returns {number|null} số tick giữa prevSeq và currSeq, null khi một trong hai không phải số.
 */
export function calcQuoteSeqDelta(currSeq, prevSeq) {
  if (!Number.isFinite(currSeq) || !Number.isFinite(prevSeq)) return null;
  if (currSeq >= prevSeq) return currSeq - prevSeq;
  // uint32 rollover
  return (UINT32_MOD - prevSeq) + currSeq;
}
