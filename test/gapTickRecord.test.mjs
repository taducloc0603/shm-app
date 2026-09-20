import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import {
  RECORD_SIZE,
  FLAG_A_VALID,
  FLAG_B_VALID,
  FLAG_HEARTBEAT,
  FLAG_DATA_GAP,
  LAT_MISSING,
  OFF_FLAGS,
  encodeGapTickRecord,
  encodeControlRecord,
  decodeGapTickRecord,
  decodeControlRecord,
  isControlRecord,
  FLAG_CONTROL,
  CONTROL_SESSION_END,
  calcRecordGaps,
  toGapTickLineInput,
} from "../src/renderer/utils/gapTickRecord.js";
import { formatGapTickLine } from "../src/renderer/utils/gapTickLine.js";

const require = createRequire(import.meta.url);
const gapTickFile = require("../src/main/gapTickFile.js");

const SAMPLE = {
  wallMs: Date.UTC(2026, 8, 19, 2, 30, 15, 123),
  a: { bid: 2412.35, ask: 2412.55, lat: 8, timeMsc: 1789123456789 },
  b: { bid: 2412.67, ask: 2412.88, lat: 11, timeMsc: 1789123456795 },
};

test("bản ghi đúng 64 byte và roundtrip không đổi giá trị", () => {
  const bytes = encodeGapTickRecord(SAMPLE);
  assert.equal(bytes.byteLength, RECORD_SIZE);

  const rec = decodeGapTickRecord(bytes);
  assert.equal(rec.wallMs, SAMPLE.wallMs);
  assert.equal(rec.a.bid, SAMPLE.a.bid);
  assert.equal(rec.a.ask, SAMPLE.a.ask);
  assert.equal(rec.a.lat, 8);
  assert.equal(rec.a.timeMsc, SAMPLE.a.timeMsc);
  assert.equal(rec.b.bid, SAMPLE.b.bid);
  assert.equal(rec.b.ask, SAMPLE.b.ask);
  assert.equal(rec.b.lat, 11);
  assert.equal(rec.flags, FLAG_A_VALID | FLAG_B_VALID);
  assert.equal(rec.heartbeat, false);
});

test("giá f64 giữ nguyên bit, không làm tròn như text", () => {
  const odd = { wallMs: 1, a: { bid: 0.1 + 0.2, ask: 1 / 3, lat: 0 }, b: { bid: 1e-9, ask: 1e21, lat: 0 } };
  const rec = decodeGapTickRecord(encodeGapTickRecord(odd));
  assert.equal(rec.a.bid, 0.1 + 0.2);
  assert.equal(rec.a.ask, 1 / 3);
  assert.equal(rec.b.bid, 1e-9);
  assert.equal(rec.b.ask, 1e21);
});

test("phía thiếu dữ liệu -> null, flag tắt, latency = LAT_MISSING", () => {
  const bytes = encodeGapTickRecord({ wallMs: 1, a: SAMPLE.a, b: null });
  assert.equal((bytes[OFF_FLAGS] & FLAG_B_VALID), 0);
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint16(58, true), LAT_MISSING);

  const rec = decodeGapTickRecord(bytes);
  assert.equal(rec.b, null);
  assert.deepEqual(calcRecordGaps(rec, 100), { gapBuy: null, gapSell: null });
});

test("latency thiếu / âm / quá lớn được xử lý xác định", () => {
  const rec = decodeGapTickRecord(
    encodeGapTickRecord({ wallMs: 1, a: { bid: 1, ask: 2, lat: null }, b: { bid: 1, ask: 2, lat: -5 } })
  );
  assert.equal(rec.a.lat, null);
  assert.equal(rec.b.lat, 0);

  const big = decodeGapTickRecord(encodeGapTickRecord({ wallMs: 1, a: { bid: 1, ask: 2, lat: 1e9 } }));
  assert.equal(big.a.lat, 0xfffe); // chặn trần, không tràn u16
});

test("cờ heartbeat và data gap", () => {
  const rec = decodeGapTickRecord(encodeGapTickRecord({ wallMs: 1, heartbeat: true, dataGap: true }));
  assert.equal(rec.heartbeat, true);
  assert.equal(rec.dataGap, true);
  assert.equal(rec.flags, FLAG_HEARTBEAT | FLAG_DATA_GAP);
  assert.equal(rec.a, null);
  assert.equal(rec.b, null);
});

test("gap tính lại từ bản ghi khớp công thức của poller", () => {
  const rec = decodeGapTickRecord(encodeGapTickRecord(SAMPLE));
  const { gapBuy, gapSell } = calcRecordGaps(rec, 100);
  assert.equal(gapBuy, (SAMPLE.b.bid - SAMPLE.a.ask) * 100);
  assert.equal(gapSell, (SAMPLE.b.ask - SAMPLE.a.bid) * 100);
});

test("dựng lại đúng dòng GAP_TICK text", () => {
  const rec = decodeGapTickRecord(encodeGapTickRecord(SAMPLE));
  const line = formatGapTickLine(toGapTickLineInput(rec, { symA: "XAUUSD", symB: "XAUUSD.m", point: 100 }));

  const expected = formatGapTickLine({
    timeMs: SAMPLE.wallMs,
    gapBuy: (SAMPLE.b.bid - SAMPLE.a.ask) * 100,
    gapSell: (SAMPLE.b.ask - SAMPLE.a.bid) * 100,
    a: { sym: "XAUUSD", bid: SAMPLE.a.bid, ask: SAMPLE.a.ask, spread: SAMPLE.a.ask - SAMPLE.a.bid, lat: SAMPLE.a.lat },
    b: { sym: "XAUUSD.m", bid: SAMPLE.b.bid, ask: SAMPLE.b.ask, spread: SAMPLE.b.ask - SAMPLE.b.bid, lat: SAMPLE.b.lat },
    point: 100,
  });

  assert.equal(line, expected);
  assert.match(line, /\[GAP_TICK\] gap_buy=12 gap_sell=53 a_sym=XAUUSD /);
});

