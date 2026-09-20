// Log tick theo từng cặp sàn: mỗi cặp một file trong Desktop\ticks, mỗi lần Start một bộ file mới.
//
// Phần ghi file (chung cho mọi định dạng), port cách ghi của kênh GapTick trong TradeDesktop:
// - Ghi không chặn luồng gọi: mục vào hàng đợi của cặp, hàng đợi đầy thì BỎ và đếm "dropped".
// - Flush theo lô mỗi 200 ms (một lần write cho cả lô), tôn trọng backpressure của stream.
// - Xoay file khi vượt 50 MB: {base}.001.{ext}, {base}.002.{ext} ...
// - Lỗi mở file của một cặp chỉ tắt cặp đó, không ảnh hưởng cặp khác.
// - Health mỗi 60 s ra console.
//
// Định dạng nằm sau một adapter (xem createBinaryFormat / createTextFormat):
// - "binary" (mặc định): .gtick, bản ghi cố định 64 byte — nhẹ hơn text ~3-4 lần và giữ nguyên
//   độ chính xác f64 của giá. Xem src/main/gapTickFile.js và src/renderer/utils/gapTickRecord.js.
// - "text": .log, đúng định dạng GAP_TICK cũ — giữ lại để soi tay tại hiện trường và làm
//   bản đối chứng cho tools/ticks.mjs.
//
// Factory không phụ thuộc Electron để test chạy bằng Node thuần; instance mặc định (Desktop\ticks)
// được tạo lười trong getDefaultTickLogger().

const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  FILE_EXT,
  encodeFileHeader,
  encodeControlRecord,
  CONTROL_SESSION_END,
  CONTROL_PART_END,
} = require("./gapTickFile");

const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;
const DEFAULT_QUEUE_CAPACITY = 50_000;
const DEFAULT_FLUSH_INTERVAL_MS = 200;
const DEFAULT_HEALTH_INTERVAL_MS = 60_000;
const DEFAULT_END_TIMEOUT_MS = 5_000;
const DEFAULT_RETENTION_DAYS = 7;
// Chỉ file do logger này tạo: {yyyyMMdd_HHmmss}-....{log|gtick} (kể cả .001.*); file khác không bị đụng.
const TICK_FILE_PATTERN = /^\d{8}_\d{6}-.+\.(log|gtick)$/;

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

// ---------------------------------------------------------------------------
// Adapter định dạng. Mọi hàm trả về Buffer (hoặc null nếu mục không ghi được).
// encode() chạy lúc flush, nên trạng thái riêng của định dạng nằm ở pair.fmtState.
// ---------------------------------------------------------------------------

