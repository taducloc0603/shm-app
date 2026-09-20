const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createTickLogger, sanitizeName, pairKeyOf } = require("../src/main/tickLogger");

const START = new Date(2026, 8, 19, 9, 30, 0, 0);
let baseDir;

const silentLogger = { info() {}, warn() {}, error() {} };

function makeLogger(overrides = {}) {
  return createTickLogger({
    resolveBaseDir: () => baseDir,
    hostName: "test-host",
    now: () => START,
    flushIntervalMs: 60_000, // test tự flush bằng flushNow/endSession
    healthIntervalMs: 0,
    retentionDays: 0,
    logger: silentLogger,
    ...overrides,
  });
}

function read(file) {
  return fs.readFileSync(file, "utf8");
}

function listLogs() {
  return fs.readdirSync(baseDir).filter((f) => f.endsWith(".log")).sort();
}

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "shm-ticks-"));
});

afterEach(() => {
  fs.rmSync(baseDir, { recursive: true, force: true });
});

test("tạo đúng 1 file cho mỗi cặp, tên đã làm sạch Local\\ và có header", async () => {
  const logger = makeLogger();
  const res = logger.startSession({
    groupName: "XAU Group",
    pairs: [
      { mapA: "Local\\MT5_A", mapB: "Local\\MT5_B", point: 100 },
      { mapA: "Local\\MT5_A", mapB: "Local\\MT5_C", point: 100 },
      { mapA: "Local\\MT5_B", mapB: "Local\\MT5_C", point: 100 },
    ],
  });

  assert.equal(res.ok, true);
  assert.equal(res.files.length, 3);
  await logger.endSession(res.sessionId);

  assert.deepEqual(listLogs(), [
    "20260919_093000-XAU_Group-MT5_A-MT5_B.log",
    "20260919_093000-XAU_Group-MT5_A-MT5_C.log",
    "20260919_093000-XAU_Group-MT5_B-MT5_C.log",
  ]);
  const content = read(path.join(baseDir, "20260919_093000-XAU_Group-MT5_A-MT5_B.log"));
  assert.match(content, /^\[09:30:00\.000\] ===== GAP TICK START =====\n/);
  assert.match(content, /\[09:30:00\.000\] Date: 2026-09-19\n/);
  assert.match(content, /\[09:30:00\.000\] Host: test-host\n/);
  assert.match(content, /Pair: A=Local\\MT5_A B=Local\\MT5_B config=XAU Group point=100\n/);
  assert.match(content, /\[GAP_TICK\]\[LEGEND\]/);
  assert.match(content, /===== GAP TICK STOP =====\n$/);
});

test("dòng tick vào đúng file của cặp theo pairKey, giữ thứ tự", async () => {
  const logger = makeLogger();
  const { sessionId } = logger.startSession({
    groupName: "g",
    pairs: [
      { mapA: "Local\\A", mapB: "Local\\B" },
      { mapA: "Local\\A", mapB: "Local\\C" },
    ],
  });

  logger.logTicks(sessionId, [
    { pairKey: pairKeyOf("Local\\A", "Local\\B"), line: "AB-1" },
    { pairKey: pairKeyOf("Local\\A", "Local\\C"), line: "AC-1" },
    { pairKey: pairKeyOf("Local\\A", "Local\\B"), line: "AB-2" },
    { pairKey: "khong-ton-tai", line: "bo qua" },
  ]);
  logger.flushNow();
  logger.logTicks(sessionId, [{ pairKey: pairKeyOf("Local\\A", "Local\\B"), line: "AB-3" }]);
  await logger.endSession(sessionId);

  const ab = read(path.join(baseDir, "20260919_093000-g-A-B.log"));
  const ac = read(path.join(baseDir, "20260919_093000-g-A-C.log"));
  assert.match(ab, /\nAB-1\nAB-2\nAB-3\n\[09:30:00\.000\] ===== GAP TICK STOP =====\n$/);
  assert.match(ac, /\nAC-1\n\[09:30:00\.000\] ===== GAP TICK STOP =====\n$/);
  assert.doesNotMatch(ab + ac, /bo qua/);
});

