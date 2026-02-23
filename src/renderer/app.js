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
const pollersByIdx = {};
const POLL_INTERVAL_MS = 300;

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

function stopQuoteReader(idx) {
  const reader = pollersByIdx[idx];
  if (reader?.timer) {
    clearInterval(reader.timer);
  }
  delete pollersByIdx[idx];

  appState.runStateByIdx[idx] = "END";
  appState.quoteTableByIdx[idx] = buildEndCellsForConfig(appState.displayedConfigs[idx]);
  configListView.render(appState.displayedConfigs);
}

function stopAllQuoteReaders() {
  Object.keys(pollersByIdx).forEach((key) => {
    const reader = pollersByIdx[key];
    if (reader?.timer) clearInterval(reader.timer);
    delete pollersByIdx[key];
  });
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

  const tick = async () => {
    const reader = pollersByIdx[idx];
    if (!reader || reader.inFlight) return;
    if (appState.runStateByIdx[idx] !== "START") return;

    reader.inFlight = true;

    const quoteByMap = { ...(appState.quoteTableByIdx[idx] || {}) };

    try {
      await Promise.all(
        mapNames.map(async (mapName) => {
          const startedAt = Date.now();

          try {
            const res = await window.shm.readQuote(mapName);
            const latencyMs = Date.now() - startedAt;
            const stat = metricsByMap[mapName] || {
              prevTs: 0,
              maxLatencyMs: 0,
              totalLatencyMs: 0,
              samples: 0,
            };

            stat.samples += 1;
            stat.totalLatencyMs += latencyMs;
            stat.maxLatencyMs = Math.max(stat.maxLatencyMs, latencyMs);

            const nowTs = Date.now();
            const tps = stat.prevTs > 0 ? 1000 / Math.max(1, nowTs - stat.prevTs) : 0;
            stat.prevTs = nowTs;
            metricsByMap[mapName] = stat;

            if (res?.status === "FOUND" && res?.data) {
              quoteByMap[mapName] = {
                ...res.data,
                status: "FOUND",
                latencyMs,
                tps,
                maxLatencyMs: stat.maxLatencyMs,
                avgLatencyMs: stat.totalLatencyMs / stat.samples,
              };
              return;
            }

            if (res?.status === "NOT_FOUND") {
              quoteByMap[mapName] = { status: "NOT_FOUND" };
              return;
            }

            quoteByMap[mapName] = {
              status: "ERROR",
              message: res?.message || "Không đọc được dữ liệu map.",
            };
          } catch (err) {
            quoteByMap[mapName] = {
              status: "ERROR",
              message: err?.message || "Lỗi không xác định khi đọc dữ liệu.",
            };
          }
        })
      );

      if (!pollersByIdx[idx] || appState.runStateByIdx[idx] !== "START") {
        return;
      }

      appState.quoteTableByIdx[idx] = quoteByMap;
      configListView.render(appState.displayedConfigs);
    } finally {
      if (pollersByIdx[idx]) {
        pollersByIdx[idx].inFlight = false;
      }
    }
  };

  pollersByIdx[idx] = {
    timer: setInterval(tick, POLL_INTERVAL_MS),
    inFlight: false,
  };

  configListView.render(appState.displayedConfigs);
  tick();
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
