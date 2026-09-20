// Đọc file tick nhị phân (.gtick) theo luồng, không nạp cả file vào RAM: một part có thể tới 50 MB
// và một phiên có nhiều part cho nhiều cặp.
//
// Chạy bằng Node thuần (không cần Electron) để dùng được trong test và trong tools/ticks.mjs.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import {
  RECORD_SIZE,
  decodeGapTickRecord,
  decodeControlRecord,
  isControlRecord,
} from "../src/renderer/utils/gapTickRecord.js";

const require = createRequire(import.meta.url);
const { parseFileHeader, FIXED_HEADER_SIZE, CONTROL_SESSION_END, CONTROL_PART_END } = require("../src/main/gapTickFile.js");

const READ_CHUNK_BYTES = 1 << 20;

function readHeader(fd, fileSize) {
  // JSON header hiếm khi quá 4 KB; đọc rộng tay rồi cắt theo byteLength đã khai báo.
  const probeSize = Math.min(fileSize, 64 * 1024);
  const probe = Buffer.alloc(probeSize);
  fs.readSync(fd, probe, 0, probeSize, 0);

  const header = parseFileHeader(probe);
  if (header.byteLength > fileSize) {
    throw new Error("File tick không hợp lệ: header dài hơn cả file.");
  }
  return header;
}

// v1 không có trường ticksA/ticksB: byte đó luôn = 0, nhưng 0 ở v1 nghĩa là "không biết"
// chứ không phải "không có tick nào". Trả null để bên phân tích không hiểu nhầm.
function applyVersion(record, version) {
  if (version >= 2) return record;
  if (record.a) record.a.ticks = null;
  if (record.b) record.b.ticks = null;
  return record;
}

/**
 * Duyệt từng bản ghi của một file .gtick.
 * @param {string} filePath
 * @yields {{ index: number, offset: number, record: object, control: object|null, version: number }}
 */
export function* iterateRecords(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const fileSize = fs.fstatSync(fd).size;
    const header = readHeader(fd, fileSize);

    let position = header.byteLength;
    let index = 0;
    const buf = Buffer.alloc(READ_CHUNK_BYTES);

    while (position + RECORD_SIZE <= fileSize) {
      const want = Math.min(READ_CHUNK_BYTES, fileSize - position);
      const got = fs.readSync(fd, buf, 0, want, position);
      if (got < RECORD_SIZE) break;

      const usable = got - (got % RECORD_SIZE);
      const view = new Uint8Array(buf.buffer, buf.byteOffset, usable);
      for (let off = 0; off < usable; off += RECORD_SIZE) {
        const record = applyVersion(decodeGapTickRecord(view, off), header.version);
        const control = isControlRecord(record) ? decodeControlRecord(view, off) : null;
        yield { index: index++, offset: position + off, record, control, version: header.version };
      }
      position += usable;
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** Header + thống kê khung file, không duyệt hết bản ghi. */
export function readFileInfo(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const fileSize = fs.fstatSync(fd).size;
    const header = readHeader(fd, fileSize);
    const dataBytes = fileSize - header.byteLength;

    return {
      filePath,
      fileName: path.basename(filePath),
      fileSize,
      meta: header.meta,
      version: header.version,
      headerBytes: header.byteLength,
      jsonBytes: header.byteLength - FIXED_HEADER_SIZE,
      recordCount: Math.floor(dataBytes / RECORD_SIZE),
      // > 0 nghĩa là file bị cắt ngang một bản ghi (crash / mất điện); phần trước vẫn đọc được.
      trailingBytes: dataBytes % RECORD_SIZE,
    };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Duyệt hết file một lượt để biết file đóng sạch hay bị cắt cụt.
 * @returns {{ closedCleanly: boolean, partEnded: boolean, dropped: number,
 *             dataRecords: number, controlRecords: number,
 *             firstWallMs: number|null, lastWallMs: number|null }}
 */
export function scanFile(filePath) {
  let closedCleanly = false;
  let partEnded = false;
  let dropped = 0;
  let dataRecords = 0;
  let controlRecords = 0;
  let firstWallMs = null;
  let lastWallMs = null;

  for (const { record, control } of iterateRecords(filePath)) {
    if (control) {
      controlRecords += 1;
      if (control.code === CONTROL_SESSION_END) {
        closedCleanly = true;
        dropped = control.dropped;
      } else if (control.code === CONTROL_PART_END) {
        partEnded = true;
      }
      continue;
    }
    dataRecords += 1;
    if (Number.isFinite(record.wallMs)) {
      if (firstWallMs === null) firstWallMs = record.wallMs;
      lastWallMs = record.wallMs;
    }
  }

  return { closedCleanly, partEnded, dropped, dataRecords, controlRecords, firstWallMs, lastWallMs };
}

// Các part của cùng một phiên/cặp, theo đúng thứ tự ghi: base, .001, .002 ...
export function listParts(filePath) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath).replace(/(\.\d{3})?\.gtick$/, "");
  const parts = fs
    .readdirSync(dir)
    .filter((name) => name === `${base}.gtick` || new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.\\d{3}\\.gtick$`).test(name))
    .sort((a, b) => (a.length - b.length) || a.localeCompare(b));
  return parts.map((name) => path.join(dir, name));
}
