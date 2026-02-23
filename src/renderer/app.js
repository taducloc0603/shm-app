import { appState } from "./state/appState.js";
import { createLoadingOverlay } from "./ui/loadingOverlay.js";
import { createSupabaseService } from "./services/supabaseService.js";
import { createSanRows } from "./ui/sanRows.js";
import { createConfigListView } from "./ui/configListView.js";
import { getPlatform } from "./services/platformService.js";
import { normalizeSans } from "./utils/normalizeSans.js";

const supabaseService = createSupabaseService();

const modal = document.getElementById("modal");
const btnOpen = document.getElementById("btnOpen");
const btnClose = document.getElementById("btnClose");
const btnAddSan = document.getElementById("btnAddSan");
const formCreate = document.getElementById("formCreate");
const listConfigsEl = document.getElementById("listConfigs");
const sanListEl = document.getElementById("sanList");
let platform = "unknown";
const activeReadersByIdx = {};
const globalPoller = {
  timer: null,
  inFlight: false,
  running: false,
};
const POLL_INTERVAL_MS = 30;

function getEffectiveLatencyMs(row, fallbackMs) {
  const ts = Number(row?.time_msc);
  if (!Number.isFinite(ts) || ts <= 0) return fallbackMs;

  const latency = Date.now() - ts;
  if (!Number.isFinite(latency)) return fallbackMs;
  return Math.max(0, latency);
}

const setLoading = createLoadingOverlay(
  document.getElementById("loadingOverlay"),
  document.getElementById("loadingText")
);

const sanRows = createSanRows(sanListEl, {
  checkMapName: (mapName) => window.shm.check(mapName),
  setLoading,
  getCurrentPlatform: async () => platform,
});
const configListView = createConfigListView({
  listEl: listConfigsEl,
  state: appState,
  onActiveToggle: (idx) => {
    appState.activeConfigIdx = appState.activeConfigIdx === idx ? -1 : idx;
    configListView.render(appState.displayedConfigs);
  },
  onRunStateToggle: (idx, value) => {
    if (value === "START") {
      startQuoteReader(idx);
      return;
    }

    stopQuoteReader(idx);
  },
});

function buildEndCellsForConfig(config) {
  const mapNames = normalizeSans(config?.sans);
  const result = {};

  mapNames.forEach((mapName) => {
    const key = String(mapName || "").trim();
    if (!key) return;
    result[key] = { status: "END" };
  });

  return result;
}

function hasActiveReaders() {
  return Object.keys(activeReadersByIdx).length > 0;
}

function stopGlobalPollerIfIdle() {
  if (hasActiveReaders()) return;
  if (globalPoller.timer) {
    clearTimeout(globalPoller.timer);
    globalPoller.timer = null;
  }
  globalPoller.inFlight = false;
  globalPoller.running = false;
}

function ensureGlobalPollerRunning() {
  if (globalPoller.running) return;
  globalPoller.running = true;

  const scheduleNext = (delayMs = POLL_INTERVAL_MS) => {
    if (!globalPoller.running) return;
    if (globalPoller.timer) {
      clearTimeout(globalPoller.timer);
    }
    globalPoller.timer = setTimeout(tick, Math.max(0, delayMs));
  };

  const tick = async () => {
    globalPoller.timer = null;

    if (globalPoller.inFlight) return;

    const activeEntries = Object.entries(activeReadersByIdx)
      .map(([idx, reader]) => [Number(idx), reader])
      .filter(([idx, reader]) =>
        appState.runStateByIdx[idx] === "START" && Array.isArray(reader?.mapNames) && reader.mapNames.length
      );

    if (!activeEntries.length) {
      stopGlobalPollerIfIdle();
      return;
    }

    const unionMapNames = Array.from(
      new Set(activeEntries.flatMap(([, reader]) => reader.mapNames))
    );

    if (!unionMapNames.length) {
      scheduleNext();
      return;
    }

    globalPoller.inFlight = true;

    try {
      const startedAt = Date.now();
      const batchRes = await window.shm.readQuotes(unionMapNames);
      const fallbackLatencyMs = Date.now() - startedAt;

      const rows = Array.isArray(batchRes?.data) ? batchRes.data : [];
      const byMapName = Object.fromEntries(rows.map((r) => [String(r?.map_name || "").trim(), r]));
      const nowTs = Date.now();

      activeEntries.forEach(([idx, reader]) => {
        const quoteByMap = { ...(appState.quoteTableByIdx[idx] || {}) };

        reader.mapNames.forEach((mapName) => {
          const stat = reader.metricsByMap[mapName] || {
            prevTs: 0,
            maxLatencyMs: 0,
            totalLatencyMs: 0,
            samples: 0,
          };

          const row = byMapName[mapName];

          stat.samples += 1;
          const tps = stat.prevTs > 0 ? 1000 / Math.max(1, nowTs - stat.prevTs) : 0;
          stat.prevTs = nowTs;

          if (row?.status === "FOUND") {
            const effectiveLatencyMs = getEffectiveLatencyMs(row, fallbackLatencyMs);
            stat.totalLatencyMs += effectiveLatencyMs;
            stat.maxLatencyMs = Math.max(stat.maxLatencyMs, effectiveLatencyMs);

            quoteByMap[mapName] = {
              ...row,
              spread: Number.isFinite(Number(row.spread))
                ? Number(row.spread)
                : Number(row.ask) - Number(row.bid),
              status: "FOUND",
              latencyMs: effectiveLatencyMs,
              tps,
              maxLatencyMs: stat.maxLatencyMs,
              avgLatencyMs: stat.totalLatencyMs / stat.samples,
            };
          } else if (row?.status === "NOT_FOUND") {
            quoteByMap[mapName] = { status: "NOT_FOUND" };
          } else if (!batchRes?.ok) {
            quoteByMap[mapName] = {
              status: "ERROR",
              message: batchRes?.message || "Không đọc được dữ liệu map.",
            };
          } else {
            quoteByMap[mapName] = {
              status: row?.status || "ERROR",
              message: row?.message || "Không đọc được dữ liệu map.",
            };
          }

          reader.metricsByMap[mapName] = stat;
        });

        appState.quoteTableByIdx[idx] = quoteByMap;
      });

      configListView.render(appState.displayedConfigs);
    } finally {
      globalPoller.inFlight = false;
      scheduleNext();
    }
  };

  scheduleNext(0);
}

