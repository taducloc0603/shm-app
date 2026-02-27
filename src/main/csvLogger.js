const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const sessions = new Map();
let sessionSeq = 0;

function ensureDataDir() {
  const desktopDir = app.getPath("desktop");
  const dataDir = path.join(desktopDir, "shm-data");
  fs.mkdirSync(dataDir, { recursive: true });
  return dataDir;
}

function processQueue(session) {
  if (!session || session.writing) return;
  if (!session.queue.length) return;

  session.writing = true;
  const line = session.queue.shift();

  session.stream.write(line, (err) => {
    session.writing = false;
    if (err) {
      session.lastError = err;
    }
    processQueue(session);
  });
}

function startCsvSession(startTimestamp) {
  const ts = Number(startTimestamp);
  if (!Number.isFinite(ts) || ts <= 0) {
    return { ok: false, message: "startTimestamp không hợp lệ." };
  }

  const dataDir = ensureDataDir();
  const filePath = path.join(dataDir, `shm-data-${Math.trunc(ts)}.csv`);
  const stream = fs.createWriteStream(filePath, { flags: "a", encoding: "utf8" });
  stream.write("Time,Type,San,GAP,LogGAP\n");

  const sessionId = `csv-${Date.now()}-${sessionSeq++}`;
  sessions.set(sessionId, {
    filePath,
    stream,
    queue: [],
    writing: false,
    lastError: null,
  });

  return { ok: true, sessionId, filePath };
}

function enqueueCsvRow(sessionId, row) {
  const session = sessions.get(sessionId);
  if (!session) {
    return { ok: false, message: "CSV session không tồn tại." };
  }

  if (session.lastError) {
    return { ok: false, message: session.lastError.message || "Lỗi ghi file CSV." };
  }

  const normalized = {
    Time: String(row?.Time || ""),
    Type: String(row?.Type || ""),
    San: String(row?.San || ""),
    GAP: String(row?.GAP || ""),
    LogGAP: String(row?.LogGAP || ""),
  };

  const line = `${normalized.Time},${normalized.Type},${normalized.San},${normalized.GAP},${normalized.LogGAP}\n`;
  session.queue.push(line);
  processQueue(session);

  return { ok: true };
}

function endCsvSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return { ok: true };

  sessions.delete(sessionId);
  const close = () => {
    try {
      session.stream.end();
    } catch (_err) {
      // noop
    }
  };

  if (session.writing || session.queue.length) {
    const flushTimer = setInterval(() => {
      if (!session.writing && session.queue.length === 0) {
        clearInterval(flushTimer);
        close();
      }
    }, 10);
  } else {
    close();
  }

  return { ok: true };
}

function endAllCsvSessions() {
  Array.from(sessions.keys()).forEach((sessionId) => {
    endCsvSession(sessionId);
  });
}

module.exports = {
  startCsvSession,
  enqueueCsvRow,
  endCsvSession,
  endAllCsvSessions,
};