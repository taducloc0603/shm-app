// Log tick theo từng cặp sàn: mỗi cặp một file trong Desktop\ticks, mỗi lần Start một bộ file mới.
// Port cách ghi của kênh GapTick trong TradeDesktop (TradeSessionFileLogger):
// - Ghi không chặn luồng gọi: dòng vào hàng đợi của cặp, hàng đợi đầy thì BỎ dòng và đếm "dropped".
// - Flush theo lô mỗi 200 ms (một lần write cho cả lô), tôn trọng backpressure của stream.
// - Xoay file khi vượt 50 MB: {base}.001.log, {base}.002.log ...
// - Lỗi mở file của một cặp chỉ tắt cặp đó, không ảnh hưởng cặp khác.
// - Health mỗi 60 s ra console.
//
// Factory không phụ thuộc Electron để test chạy bằng Node thuần; instance mặc định (Desktop\ticks)
// được tạo lười trong getDefaultTickLogger().

const fs = require("fs");
const path = require("path");
const os = require("os");

const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;
const DEFAULT_QUEUE_CAPACITY = 50_000;
const DEFAULT_FLUSH_INTERVAL_MS = 200;
const DEFAULT_HEALTH_INTERVAL_MS = 60_000;
const DEFAULT_END_TIMEOUT_MS = 5_000;
const DEFAULT_RETENTION_DAYS = 7;
// Chỉ file do logger này tạo: {yyyyMMdd_HHmmss}-....log (kể cả .001.log); file khác trong thư mục không bị đụng.
const TICK_FILE_PATTERN = /^\d{8}_\d{6}-.+\.log$/;

const LEGEND =
  "[GAP_TICK][LEGEND] moi dong = mot lan poll shared memory | timestamp=gio local luc poll (HH:mm:ss.fff) | " +
  "gap_buy=(B.Bid-A.Ask)*point gap_sell=(B.Ask-A.Bid)*point | a_*=san A b_*=san B " +
  "(bid/ask=gia tho, spread=ask-bid, lat=latency ms) | point=he so nhan point cua config | " +
  "'-' = gia tri khong san sang tai lan poll do";

function pad(value, length) {
  return String(value).padStart(length, "0");
}

function formatClock(date) {
  return `${pad(date.getHours(), 2)}:${pad(date.getMinutes(), 2)}:${pad(date.getSeconds(), 2)}.${pad(date.getMilliseconds(), 3)}`;
}

function formatDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1, 2)}-${pad(date.getDate(), 2)}`;
}

function formatFileStamp(date) {
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1, 2)}${pad(date.getDate(), 2)}_` +
    `${pad(date.getHours(), 2)}${pad(date.getMinutes(), 2)}${pad(date.getSeconds(), 2)}`
  );
}