function stopQuoteReader(idx) {
  delete activeReadersByIdx[idx];

  appState.runStateByIdx[idx] = "END";
  appState.quoteTableByIdx[idx] = buildEndCellsForConfig(appState.displayedConfigs[idx]);
  configListView.render(appState.displayedConfigs);

  stopGlobalPollerIfIdle();
}

function stopAllQuoteReaders() {
  Object.keys(activeReadersByIdx).forEach((key) => {
    delete activeReadersByIdx[key];
  });
  stopGlobalPollerIfIdle();
}

function startQuoteReader(idx) {
  const config = appState.displayedConfigs[idx];
  const mapNames = normalizeSans(config?.sans)
    .map((v) => String(v || "").trim())
    .filter(Boolean);

  if (!config || !mapNames.length) {
    appState.runStateByIdx[idx] = "END";
    appState.quoteTableByIdx[idx] = buildEndCellsForConfig(config);
    configListView.render(appState.displayedConfigs);
    return;
  }

  stopQuoteReader(idx);

  appState.runStateByIdx[idx] = "START";
  appState.quoteTableByIdx[idx] = buildEndCellsForConfig(config);

  const metricsByMap = {};
  mapNames.forEach((name) => {
    metricsByMap[name] = {
      prevTs: 0,
      maxLatencyMs: 0,
      totalLatencyMs: 0,
      samples: 0,
    };
  });

  activeReadersByIdx[idx] = {
    mapNames,
    metricsByMap,
  };

  configListView.render(appState.displayedConfigs);
  ensureGlobalPollerRunning();
}

btnOpen.onclick = () => {
  modal.style.display = "block";
  if (!sanListEl.children.length) sanRows.addSanRow();
};

btnClose.onclick = () => {
  modal.style.display = "none";
};

btnAddSan.onclick = sanRows.addSanRow;

async function loadConfigs() {
  setLoading(true, "Đang tải danh sách...");
  try {
    stopAllQuoteReaders();
    appState.runStateByIdx = {};
    appState.quoteTableByIdx = {};

    const data = await supabaseService.fetchConfigs();
    configListView.render([...data].reverse());
  } catch (err) {
    console.error(err);
    listConfigsEl.innerHTML =
      '<div style="color:#b91c1c;font-weight:600">Không tải được danh sách từ Supabase.</div>';
  } finally {
    setLoading(false);
  }
}

formCreate.onsubmit = async (e) => {
  e.preventDefault();
  setLoading(true, "Đang lưu cấu hình...");

  const rows = sanRows.getRows();
  if (!(await sanRows.validateRowsFound(rows))) {
    setLoading(false);
    return;
  }

  const fd = new FormData(e.target);
  const payload = {
    group_name: String(fd.get("group_name") || "").trim(),
    point: Number(fd.get("point") || 0),
    open_pts: Number(fd.get("open_pts") || 0),
    confirm_gap_pts: Number(fd.get("confirm_gap_pts") || 0),
    hold_confirm_ms: Number(fd.get("hold_confirm_ms") || 0),
    sans: rows.map((r) => r.querySelector("input").value.trim()),
  };

  if (!payload.group_name) {
    alert("Vui lòng nhập group_name");
    setLoading(false);
    return;
  }

  try {
    await supabaseService.insertConfig(payload);
  } catch (err) {
    console.error(err);
    alert("Lưu thất bại: " + (err?.message || "Không thể kết nối Supabase"));
    setLoading(false);
    return;
  }

  alert("Đã lưu lên Supabase!");
  modal.style.display = "none";
  e.target.reset();
  sanRows.resetRows();
  await loadConfigs();
  setLoading(false);
};

getPlatform()
  .then((v) => {
    platform = v;
  })
  .catch(() => {
    platform = "unknown";
  });

window.addEventListener("beforeunload", () => {
  stopAllQuoteReaders();
});

loadConfigs();
