const fs = require("fs");
const path = require("path");
const { app } = require("electron");
const { parse } = require("csv-parse/sync");
const { stringify } = require("csv-stringify/sync");
const { randomUUID } = require("crypto");

const CSV_HEADERS = [
  "id",
  "group_name",
  "point",
  "open_pts",
  "confirm_gap_pts",
  "hold_confirm_ms",
  "sans",
  "created_at",
];

let appendQueue = Promise.resolve();

function getConfigPath() {
  const desktopDir = app.getPath("desktop");
  return path.join(desktopDir, "shm-config.csv");
}

function ensureConfigFileExists() {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    throw new Error("Không tìm thấy shm-config.csv trên Desktop");
  }
  return configPath;
}

function ensureValidHeader(content) {
  const headerRows = parse(content, {
    to_line: 1,
    relax_quotes: true,
    bom: true,
  });

  const header = Array.isArray(headerRows?.[0]) ? headerRows[0] : [];
  const ok =
    header.length === CSV_HEADERS.length &&
    CSV_HEADERS.every((name, idx) => header[idx] === name);

  if (!ok) {
    throw new Error(`Header CSV không hợp lệ. Cần đúng: ${CSV_HEADERS.join(",")}`);
  }
}

function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseConfigRow(row, rowIndex) {
  try {
    const id = String(row?.id || "").trim();
    const groupName = String(row?.group_name || "").trim();
    const point = toFiniteNumber(row?.point);
    const openPts = toFiniteNumber(row?.open_pts);
    const confirmGapPts = toFiniteNumber(row?.confirm_gap_pts);
    const holdConfirmMs = toFiniteNumber(row?.hold_confirm_ms);
    const createdAt = String(row?.created_at || "").trim();

    const sansRaw = row?.sans;
    const sans = JSON.parse(String(sansRaw || ""));

    if (!id || !groupName || !createdAt) {
      throw new Error("Thiếu cột bắt buộc");
    }

    if (
      [point, openPts, confirmGapPts, holdConfirmMs].some((v) => !Number.isFinite(v))
    ) {
      throw new Error("Cột number không hợp lệ");
    }

    if (!Array.isArray(sans) || sans.some((s) => typeof s !== "string")) {
      throw new Error("sans không phải string[]");
    }

    const createdAtTs = Date.parse(createdAt);
    if (!Number.isFinite(createdAtTs)) {
      throw new Error("created_at không hợp lệ");
    }

    return {
      id,
      group_name: groupName,
      point,
      open_pts: openPts,
      confirm_gap_pts: confirmGapPts,
      hold_confirm_ms: holdConfirmMs,
      sans,
      created_at: createdAt,
      _created_at_ts: createdAtTs,
    };
  } catch (err) {
    console.warn(`[config:list] Skip dòng ${rowIndex}: ${err?.message || "Lỗi parse"}`);
    return null;
  }
}

function listConfigs() {
  const configPath = ensureConfigFileExists();
  const content = fs.readFileSync(configPath, "utf8");

  ensureValidHeader(content);

  const rows = parse(content, {
    columns: true,
    bom: true,
    skip_empty_lines: true,
    skip_records_with_error: true,
    relax_quotes: true,
    relax_column_count: true,
    trim: false,
  });

  const parsed = rows
    .map((row, idx) => parseConfigRow(row, idx + 2))
    .filter(Boolean)
    .sort((a, b) => b._created_at_ts - a._created_at_ts)
    .map(({ _created_at_ts, ...rest }) => rest);

  return parsed;
}

function validateCreatePayload(payload) {
  const groupName = String(payload?.group_name || "").trim();
  const point = toFiniteNumber(payload?.point);
  const openPts = toFiniteNumber(payload?.open_pts);
  const confirmGapPts = toFiniteNumber(payload?.confirm_gap_pts);
  const holdConfirmMs = toFiniteNumber(payload?.hold_confirm_ms);
  const sans = Array.isArray(payload?.sans)
    ? payload.sans.map((v) => String(v || "").trim()).filter(Boolean)
    : [];

  if (!groupName) {
    throw new Error("group_name không được để trống");
  }

  if (sans.length < 2 || sans.some((s) => typeof s !== "string" || !s.trim())) {
    throw new Error("sans phải là mảng string và có ít nhất 2 phần tử");
  }

  if (![point, openPts, confirmGapPts].every(Number.isFinite)) {
    throw new Error("point/open_pts/confirm_gap_pts phải là số hợp lệ");
  }

  if (!Number.isFinite(holdConfirmMs) || holdConfirmMs <= 0) {
    throw new Error("hold_confirm_ms phải lớn hơn 0");
  }

  return {
    group_name: groupName,
    point,
    open_pts: openPts,
    confirm_gap_pts: confirmGapPts,
    hold_confirm_ms: holdConfirmMs,
    sans,
  };
}

function appendRecordWithLock(record) {
  const task = async () => {
    const configPath = ensureConfigFileExists();
    const line = stringify([record], {
      header: false,
      columns: CSV_HEADERS,
    });

    await fs.promises.appendFile(configPath, line, "utf8");
  };

  appendQueue = appendQueue.then(task, task);
  return appendQueue;
}

async function createConfig(payload) {
  const input = validateCreatePayload(payload);
  const record = {
    id: randomUUID(),
    group_name: input.group_name,
    point: input.point,
    open_pts: input.open_pts,
    confirm_gap_pts: input.confirm_gap_pts,
    hold_confirm_ms: input.hold_confirm_ms,
    sans: JSON.stringify(input.sans),
    created_at: new Date().toISOString(),
  };

  await appendRecordWithLock(record);

  return {
    ...record,
    sans: input.sans,
  };
}

module.exports = {
  getConfigPath,
  listConfigs,
  createConfig,
};