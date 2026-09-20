// Đọc file .ticks / .trace của TradeDesktop (Madeo) theo luồng.
//
// Khung chung cho cả hai loại file, little-endian, KHÔNG có header file, không magic, không version:
//
//   [i32 recordType][i32 payloadSize][payload đúng payloadSize byte]   nối đuôi nhau
//
// Vì không có magic để nhận dạng, cách kiểm tra duy nhất là đi hết khung: nếu con trỏ dừng đúng
// byte cuối file thì giả thiết đúng. iterateMadeoRecords() trả về cờ đó để bên gọi báo lỗi rõ ràng.
//
// Chi tiết từng trường: docs/tradedesktop-binary-format.md

import fs from "node:fs";

const READ_CHUNK_BYTES = 1 << 20;
const FRAME_HEADER_SIZE = 8;
// Bản ghi lớn nhất gặp trong file mẫu là 406 byte; đặt trần rộng tay để bắt được khung hỏng
// thay vì cấp phát theo một con số rác đọc từ file.
const MAX_RECORD_SIZE = 1 << 20;

export const TYPE_TICK = 100; // .ticks
export const TYPE_PAIR_SNAPSHOT = 1; // .trace
export const TYPE_LOG = 1000; // .trace

// .NET DateTime.Ticks: đơn vị 100 ns, gốc 0001-01-01.
const NET_EPOCH_OFFSET_MS = -62135596800000;

export function ticksToMs(ticks) {
  return Number(ticks / 10000n) + NET_EPOCH_OFFSET_MS;
}

/**
 * @param {string} filePath
 * @yields {{ index: number, offset: number, type: number, size: number, payload: Buffer }}
 *   Payload là bản sao riêng, an toàn để giữ lại sau vòng lặp.
 */
export function* iterateMadeoRecords(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const fileSize = fs.fstatSync(fd).size;
    const chunk = Buffer.alloc(READ_CHUNK_BYTES);
    let pending = Buffer.alloc(0);
    let position = 0;
    let consumed = 0;
    let index = 0;

    while (true) {
      if (position < fileSize) {
        const want = Math.min(READ_CHUNK_BYTES, fileSize - position);
        const got = fs.readSync(fd, chunk, 0, want, position);
        if (got <= 0) break;
        position += got;
        pending = pending.length ? Buffer.concat([pending, chunk.subarray(0, got)]) : Buffer.from(chunk.subarray(0, got));
      }

      let off = 0;
      while (off + FRAME_HEADER_SIZE <= pending.length) {
        const type = pending.readInt32LE(off);
        const size = pending.readInt32LE(off + 4);
        if (size < 0 || size > MAX_RECORD_SIZE) {
          throw new Error(
            `Khung hỏng tại offset ${consumed + off}: payloadSize = ${size} (type ${type}). ` +
              "File có thể không phải định dạng Madeo, hoặc là version khác."
          );
        }
        if (off + FRAME_HEADER_SIZE + size > pending.length) break; // chờ đọc thêm
        yield {
          index: index++,
          offset: consumed + off,
          type,
          size,
          payload: Buffer.from(pending.subarray(off + FRAME_HEADER_SIZE, off + FRAME_HEADER_SIZE + size)),
        };
        off += FRAME_HEADER_SIZE + size;
      }

      pending = pending.subarray(off);
      consumed += off;
      if (position >= fileSize) break;
    }

    if (pending.length) {
      throw new Error(
        `Dư ${pending.length} byte ở cuối file (offset ${consumed}): bản ghi cuối bị cắt ngang ` +
          "hoặc khung không khớp từ trước đó."
      );
    }
  } finally {
    fs.closeSync(fd);
  }
}

// --- .ticks, type 100, payload 56 byte -------------------------------------
// Hai double ở offset 16 và 24 luôn bằng 0 trong toàn bộ file mẫu (chỗ dành cho last/volume
// chưa dùng). durMs và field52 là SUY ĐOÁN, xem docs/tradedesktop-binary-format.md.

export function decodeTickPayload(payload) {
  if (payload.length < 56) throw new Error(`Bản ghi tick chỉ có ${payload.length} byte, cần 56.`);
  return {
    schemaTag: payload.readInt32LE(0), // hằng số 1001 ở mọi file mẫu
    bid: payload.readDoubleLE(4),
    ask: payload.readDoubleLE(12),
    unused1: payload.readDoubleLE(20),
    unused2: payload.readDoubleLE(28),
    timeMs: ticksToMs(payload.readBigInt64LE(36)),
    durMs: payload.readDoubleLE(44), // suy đoán: thời lượng xử lý (Stopwatch)
    field52: payload.readInt32LE(52), // chưa giải thích được
  };
}

// --- .trace, type 1000: dòng log chữ ---------------------------------------
// [i32 subtype][i32 strLen][chuỗi UTF-8 kết thúc bằng NUL][i32 mức độ][i64 DateTime.Ticks]

export function decodeLogPayload(payload) {
  const subtype = payload.readInt32LE(0);
  const strLen = payload.readInt32LE(4);
  const end = 8 + strLen;
  if (end + 12 > payload.length) throw new Error("Bản ghi log có độ dài chuỗi không khớp payload.");
  return {
    subtype,
    text: payload.subarray(8, end).toString("utf8").replace(/\0+$/, ""),
    level: payload.readInt32LE(end), // 0 = info, 2 = error (quan sát được trên file mẫu)
    timeMs: ticksToMs(payload.readBigInt64LE(end + 4)),
  };
}

// --- .trace, type 1: ảnh chụp của CẶP + quyết định, payload 232 byte --------
// Chỉ đọc các offset đã kiểm chứng bằng số học trên dữ liệu thật:
//   (leg1.bid − leg2.ask) × point = giá trị tại 144, (leg1.ask − leg2.bid) × point = giá trị tại 148.
// Phần còn lại của bản ghi chưa giải mã, cố tình không đoán.

export function decodePairSnapshotPayload(payload) {
  if (payload.length < 232) throw new Error(`Bản ghi cặp chỉ có ${payload.length} byte, cần 232.`);
  return {
    subtype: payload.readInt32LE(0),
    timeMs: ticksToMs(payload.readBigInt64LE(12)),
    leg1: {
      bid: payload.readDoubleLE(32),
      ask: payload.readDoubleLE(40),
      spreadPts: payload.readInt32LE(64),
    },
    leg2: {
      bid: payload.readDoubleLE(96),
      ask: payload.readDoubleLE(104),
      spreadPts: payload.readInt32LE(120),
    },
    // Quy ước dấu của HỌ: gap1 = (leg1.bid − leg2.ask) × point, gap2 = (leg1.ask − leg2.bid) × point.
    // Ngược chiều A/B so với gap_buy/gap_sell của app này — đừng gán nhãn buy/sell cho chúng.
    gap1Pts: payload.readInt32LE(144),
    gap2Pts: payload.readInt32LE(148),
  };
}