test("header ghi point=- khi point không phải số", async () => {
  const logger = makeLogger();
  const { sessionId } = logger.startSession({ groupName: "g", pairs: [{ mapA: "Local\\A", mapB: "Local\\B", point: NaN }] });
  await logger.endSession(sessionId);
  assert.match(read(path.join(baseDir, "20260919_093000-g-A-B.log")), /Pair: A=Local\\A B=Local\\B config=g point=-\n/);
});

test("giờ quay vòng qua 00:00 thì chèn dòng Date mới, chỉnh giờ nhỏ thì không", async () => {
  let current = START;
  const logger = makeLogger({ now: () => current });
  const { sessionId } = logger.startSession({ groupName: "g", pairs: [{ mapA: "Local\\A", mapB: "Local\\B" }] });
  const key = pairKeyOf("Local\\A", "Local\\B");
  logger.logTicks(sessionId, [
    { pairKey: key, line: "[23:59:59.990] [GAP_TICK] x=1" },
    { pairKey: key, line: "[23:59:59.980] [GAP_TICK] x=2" },
  ]);
  logger.flushNow();
  current = new Date(2026, 8, 20, 0, 0, 0, 100);
  logger.logTicks(sessionId, [
    { pairKey: key, line: "[00:00:00.020] [GAP_TICK] x=3" },
    { pairKey: key, line: "[00:00:00.050] [GAP_TICK] x=4" },
  ]);
  await logger.endSession(sessionId);

  const content = read(path.join(baseDir, "20260919_093000-g-A-B.log"));
  assert.match(content, /x=2\n\[00:00:00\.020\] Date: 2026-09-20\n\[00:00:00\.020\] \[GAP_TICK\] x=3\n\[00:00:00\.050\] \[GAP_TICK\] x=4\n/);
  assert.equal(content.match(/\] Date: /g).length, 2); // header + đúng 1 lần qua ngày
});

test("Start xóa file tick cũ hơn retentionDays, giữ file mới và file không phải của logger", async () => {
  const old = path.join(baseDir, "20260901_080000-g-A-B.log");
  const oldPart = path.join(baseDir, "20260901_080000-g-A-B.001.log");
  const recent = path.join(baseDir, "20260918_080000-g-A-B.log");
  const foreign = path.join(baseDir, "ghi-chu.log");
  for (const f of [old, oldPart, recent, foreign]) fs.writeFileSync(f, "x");
  const tenDaysAgo = new Date(START.getTime() - 10 * 24 * 60 * 60 * 1000);
  for (const f of [old, oldPart, foreign]) fs.utimesSync(f, tenDaysAgo, tenDaysAgo);
  fs.utimesSync(recent, START, START);

  const logger = makeLogger({ retentionDays: 7 });
  const { sessionId } = logger.startSession({ groupName: "g", pairs: [{ mapA: "Local\\A", mapB: "Local\\B" }] });
  await logger.endSession(sessionId);

  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(oldPart), false);
  assert.equal(fs.existsSync(recent), true);
  assert.equal(fs.existsSync(foreign), true);
});

const ROTATE_LINE = (i) => `line-${String(i).padStart(3, "0")}-xxxxxxxxxxxxxxxxxxxx`;

async function writeRotating(maxFileBytes, count) {
  const logger = makeLogger({ maxFileBytes });
  const { sessionId } = logger.startSession({ groupName: "g", pairs: [{ mapA: "Local\\A", mapB: "Local\\B", point: 100 }] });
  const key = pairKeyOf("Local\\A", "Local\\B");
  logger.logTicks(sessionId, Array.from({ length: count }, (_, i) => ({ pairKey: key, line: ROTATE_LINE(i) })));
  await logger.endSession(sessionId);
  return listLogs();
}

