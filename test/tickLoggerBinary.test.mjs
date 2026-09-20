import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { RECORD_SIZE, encodeGapTickRecord } from "../src/renderer/utils/gapTickRecord.js";
import { iterateRecords, readFileInfo, scanFile, listParts } from "../tools/gapTickReader.mjs";

const require = createRequire(import.meta.url);
const { createTickLogger, pairKeyOf } = require("../src/main/tickLogger.js");

const START = new Date(2026, 8, 19, 9, 30, 0, 0);
const silentLogger = { info() {}, warn() {}, error() {} };
let baseDir;

function makeLogger(overrides = {}) {
  return createTickLogger({
    resolveBaseDir: () => baseDir,
    format: "binary",
    hostName: "test-host",
    now: () => START,
    flushIntervalMs: 60_000, // test tự flush bằng flushNow/endSession
    healthIntervalMs: 0,
    retentionDays: 0,
    logger: silentLogger,
    ...overrides,
  });
}

function tick(wallMs, bidA, bidB) {
  return {
    wallMs,
    a: { bid: bidA, ask: bidA + 0.2, lat: 8, timeMsc: wallMs - 8 },
    b: { bid: bidB, ask: bidB + 0.21, lat: 11, timeMsc: wallMs - 11 },
  };
}

function item(pairKey, t, extra = {}) {
  return { pairKey, bytes: encodeGapTickRecord(t), symA: "XAUUSD", symB: "XAUUSD.m", ...extra };
}

function listFiles() {
  return fs.readdirSync(baseDir).sort();
}

function dataRecords(file) {
  return [...iterateRecords(file)].filter((r) => !r.control).map((r) => r.record);
}

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "shm-gtick-"));
});

afterEach(() => {
  fs.rmSync(baseDir, { recursive: true, force: true });
});

test("tạo file .gtick cho mỗi cặp, header có symbol lấy từ bản ghi đầu", async () => {
  const logger = makeLogger();
  const key = pairKeyOf("Local\\MT5_A", "Local\\MT5_B");
  const { sessionId, files } = logger.startSession({
    groupName: "XAU Group",
    pairs: [{ mapA: "Local\\MT5_A", mapB: "Local\\MT5_B", point: 100 }],
  });

  assert.equal(files.length, 1);
  logger.logTicks(sessionId, [item(key, tick(START.getTime(), 2412.35, 2412.67))]);
  await logger.endSession(sessionId);

  assert.deepEqual(listFiles(), ["20260919_093000-XAU_Group-MT5_A-MT5_B.gtick"]);
  const info = readFileInfo(path.join(baseDir, listFiles()[0]));

  assert.equal(info.meta.mapA, "Local\\MT5_A");
  assert.equal(info.meta.mapB, "Local\\MT5_B");
  assert.equal(info.meta.symA, "XAUUSD");
  assert.equal(info.meta.symB, "XAUUSD.m");
  assert.equal(info.meta.group, "XAU Group");
  assert.equal(info.meta.point, 100);
  assert.equal(info.meta.host, "test-host");
  assert.equal(info.meta.part, 0);
  assert.equal(info.headerBytes % RECORD_SIZE, 0);
  assert.equal(info.trailingBytes, 0);
  assert.equal(info.recordCount, 2); // 1 tick + 1 bản ghi điều khiển kết phiên
});

test("point không phải số ghi thành null, không làm hỏng header", async () => {
  const logger = makeLogger();
  const { sessionId } = logger.startSession({ groupName: "g", pairs: [{ mapA: "A", mapB: "B", point: NaN }] });
  await logger.endSession(sessionId);
  assert.equal(readFileInfo(path.join(baseDir, "20260919_093000-g-A-B.gtick")).meta.point, null);
});

test("bản ghi vào đúng file theo pairKey, giữ thứ tự, pairKey lạ bị bỏ", async () => {
  const logger = makeLogger();
  const { sessionId } = logger.startSession({
    groupName: "g",
    pairs: [
      { mapA: "A", mapB: "B", point: 100 },
      { mapA: "A", mapB: "C", point: 100 },
    ],
  });
  const ab = pairKeyOf("A", "B");
  const ac = pairKeyOf("A", "C");

  logger.logTicks(sessionId, [
    item(ab, tick(1000, 1, 2)),
    item(ac, tick(1001, 3, 4)),
    item(ab, tick(1002, 5, 6)),
    item("khong-ton-tai", tick(1003, 7, 8)),
  ]);
  logger.flushNow();
  logger.logTicks(sessionId, [item(ab, tick(1004, 9, 10))]);
  await logger.endSession(sessionId);

  const abRecs = dataRecords(path.join(baseDir, "20260919_093000-g-A-B.gtick"));
  const acRecs = dataRecords(path.join(baseDir, "20260919_093000-g-A-C.gtick"));
  assert.deepEqual(abRecs.map((r) => r.wallMs), [1000, 1002, 1004]);
  assert.deepEqual(acRecs.map((r) => r.wallMs), [1001]);
  assert.deepEqual(abRecs.map((r) => r.a.bid), [1, 5, 9]);
});