// "Local\MT5_A" -> "MT5_A"; ký tự không hợp lệ cho tên file -> "_".
function sanitizeName(value) {
  const cleaned = String(value || "")
    .trim()
    .replace(/^(local|global)\\/i, "")
    .replace(/[\\/:*?"<>|\s]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "unnamed";
}

function pairKeyOf(mapA, mapB) {
  return `${String(mapA || "").trim()}|${String(mapB || "").trim()}`;
}

function createTickLogger(options = {}) {
  const {
    resolveBaseDir,
    maxFileBytes = DEFAULT_MAX_FILE_BYTES,
    queueCapacity = DEFAULT_QUEUE_CAPACITY,
    flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS,
    healthIntervalMs = DEFAULT_HEALTH_INTERVAL_MS,
    retentionDays = DEFAULT_RETENTION_DAYS, // 0 = không xóa
    hostName = os.hostname(),
    now = () => new Date(),
    logger = console,
  } = options;

  if (typeof resolveBaseDir !== "function") {
    throw new Error("createTickLogger: thiếu resolveBaseDir.");
  }

  const sessions = new Map();
  let sessionSeq = 0;
  let flushTimer = null;
  let lastHealthAt = Date.now();

  // Xóa file tick cũ hơn retentionDays (theo thời điểm sửa cuối) để thư mục không đầy ổ đĩa.
  // Lỗi từng file (đang mở, không có quyền) chỉ bỏ qua file đó.
  function pruneOldFiles(baseDir) {
    if (!(retentionDays > 0)) return;
    const cutoff = now().getTime() - retentionDays * 24 * 60 * 60 * 1000;
    let removed = 0;
    for (const name of fs.readdirSync(baseDir)) {
      if (!TICK_FILE_PATTERN.test(name)) continue;
      const filePath = path.join(baseDir, name);
      try {
        const stat = fs.statSync(filePath);
        if (stat.isFile() && stat.mtimeMs < cutoff) {
          fs.unlinkSync(filePath);
          removed += 1;
        }
      } catch (_err) {
        // noop
      }
    }
    if (removed) logger.info(`[TICK_LOGGER] Đã xóa ${removed} file tick cũ hơn ${retentionDays} ngày.`);
  }

  function openPartFile(pair, filePath) {
    const fd = fs.openSync(filePath, "w"); // mở đồng bộ để lỗi lộ ra ngay, bắt riêng từng cặp
    const stream = fs.createWriteStream(null, { fd, encoding: "utf8" });
    stream.on("drain", () => {
      // Chỉ stream hiện tại mới được nhả cờ chờ; drain của file cũ (sau khi xoay) bỏ qua.
      if (pair.stream === stream) pair.waitingDrain = false;
    });
    stream.on("error", (err) => {
      pair.disabled = true;
      pair.lastError = err;
      logger.warn(`[TICK_LOGGER][WARN] Ghi file tick lỗi, tắt cặp ${pair.label}: ${err?.message || err}`);
    });
    pair.stream = stream;
    pair.filePath = filePath;
    pair.bytes = 0;
    pair.waitingDrain = false;
  }

  function writeRaw(pair, text) {
    if (!pair.stream || pair.disabled) return;
    pair.bytes += Buffer.byteLength(text, "utf8");
    if (!pair.stream.write(text)) pair.waitingDrain = true;
  }

  // Header đầy đủ cho mọi file của một cặp, để mỗi file tự đọc được độc lập.
  // File đầu (part 0) không có dòng Part; file tách sau có thêm dòng Part trỏ về file đầu.
  function buildHeader(pair, at) {
    const t = formatClock(at);
    const partLine =
      pair.part > 0
        ? `[${t}] Part: ${pad(pair.part, 3)} (tiep theo cua ${path.basename(`${pair.basePath}.log`)}, ` +
          `phien bat dau ${formatDate(pair.startedAt)} ${formatClock(pair.startedAt).slice(0, 8)})\n`
        : "";
    return (
      `[${t}] ===== GAP TICK START =====\n` +
      `[${t}] Date: ${formatDate(at)}\n` +
      `[${t}] Host: ${hostName}\n` +
      `[${t}] Pair: A=${pair.mapA} B=${pair.mapB} config=${pair.groupName} point=${Number.isFinite(pair.point) ? pair.point : "-"}\n` +
      partLine +
      `[${t}] ${LEGEND}\n`
    );
  }

  // Đủ ngưỡng thì tách sang file kế tiếp: {base}.001.log, {base}.002.log ...
  function rotate(pair) {
    pair.part += 1;
    const oldStream = pair.stream;
    const filePath = `${pair.basePath}.${pad(pair.part, 3)}.log`;
    const at = now();

    // Dòng cuối của file cũ cho biết phần tiếp theo nằm ở đâu.
    writeRaw(pair, `[${formatClock(at)}] ===== GAP TICK PART END -> tiep tuc o ${path.basename(filePath)} =====\n`);

    try {
      openPartFile(pair, filePath);
    } catch (err) {
      pair.disabled = true;
      pair.lastError = err;
      logger.warn(`[TICK_LOGGER][WARN] Không mở được file xoay ${filePath}: ${err?.message || err}`);
    }
    try {
      oldStream?.end();
    } catch (_err) {
      // noop
    }
    writeRaw(pair, buildHeader(pair, at));
  }

  // Ghi toàn bộ dòng đang chờ của một cặp thành các lô, xoay file đúng ranh giới dòng.
  function flushPair(pair, { force = false } = {}) {
    if (pair.disabled || !pair.stream || !pair.queue.length) return;
    if (pair.waitingDrain && !force) return; // chờ stream nhả bộ đệm; hàng đợi vẫn giữ, có trần

    const lines = pair.queue;
    pair.queue = [];

    let batch = "";
    let batchBytes = 0;
    for (const line of lines) {
      // Dòng tick chỉ có giờ: khi giờ quay vòng qua 00:00 thì chèn dòng Date mới để biết dòng sau thuộc ngày nào.
      // Yêu cầu lùi >= 12 giờ để chỉnh giờ hệ thống nhỏ (NTP) không bị hiểu nhầm là qua ngày.
      const hourMatch = /^\[(\d{2}):/.exec(line);
      const hour = hourMatch ? Number(hourMatch[1]) : null;
      let text = `${line}\n`;
      if (hour !== null && pair.lastHour !== null && hour + 12 <= pair.lastHour) {
        text = `${line.slice(0, 14)} Date: ${formatDate(now())}\n${text}`;
      }
      if (hour !== null) pair.lastHour = hour;
      const bytes = Buffer.byteLength(text, "utf8");
      if (pair.bytes + batchBytes + bytes > maxFileBytes && pair.bytes + batchBytes > 0) {
        if (batch) writeRaw(pair, batch);
        batch = "";
        batchBytes = 0;
        rotate(pair);
        if (pair.disabled) return;
      }
      batch += text;
      batchBytes += bytes;
      pair.written += 1;
    }
    if (batch) writeRaw(pair, batch);
  }

  function writeHealth() {
    for (const session of sessions.values()) {
      for (const pair of session.pairs.values()) {
        logger.info(
          `[TICK_LOGGER][HEALTH] pair=${pair.label} queued=${pair.queue.length} enqueued=${pair.enqueued} ` +
            `written=${pair.written} dropped=${pair.dropped} bytes=${pair.bytes} part=${pair.part} ` +
            `disabled=${pair.disabled}`
        );
      }
    }
  }

  function onFlushTimer() {
    for (const session of sessions.values()) {
      for (const pair of session.pairs.values()) flushPair(pair);
    }
    if (healthIntervalMs > 0 && Date.now() - lastHealthAt >= healthIntervalMs) {
      lastHealthAt = Date.now();
      writeHealth();
    }
  }

  function ensureTimer() {
    if (flushTimer) return;
    flushTimer = setInterval(onFlushTimer, flushIntervalMs);
    flushTimer.unref?.(); // không giữ tiến trình sống chỉ vì timer
  }

  function stopTimerIfIdle() {
    if (flushTimer && sessions.size === 0) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
  }

  /**
   * @param {{ groupName?: string, pairs: Array<{ mapA: string, mapB: string, point?: number }> }} payload
   */
  function startSession(payload = {}) {
    const pairsInput = Array.isArray(payload.pairs) ? payload.pairs : [];
    if (!pairsInput.length) {
      return { ok: false, message: "Không có cặp sàn nào để ghi tick." };
    }

    let baseDir;
    try {
      baseDir = resolveBaseDir();
      fs.mkdirSync(baseDir, { recursive: true });
    } catch (err) {
      return { ok: false, message: `Không tạo được thư mục ticks: ${err?.message || err}` };
    }
    try {
      pruneOldFiles(baseDir);
    } catch (err) {
      logger.warn(`[TICK_LOGGER][WARN] Không dọn được file tick cũ: ${err?.message || err}`);
    }

    const startedAt = now();
    const stamp = formatFileStamp(startedAt);
    const group = sanitizeName(payload.groupName);
    const sessionId = `ticks-${Date.now()}-${sessionSeq++}`;
    const session = { id: sessionId, pairs: new Map() };
    const files = [];

    for (const input of pairsInput) {
      const mapA = String(input?.mapA || "").trim();
      const mapB = String(input?.mapB || "").trim();
      if (!mapA || !mapB) continue;
      const key = pairKeyOf(mapA, mapB);
      if (session.pairs.has(key)) continue;

      const label = `${sanitizeName(mapA)}-${sanitizeName(mapB)}`;
      let basePath = path.join(baseDir, `${stamp}-${group}-${label}`);
      // Hai lần Start trong cùng một giây: không ghi đè file cũ.
      for (let n = 2; fs.existsSync(`${basePath}.log`); n += 1) {
        basePath = path.join(baseDir, `${stamp}-${group}-${label}_${n}`);
      }

      const pair = {
        label,
        mapA,
        mapB,
        groupName: String(payload.groupName || "").trim(),
        point: input?.point,
        basePath,
        startedAt,
        part: 0,
        stream: null,
        filePath: null,
        bytes: 0,
        queue: [],
        enqueued: 0,
        written: 0,
        dropped: 0,
        disabled: false,
        waitingDrain: false,
        lastError: null,
        lastHour: null,
      };

      // try/catch RIÊNG từng cặp: một cặp lỗi không kéo theo cặp khác.
      try {
        openPartFile(pair, `${basePath}.log`);
        writeRaw(pair, buildHeader(pair, startedAt));
        files.push(pair.filePath);
      } catch (err) {
        pair.disabled = true;
        pair.lastError = err;
        logger.warn(`[TICK_LOGGER][WARN] Không mở được file tick cho cặp ${label}: ${err?.message || err}`);
      }

      session.pairs.set(key, pair);
    }

    sessions.set(sessionId, session);
    ensureTimer();
    return { ok: true, sessionId, files };
  }

  /**
   * @param {string} sessionId
   * @param {Array<{ pairKey: string, line: string }>} lines  pairKey = "mapA|mapB" theo thứ tự trong config
   */
  function logTicks(sessionId, lines) {
    const session = sessions.get(sessionId);
    if (!session || !Array.isArray(lines)) return;
    for (const item of lines) {
      const pair = session.pairs.get(String(item?.pairKey || ""));
      if (!pair || pair.disabled) continue;
      if (pair.queue.length >= queueCapacity) {
        pair.dropped += 1; // đếm riêng, không throw, không chặn luồng gọi
        continue;
      }
      pair.queue.push(String(item.line ?? ""));
      pair.enqueued += 1;
    }
  }

  function closePair(pair) {
    return new Promise((resolve) => {
      if (!pair.stream || pair.disabled) {
        try {
          pair.stream?.end();
        } catch (_err) {
          // noop
        }
        resolve();
        return;
      }
      flushPair(pair, { force: true });
      if (pair.dropped > 0) {
        writeRaw(pair, `[${formatClock(now())}] [GAP_TICK][WARN] dropped=${pair.dropped} (hang doi day)\n`);
      }
      writeRaw(pair, `[${formatClock(now())}] ===== GAP TICK STOP =====\n`);
      pair.stream.end(() => resolve());
    });
  }

  function endSession(sessionId, timeoutMs = DEFAULT_END_TIMEOUT_MS) {
    const session = sessions.get(sessionId);
    if (!session) return Promise.resolve({ ok: true });
    sessions.delete(sessionId);
    stopTimerIfIdle();

    const all = Promise.all(Array.from(session.pairs.values()).map(closePair));
    const timeout = new Promise((resolve) => {
      const t = setTimeout(resolve, timeoutMs);
      t.unref?.();
    });
    return Promise.race([all, timeout]).then(() => ({ ok: true }));
  }

  function endAllSessions(timeoutMs = DEFAULT_END_TIMEOUT_MS) {
    return Promise.all(Array.from(sessions.keys()).map((id) => endSession(id, timeoutMs))).then(() => ({ ok: true }));
  }

  function getStats(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return null;
    return Array.from(session.pairs.values()).map((p) => ({
      label: p.label,
      filePath: p.filePath,
      queued: p.queue.length,
      enqueued: p.enqueued,
      written: p.written,
      dropped: p.dropped,
      part: p.part,
      disabled: p.disabled,
    }));
  }

  return { startSession, logTicks, endSession, endAllSessions, getStats, flushNow: onFlushTimer };
}

let defaultTickLogger = null;

// Instance dùng trong app: Desktop\ticks. Require electron lười để file này test được bằng Node thuần.
function getDefaultTickLogger() {
  if (!defaultTickLogger) {
    const { app } = require("electron");
    defaultTickLogger = createTickLogger({
      resolveBaseDir: () => path.join(app.getPath("desktop"), "ticks"),
    });
  }
  return defaultTickLogger;
}

module.exports = {
  createTickLogger,
  getDefaultTickLogger,
  sanitizeName,
  pairKeyOf,
};