test("đủ ngưỡng thì tách sang file .001.log, không cắt ngang dòng, không mất dòng", async () => {
  const files = await writeRotating(1500, 40);

  assert.deepEqual(files, ["20260919_093000-g-A-B.001.log", "20260919_093000-g-A-B.log"]);
  const first = read(path.join(baseDir, "20260919_093000-g-A-B.log"));
  const second = read(path.join(baseDir, "20260919_093000-g-A-B.001.log"));

  // Dòng dữ liệu: đủ 40 dòng, theo thứ tự, mỗi dòng nằm trọn trong một file.
  const dataLines = (first + second).split("\n").filter((l) => l.startsWith("line-"));
  assert.deepEqual(dataLines, Array.from({ length: 40 }, (_, i) => ROTATE_LINE(i)));

  // File đầu kết thúc bằng dòng trỏ sang file tiếp theo, không có STOP.
  assert.match(first, /===== GAP TICK PART END -> tiep tuc o 20260919_093000-g-A-B\.001\.log =====\n$/);
  assert.doesNotMatch(first, /GAP TICK STOP/);
  assert.ok(fs.statSync(path.join(baseDir, "20260919_093000-g-A-B.log")).size <= 1500 + 120, "file đầu vượt ngưỡng quá xa");
});

test("file thứ 2 có header đầy đủ + dòng Part, file cuối kết thúc bằng STOP", async () => {
  await writeRotating(1500, 40);
  const second = read(path.join(baseDir, "20260919_093000-g-A-B.001.log"));

  assert.match(second, /^\[09:30:00\.000\] ===== GAP TICK START =====\n/);
  assert.match(second, /\[09:30:00\.000\] Date: 2026-09-19\n/);
  assert.match(second, /\[09:30:00\.000\] Host: test-host\n/);
  assert.match(second, /Pair: A=Local\\A B=Local\\B config=g point=100\n/);
  assert.match(
    second,
    /\[09:30:00\.000\] Part: 001 \(tiep theo cua 20260919_093000-g-A-B\.log, phien bat dau 2026-09-19 09:30:00\)\n/
  );
  assert.match(second, /\[GAP_TICK\]\[LEGEND\]/);
  assert.match(second, /===== GAP TICK STOP =====\n$/);
  // File đầu không có dòng Part.
  assert.doesNotMatch(read(path.join(baseDir, "20260919_093000-g-A-B.log")), /\] Part: /);
});

test("tách nhiều lần: .001, .002 ... đánh số Part liên tục", async () => {
  const files = await writeRotating(1000, 60);

  assert.ok(files.includes("20260919_093000-g-A-B.002.log"), `phải có .002, có: ${files.join(", ")}`);
  assert.match(read(path.join(baseDir, "20260919_093000-g-A-B.001.log")), /\] Part: 001 /);
  assert.match(read(path.join(baseDir, "20260919_093000-g-A-B.002.log")), /\] Part: 002 /);
  assert.match(
    read(path.join(baseDir, "20260919_093000-g-A-B.001.log")),
    /PART END -> tiep tuc o 20260919_093000-g-A-B\.002\.log =====\n$/
  );

  const ordered = ["20260919_093000-g-A-B.log", ...files.filter((f) => /\.\d{3}\.log$/.test(f)).sort()];
  const dataLines = ordered
    .map((f) => read(path.join(baseDir, f)))
    .join("")
    .split("\n")
    .filter((l) => l.startsWith("line-"));
  assert.deepEqual(dataLines, Array.from({ length: 60 }, (_, i) => ROTATE_LINE(i)));
  // Chỉ file cuối có STOP.
  const last = ordered[ordered.length - 1];
  for (const f of ordered) {
    const hasStop = /GAP TICK STOP/.test(read(path.join(baseDir, f)));
    assert.equal(hasStop, f === last, `${f}: STOP chỉ được nằm ở file cuối`);
  }
});