test("đóng phiên ghi bản ghi điều khiển kèm số dropped", async () => {
  const logger = makeLogger({ queueCapacity: 2 });
  const { sessionId } = logger.startSession({ groupName: "g", pairs: [{ mapA: "A", mapB: "B", point: 100 }] });
  const key = pairKeyOf("A", "B");

  assert.doesNotThrow(() =>
    logger.logTicks(sessionId, Array.from({ length: 5 }, (_, i) => item(key, tick(1000 + i, 1, 2))))
  );
  assert.equal(logger.getStats(sessionId)[0].dropped, 3);
  await logger.endSession(sessionId);

  const scan = scanFile(path.join(baseDir, "20260919_093000-g-A-B.gtick"));
  assert.equal(scan.closedCleanly, true);
  assert.equal(scan.dropped, 3);
  assert.equal(scan.dataRecords, 2);
  assert.deepEqual([scan.firstWallMs, scan.lastWallMs], [1000, 1001]);
});

test("phiên không có bản ghi nào vẫn có header hợp lệ và dấu đóng sạch", async () => {
  const logger = makeLogger();
  const { sessionId } = logger.startSession({ groupName: "g", pairs: [{ mapA: "A", mapB: "B", point: 100 }] });
  await logger.endSession(sessionId);

  const file = path.join(baseDir, "20260919_093000-g-A-B.gtick");
  assert.equal(readFileInfo(file).meta.symA, null);
  assert.equal(scanFile(file).closedCleanly, true);
  assert.equal(scanFile(file).dataRecords, 0);
});

test("xoay file: cắt đúng biên 64 byte, không mất bản ghi, part sau có header riêng", async () => {
  const logger = makeLogger({ maxFileBytes: 512 });
  const { sessionId } = logger.startSession({ groupName: "g", pairs: [{ mapA: "A", mapB: "B", point: 100 }] });
  const key = pairKeyOf("A", "B");

  const count = 40;
  logger.logTicks(sessionId, Array.from({ length: count }, (_, i) => item(key, tick(1000 + i, i, i + 1))));
  await logger.endSession(sessionId);

  const parts = listParts(path.join(baseDir, "20260919_093000-g-A-B.gtick"));
  assert.ok(parts.length >= 2, `phải tách ít nhất 2 part, có: ${parts.length}`);

  const all = [];
  parts.forEach((file, idx) => {
    const info = readFileInfo(file);
    assert.equal(info.trailingBytes, 0, `${info.fileName}: lệch biên bản ghi`);
    assert.equal(info.meta.part, idx);
    assert.equal(info.meta.symA, "XAUUSD", `${info.fileName}: part sau mất symbol trong header`);
    assert.equal(info.meta.baseFile, "20260919_093000-g-A-B.gtick");
    all.push(...dataRecords(file));
  });

  assert.deepEqual(all.map((r) => r.wallMs), Array.from({ length: count }, (_, i) => 1000 + i));

  // Chỉ part cuối có dấu kết phiên; các part trước có dấu hết part.
  parts.forEach((file, idx) => {
    const scan = scanFile(file);
    const isLast = idx === parts.length - 1;
    assert.equal(scan.closedCleanly, isLast, `${path.basename(file)}: dấu kết phiên sai chỗ`);
    assert.equal(scan.partEnded, !isLast, `${path.basename(file)}: dấu hết part sai chỗ`);
  });
});

test("file bị cắt cụt giữa bản ghi: đọc được phần trước, báo số byte dư", async () => {
  const logger = makeLogger();
  const { sessionId } = logger.startSession({ groupName: "g", pairs: [{ mapA: "A", mapB: "B", point: 100 }] });
  const key = pairKeyOf("A", "B");
  logger.logTicks(sessionId, [item(key, tick(1000, 1, 2)), item(key, tick(1001, 3, 4))]);
  await logger.endSession(sessionId);

  // Giả lập crash: cắt mất 20 byte cuối.
  const file = path.join(baseDir, "20260919_093000-g-A-B.gtick");
  const size = fs.statSync(file).size;
  fs.truncateSync(file, size - 20);

  const info = readFileInfo(file);
  assert.equal(info.trailingBytes, RECORD_SIZE - 20);
  assert.equal(info.recordCount, 2);

  const scan = scanFile(file);
  assert.equal(scan.closedCleanly, false, "file bị cắt cụt không được coi là đóng sạch");
  assert.deepEqual(dataRecords(file).map((r) => r.wallMs), [1000, 1001]);
});

test("retention xóa cả file .gtick cũ, không đụng file lạ", async () => {
  const old = path.join(baseDir, "20260901_080000-g-A-B.gtick");
  const oldPart = path.join(baseDir, "20260901_080000-g-A-B.001.gtick");
  const foreign = path.join(baseDir, "ghi-chu.gtick");
  for (const f of [old, oldPart, foreign]) fs.writeFileSync(f, "x");
  const tenDaysAgo = new Date(START.getTime() - 10 * 24 * 60 * 60 * 1000);
  for (const f of [old, oldPart, foreign]) fs.utimesSync(f, tenDaysAgo, tenDaysAgo);

  const logger = makeLogger({ retentionDays: 7 });
  const { sessionId } = logger.startSession({ groupName: "g", pairs: [{ mapA: "A", mapB: "B" }] });
  await logger.endSession(sessionId);

  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(oldPart), false);
  assert.equal(fs.existsSync(foreign), true);
});

test("format không hỗ trợ thì báo lỗi ngay", () => {
  assert.throws(() => createTickLogger({ resolveBaseDir: () => baseDir, format: "parquet" }), /không hỗ trợ/);
});