function createTextFormat() {
  return {
    ext: ".log",
    // Header text tự đọc được nên ghi ngay lúc mở file, kể cả khi phiên không có dòng nào.
    deferHeader: false,

    initState() {
      return { lastHour: null };
    },

    header(pair, at) {
      const t = formatClock(at);
      const partLine =
        pair.part > 0
          ? `[${t}] Part: ${pad(pair.part, 3)} (tiep theo cua ${path.basename(`${pair.basePath}.log`)}, ` +
            `phien bat dau ${formatDate(pair.startedAt)} ${formatClock(pair.startedAt).slice(0, 8)})\n`
          : "";
      return Buffer.from(
        `[${t}] ===== GAP TICK START =====\n` +
          `[${t}] Date: ${formatDate(at)}\n` +
          `[${t}] Host: ${pair.hostName}\n` +
          `[${t}] Pair: A=${pair.mapA} B=${pair.mapB} config=${pair.groupName} point=${Number.isFinite(pair.point) ? pair.point : "-"}\n` +
          partLine +
          `[${t}] ${LEGEND}\n`,
        "utf8"
      );
    },

    encode(pair, item, now) {
      const line = String(item?.line ?? "");
      // Dòng tick chỉ có giờ: khi giờ quay vòng qua 00:00 thì chèn dòng Date mới để biết dòng sau
      // thuộc ngày nào. Yêu cầu lùi >= 12 giờ để chỉnh giờ hệ thống nhỏ (NTP) không bị hiểu nhầm.
      const hourMatch = /^\[(\d{2}):/.exec(line);
      const hour = hourMatch ? Number(hourMatch[1]) : null;
      let text = `${line}\n`;
      if (hour !== null && pair.fmtState.lastHour !== null && hour + 12 <= pair.fmtState.lastHour) {
        text = `${line.slice(0, 14)} Date: ${formatDate(now())}\n${text}`;
      }
      if (hour !== null) pair.fmtState.lastHour = hour;
      return Buffer.from(text, "utf8");
    },

    partEnd(pair, nextFileName, at) {
      return Buffer.from(
        `[${formatClock(at)}] ===== GAP TICK PART END -> tiep tuc o ${nextFileName} =====\n`,
        "utf8"
      );
    },

    sessionEnd(pair, at, dropped) {
      const droppedLine =
        dropped > 0 ? `[${formatClock(at)}] [GAP_TICK][WARN] dropped=${dropped} (hang doi day)\n` : "";
      return Buffer.from(`${droppedLine}[${formatClock(at)}] ===== GAP TICK STOP =====\n`, "utf8");
    },
  };
}

function createBinaryFormat() {
  return {
    ext: FILE_EXT,
    // Header chứa symbol của hai sàn, mà symbol chỉ biết được sau lần poll đầu -> ghi trễ.
    deferHeader: true,

    initState() {
      return {};
    },

    header(pair, at) {
      return encodeFileHeader({
        mapA: pair.mapA,
        mapB: pair.mapB,
        symA: pair.symA ?? null,
        symB: pair.symB ?? null,
        group: pair.groupName,
        point: Number.isFinite(pair.point) ? pair.point : null,
        confirmGapPts: Number.isFinite(pair.confirmGapPts) ? pair.confirmGapPts : null,
        openPts: Number.isFinite(pair.openPts) ? pair.openPts : null,
        holdConfirmMs: Number.isFinite(pair.holdConfirmMs) ? pair.holdConfirmMs : null,
        host: pair.hostName,
        startedAtMs: pair.startedAt.getTime(),
        openedAtMs: at.getTime(),
        tzOffsetMin: -at.getTimezoneOffset(),
        part: pair.part,
        baseFile: `${path.basename(pair.basePath)}${FILE_EXT}`,
      });
    },

    encode(_pair, item) {
      const bytes = item?.bytes;
      if (!bytes) return null;
      // Qua IPC có thể là ArrayBuffer hoặc TypedArray; Buffer.from(view) lấy đúng vùng của view.
      if (Buffer.isBuffer(bytes)) return bytes;
      if (ArrayBuffer.isView(bytes)) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return Buffer.from(bytes);
    },

    partEnd(_pair, _nextFileName, at) {
      return encodeControlRecord({ wallMs: at.getTime(), code: CONTROL_PART_END });
    },

    sessionEnd(_pair, at, dropped) {
      return encodeControlRecord({ wallMs: at.getTime(), code: CONTROL_SESSION_END, dropped });
    },
  };
}

const FORMATS = { text: createTextFormat, binary: createBinaryFormat };

function createTickLogger(options = {}) {
  const {
    resolveBaseDir,
    format: formatName = "binary",
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
  if (!FORMATS[formatName]) {
    throw new Error(`createTickLogger: format không hỗ trợ "${formatName}".`);
  }
  const format = FORMATS[formatName]();

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
    const stream = fs.createWriteStream(null, { fd });
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
    pair.headerWritten = false;
    pair.waitingDrain = false;
  }

  function writeRaw(pair, chunk) {
    if (!pair.stream || pair.disabled || !chunk || chunk.length === 0) return;
    pair.bytes += chunk.length;
    if (!pair.stream.write(chunk)) pair.waitingDrain = true;
  }

  // Header đầy đủ cho mọi file của một cặp, để mỗi file tự đọc được độc lập.
  // Định dạng nhị phân hoãn tới lúc có bản ghi đầu tiên (cần symbol) nên đi qua hàm này.
  function ensureHeader(pair, at) {
    if (pair.headerWritten || pair.disabled || !pair.stream) return;
    pair.headerWritten = true; // đặt trước khi ghi để writeRaw không gọi vòng lại
    writeRaw(pair, format.header(pair, at));
  }

  // Đủ ngưỡng thì tách sang file kế tiếp: {base}.001.{ext}, {base}.002.{ext} ...
  function rotate(pair) {
    const at = now();
    const nextPart = pair.part + 1;
    const filePath = `${pair.basePath}.${pad(nextPart, 3)}${format.ext}`;
    const oldStream = pair.stream;

    // Dấu cuối của file cũ cho biết phần tiếp theo nằm ở đâu.
    ensureHeader(pair, at);
    writeRaw(pair, format.partEnd(pair, path.basename(filePath), at));

    pair.part = nextPart;
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
    ensureHeader(pair, at);
  }

  // Ghi toàn bộ mục đang chờ của một cặp thành các lô, xoay file đúng ranh giới bản ghi.
  function flushPair(pair, { force = false } = {}) {
    if (pair.disabled || !pair.stream || !pair.queue.length) return;
    if (pair.waitingDrain && !force) return; // chờ stream nhả bộ đệm; hàng đợi vẫn giữ, có trần

    const items = pair.queue;
    pair.queue = [];

    const batch = [];
    let batchBytes = 0;
    for (const item of items) {
      const chunk = format.encode(pair, item, now);
      if (!chunk || chunk.length === 0) continue;

      ensureHeader(pair, now());
      if (pair.bytes + batchBytes + chunk.length > maxFileBytes && pair.bytes + batchBytes > 0) {
        if (batch.length) writeRaw(pair, Buffer.concat(batch, batchBytes));
        batch.length = 0;
        batchBytes = 0;
        rotate(pair);
        if (pair.disabled) return;
      }
      batch.push(chunk);
      batchBytes += chunk.length;
      pair.written += 1;
    }
    if (batch.length) writeRaw(pair, Buffer.concat(batch, batchBytes));
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
      for (let n = 2; fs.existsSync(`${basePath}${format.ext}`); n += 1) {
        basePath = path.join(baseDir, `${stamp}-${group}-${label}_${n}`);
      }

      const pair = {
        label,
        mapA,
        mapB,
        symA: null,
        symB: null,
        hostName,
        groupName: String(payload.groupName || "").trim(),
        point: input?.point,
        confirmGapPts: Number(input?.confirmGapPts),
        openPts: Number(input?.openPts),
        holdConfirmMs: Number(input?.holdConfirmMs),
        basePath,
        startedAt,
        part: 0,
        stream: null,
        filePath: null,
        bytes: 0,
        headerWritten: false,
        queue: [],
        enqueued: 0,
        written: 0,
        dropped: 0,
        disabled: false,
        waitingDrain: false,
        lastError: null,
        fmtState: format.initState(),
      };

      // try/catch RIÊNG từng cặp: một cặp lỗi không kéo theo cặp khác.
      try {
        openPartFile(pair, `${basePath}${format.ext}`);
        if (!format.deferHeader) ensureHeader(pair, startedAt);
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
    // format để renderer biết đóng gói bản ghi nhị phân hay dòng text.
    return { ok: true, sessionId, format: formatName, files };
  }

  /**
   * @param {string} sessionId
   * @param {Array<{ pairKey: string, line?: string, bytes?: ArrayBuffer|Uint8Array,
   *                 symA?: string, symB?: string }>} items
   *   pairKey = "mapA|mapB" theo thứ tự trong config.
   */
  function logTicks(sessionId, items) {
    const session = sessions.get(sessionId);
    if (!session || !Array.isArray(items)) return;
    for (const item of items) {
      const pair = session.pairs.get(String(item?.pairKey || ""));
      if (!pair || pair.disabled) continue;
      // Symbol chỉ biết sau lần poll đầu; giữ lại cho header (kể cả header của các part sau).
      if (pair.symA == null && item?.symA) pair.symA = String(item.symA);
      if (pair.symB == null && item?.symB) pair.symB = String(item.symB);
      if (pair.queue.length >= queueCapacity) {
        pair.dropped += 1; // đếm riêng, không throw, không chặn luồng gọi
        continue;
      }
      pair.queue.push(item);
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
      const at = now();
      ensureHeader(pair, at);
      writeRaw(pair, format.sessionEnd(pair, at, pair.dropped));
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

  return { startSession, logTicks, endSession, endAllSessions, getStats, flushNow: onFlushTimer, format: formatName };
}

let defaultTickLogger = null;

// Instance dùng trong app: Desktop\ticks. Require electron lười để file này test được bằng Node thuần.
// SHM_TICK_FORMAT=text bật lại writer text cũ khi cần soi log bằng tay tại hiện trường.
function getDefaultTickLogger() {
  if (!defaultTickLogger) {
    const { app } = require("electron");
    defaultTickLogger = createTickLogger({
      resolveBaseDir: () => path.join(app.getPath("desktop"), "ticks"),
      format: process.env.SHM_TICK_FORMAT === "text" ? "text" : "binary",
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