test("phía thiếu dữ liệu xuất ra text thành '-' như writer cũ", () => {
  const rec = decodeGapTickRecord(encodeGapTickRecord({ wallMs: SAMPLE.wallMs, a: SAMPLE.a, b: null }));
  const line = formatGapTickLine(toGapTickLineInput(rec, { symA: "XAUUSD", symB: "XAUUSD.m", point: 100 }));
  assert.match(line, /gap_buy=- gap_sell=- /);
  assert.match(line, /b_sym=- b_bid=- b_ask=- b_spread=- b_lat=- point=100$/);
});

test("decode báo lỗi khi thiếu byte", () => {
  assert.throws(() => decodeGapTickRecord(new Uint8Array(63)), /thiếu byte/);
});

test("encode ghi vào đệm dùng lại được, không cấp phát mới", () => {
  const scratch = new Uint8Array(RECORD_SIZE);
  const out = encodeGapTickRecord(SAMPLE, scratch);
  assert.equal(out, scratch);
  assert.equal(decodeGapTickRecord(scratch).a.bid, SAMPLE.a.bid);
});

test("header roundtrip, đệm tới bội số 64 byte", () => {
  const meta = {
    mapA: "Local\MT5_A",
    mapB: "Local\MT5_B",
    symA: "XAUUSD",
    symB: "XAUUSD.m",
    group: "XAU",
    point: 100,
    host: "test-host",
    startedAtMs: SAMPLE.wallMs,
    tzOffsetMin: 420,
    part: 0,
    baseFile: "20260919_093000-XAU-MT5_A-MT5_B.gtick",
  };
  const buf = gapTickFile.encodeFileHeader(meta);
  assert.equal(buf.length % RECORD_SIZE, 0);

  const parsed = gapTickFile.parseFileHeader(buf);
  assert.deepEqual(parsed.meta, meta);
  assert.equal(parsed.byteLength, buf.length);
  assert.equal(parsed.version, gapTickFile.FORMAT_VERSION);
});

test("header nhận version 1 và 2, từ chối version lạ", () => {
  const good = gapTickFile.encodeFileHeader({ mapA: "a" });
  assert.equal(gapTickFile.parseFileHeader(good).version, 2);

  const v1 = Buffer.from(good);
  v1.writeUInt16LE(1, 8);
  assert.equal(gapTickFile.parseFileHeader(v1).version, 1, "file v1 cũ phải vẫn đọc được");

  const v3 = Buffer.from(good);
  v3.writeUInt16LE(3, 8);
  assert.throws(() => gapTickFile.parseFileHeader(v3), /version 3/);
});

test("header từ chối magic sai, version sai, JSON cắt cụt", () => {
  const good = gapTickFile.encodeFileHeader({ mapA: "a" });

  const badMagic = Buffer.from(good);
  badMagic.write("XXXXXXXX", 0, "ascii");
  assert.throws(() => gapTickFile.parseFileHeader(badMagic), /magic/);

  const badVersion = Buffer.from(good);
  badVersion.writeUInt16LE(99, 8);
  assert.throws(() => gapTickFile.parseFileHeader(badVersion), /version 99/);

  const badRecordSize = Buffer.from(good);
  badRecordSize.writeUInt16LE(48, 10);
  assert.throws(() => gapTickFile.parseFileHeader(badRecordSize), /recordSize=48/);

  const truncated = Buffer.from(good);
  truncated.writeUInt32LE(10_000, 12);
  assert.throws(() => gapTickFile.parseFileHeader(truncated), /cắt cụt/);

  assert.throws(() => gapTickFile.parseFileHeader(Buffer.alloc(4)), /quá ngắn/);
});

test("hằng số RECORD_SIZE của main và renderer không lệch nhau", () => {
  assert.equal(gapTickFile.RECORD_SIZE, RECORD_SIZE);
  assert.equal(gapTickFile.FLAG_CONTROL, FLAG_CONTROL);
  assert.equal(gapTickFile.CONTROL_SESSION_END, CONTROL_SESSION_END);
});

test("bản ghi điều khiển của main (CJS) và renderer (ESM) giống nhau từng byte", () => {
  const args = { wallMs: SAMPLE.wallMs, code: CONTROL_SESSION_END, dropped: 4_000_000_000 };
  assert.deepEqual(Buffer.from(encodeControlRecord(args)), gapTickFile.encodeControlRecord(args));
});

test("bản ghi điều khiển không bị nhầm thành bản ghi giá", () => {
  const bytes = encodeControlRecord({ wallMs: 42, code: CONTROL_SESSION_END, dropped: 9 });
  const rec = decodeGapTickRecord(bytes);
  assert.equal(isControlRecord(rec), true);
  assert.equal(rec.a, null);
  assert.equal(rec.b, null);
  assert.deepEqual(decodeControlRecord(bytes), { wallMs: 42, code: CONTROL_SESSION_END, dropped: 9 });

  assert.equal(isControlRecord(decodeGapTickRecord(encodeGapTickRecord(SAMPLE))), false);
});