test("hàng đợi đầy thì bỏ dòng và đếm dropped, không throw", async () => {
  const logger = makeLogger({ queueCapacity: 3 });
  const { sessionId } = logger.startSession({ groupName: "g", pairs: [{ mapA: "A", mapB: "B" }] });
  const key = pairKeyOf("A", "B");

  assert.doesNotThrow(() =>
    logger.logTicks(sessionId, Array.from({ length: 5 }, (_, i) => ({ pairKey: key, line: `L${i}` })))
  );
  const [stats] = logger.getStats(sessionId);
  assert.equal(stats.queued, 3);
  assert.equal(stats.dropped, 2);
  await logger.endSession(sessionId);

  const content = read(path.join(baseDir, "20260919_093000-g-A-B.log"));
  assert.match(content, /\nL0\nL1\nL2\n/);
  assert.doesNotMatch(content, /\nL3\n/);
  assert.match(content, /\[GAP_TICK\]\[WARN\] dropped=2/);
});

test("tên file đã bị chiếm (kể cả bởi thư mục) thì dùng hậu tố _2", async () => {
  const logger = makeLogger();
  // Chiếm sẵn tên file của cặp A-B bằng một THƯ MỤC.
  fs.mkdirSync(path.join(baseDir, "20260919_093000-g-A-B.log"));
  const { ok, sessionId, files } = logger.startSession({
    groupName: "g",
    pairs: [
      { mapA: "A", mapB: "B" },
      { mapA: "A", mapB: "C" },
    ],
  });

  assert.equal(ok, true);
  // Cặp A-B tránh được tên trùng bằng hậu tố _2, nên cả 2 cặp đều mở được file.
  assert.equal(files.length, 2);
  logger.logTicks(sessionId, [{ pairKey: pairKeyOf("A", "C"), line: "AC-ok" }]);
  await logger.endSession(sessionId);
  assert.match(read(path.join(baseDir, "20260919_093000-g-A-C.log")), /\nAC-ok\n/);
});

test("mở file một cặp lỗi: cặp đó bị tắt, cặp khác vẫn ghi", async () => {
  let calls = 0;
  const realOpen = fs.openSync;
  fs.openSync = (file, ...rest) => {
    calls += 1;
    if (String(file).endsWith("-g-A-B.log")) throw new Error("EACCES giả lập");
    return realOpen(file, ...rest);
  };
  try {
    const logger = makeLogger();
    const { sessionId, files } = logger.startSession({
      groupName: "g",
      pairs: [
        { mapA: "A", mapB: "B" },
        { mapA: "A", mapB: "C" },
      ],
    });
    assert.equal(files.length, 1);
    assert.ok(calls >= 2);
    const stats = logger.getStats(sessionId);
    assert.equal(stats.find((s) => s.label === "A-B").disabled, true);
    assert.doesNotThrow(() => logger.logTicks(sessionId, [{ pairKey: pairKeyOf("A", "B"), line: "x" }]));
    logger.logTicks(sessionId, [{ pairKey: pairKeyOf("A", "C"), line: "AC-ok" }]);
    await logger.endSession(sessionId);
    assert.match(read(path.join(baseDir, "20260919_093000-g-A-C.log")), /\nAC-ok\n/);
  } finally {
    fs.openSync = realOpen;
  }
});

test("hai lần Start cùng một giây không ghi đè file cũ", async () => {
  const logger = makeLogger();
  const first = logger.startSession({ groupName: "g", pairs: [{ mapA: "A", mapB: "B" }] });
  await logger.endSession(first.sessionId);
  const second = logger.startSession({ groupName: "g", pairs: [{ mapA: "A", mapB: "B" }] });
  await logger.endSession(second.sessionId);

  assert.deepEqual(listLogs(), ["20260919_093000-g-A-B.log", "20260919_093000-g-A-B_2.log"]);
});

test("không có cặp nào thì trả lỗi, không tạo file", () => {
  const logger = makeLogger();
  const res = logger.startSession({ groupName: "g", pairs: [] });
  assert.equal(res.ok, false);
  assert.deepEqual(listLogs(), []);
});

test("sanitizeName bỏ tiền tố Local\\/Global\\ và ký tự không hợp lệ", () => {
  assert.equal(sanitizeName("Local\\MT5_A"), "MT5_A");
  assert.equal(sanitizeName("Global\\MT5 B:x"), "MT5_B_x");
  assert.equal(sanitizeName("  "), "unnamed");
});
