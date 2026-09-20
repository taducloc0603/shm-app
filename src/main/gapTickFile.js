// Header của file tick nhị phân (.gtick). Tự mô tả để file cũ không bị đọc sai khi schema đổi:
// decoder từ chối file sai magic hoặc sai version thay vì diễn giải bừa.
//
//   off  0  8 B   magic "SHMTICK1"
//   off  8  u16   version
//   off 10  u16   recordSize
//   off 12  u32   jsonLen
//   off 16  ...   JSON UTF-8 (mapA, mapB, symA, symB, group, point, host, startedAtMs,
//                             tzOffsetMin, part, baseFile)
//   đệm 0x00 tới bội số RECORD_SIZE để mọi bản ghi nằm đúng biên 64 byte.
//
// RECORD_SIZE lặp lại giá trị trong src/renderer/utils/gapTickRecord.js (renderer là ESM, main là
// CJS nên không require chéo được); test/gapTickRecord.test.mjs canh hai bên không lệch nhau.

const MAGIC = "SHMTICK1";
const MAGIC_BYTES = Buffer.from(MAGIC, "ascii");
const FORMAT_VERSION = 2;
// v1: byte 61-63 của bản ghi là dự phòng và luôn = 0.
// v2: byte 61 = ticksA, byte 62 = ticksB — số tick của sàn đó đã xảy ra KỂ TỪ bản ghi trước
//     (0 = không có tick mới, 1 = bắt đúng một tick, N = có N tick nhưng chỉ thấy cái cuối).
//     Bộ đọc vẫn mở được file v1, nhưng phải báo "không biết" thay vì 0 cho hai trường đó, vì
//     ở v1 byte đó luôn bằng 0 bất kể thực tế.
const SUPPORTED_VERSIONS = new Set([1, 2]);
const RECORD_SIZE = 64;
const FIXED_HEADER_SIZE = 16;
const FILE_EXT = ".gtick";

function alignUp(value, align) {
  const rem = value % align;
  return rem === 0 ? value : value + (align - rem);
}

/**
 * @param {{ mapA?: string, mapB?: string, symA?: string|null, symB?: string|null,
 *           group?: string, point?: number, host?: string, startedAtMs?: number,
 *           tzOffsetMin?: number, part?: number, baseFile?: string }} meta
 * @returns {Buffer} độ dài là bội số của RECORD_SIZE.
 */
function encodeFileHeader(meta = {}) {
  const json = Buffer.from(JSON.stringify(meta ?? {}), "utf8");
  const size = alignUp(FIXED_HEADER_SIZE + json.length, RECORD_SIZE);
  const buf = Buffer.alloc(size); // alloc (không alloc Unsafe) để phần đệm luôn là 0x00

  MAGIC_BYTES.copy(buf, 0);
  buf.writeUInt16LE(FORMAT_VERSION, 8);
  buf.writeUInt16LE(RECORD_SIZE, 10);
  buf.writeUInt32LE(json.length, 12);
  json.copy(buf, FIXED_HEADER_SIZE);

  return buf;
}

/**
 * @param {Buffer} buf toàn bộ file (hoặc ít nhất phần header).
 * @returns {{ meta: object, byteLength: number, version: number, recordSize: number }}
 */
function parseFileHeader(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < FIXED_HEADER_SIZE) {
    throw new Error("File tick không hợp lệ: quá ngắn để chứa header.");
  }
  if (buf.subarray(0, 8).toString("ascii") !== MAGIC) {
    throw new Error(`File tick không hợp lệ: thiếu magic "${MAGIC}".`);
  }

  const version = buf.readUInt16LE(8);
  if (!SUPPORTED_VERSIONS.has(version)) {
    throw new Error(
      `File tick version ${version}, bộ giải mã này chỉ đọc version ${[...SUPPORTED_VERSIONS].join(", ")}.`
    );
  }

  const recordSize = buf.readUInt16LE(10);
  if (recordSize !== RECORD_SIZE) {
    throw new Error(`File tick khai báo recordSize=${recordSize}, mong đợi ${RECORD_SIZE}.`);
  }

  const jsonLen = buf.readUInt32LE(12);
  const end = FIXED_HEADER_SIZE + jsonLen;
  if (end > buf.length) {
    throw new Error("File tick không hợp lệ: header JSON bị cắt cụt.");
  }

  let meta;
  try {
    meta = JSON.parse(buf.subarray(FIXED_HEADER_SIZE, end).toString("utf8"));
  } catch (err) {
    throw new Error(`File tick không hợp lệ: header JSON hỏng (${err?.message || err}).`);
  }

  return { meta, byteLength: alignUp(end, RECORD_SIZE), version, recordSize };
}


// Bản ghi điều khiển (64 B, cờ FLAG_CONTROL) — đánh dấu đóng file sạch / hết part.
// Mirror của encodeControlRecord trong src/renderer/utils/gapTickRecord.js vì main là CJS;
// test/gapTickRecord.test.mjs so byte của hai bên để chúng không lệch nhau.
const FLAG_CONTROL = 1 << 4;
const CONTROL_SESSION_END = 1;
const CONTROL_PART_END = 2;
const OFF_WALL_MS = 0;
const OFF_BID_A = 24;
const OFF_ASK_A = 32;
const OFF_LAT_A = 56;
const OFF_LAT_B = 58;
const OFF_FLAGS = 60;
const LAT_MISSING = 0xffff;

function encodeControlRecord({ wallMs, code, dropped = 0 } = {}) {
  const buf = Buffer.alloc(RECORD_SIZE);
  buf.writeDoubleLE(Number(wallMs), OFF_WALL_MS);
  buf.writeDoubleLE(Number(code) || 0, OFF_BID_A);
  buf.writeDoubleLE(Number(dropped) || 0, OFF_ASK_A);
  buf.writeUInt16LE(LAT_MISSING, OFF_LAT_A);
  buf.writeUInt16LE(LAT_MISSING, OFF_LAT_B);
  buf.writeUInt8(FLAG_CONTROL, OFF_FLAGS);
  return buf;
}

module.exports = {
  MAGIC,
  FORMAT_VERSION,
  SUPPORTED_VERSIONS,
  RECORD_SIZE,
  FIXED_HEADER_SIZE,
  FILE_EXT,
  encodeFileHeader,
  parseFileHeader,
  encodeControlRecord,
  FLAG_CONTROL,
  CONTROL_SESSION_END,
  CONTROL_PART_END,
};
