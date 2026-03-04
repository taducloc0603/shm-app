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
  lastRenderAt: 0,
};
const POLL_INTERVAL_MS = 30;
const RENDER_INTERVAL_MS = 150;
const TPS_ROLLING_WINDOW_MS = 1000;
const BANGKOK_TZ_OFFSET_MINUTES = 7 * 60;

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_US = DAY_MS * 1_000;
const DAY_NS = DAY_MS * 1_000_000;
const MAX_REASONABLE_LATENCY_MS = 60 * 1000;
const EPOCH_SECONDS_THRESHOLD = 1_000_000_000;
const EPOCH_MS_THRESHOLD = 1_000_000_000_000;
const EPOCH_US_THRESHOLD = 1_000_000_000_000_000;
const EPOCH_NS_THRESHOLD = 1_000_000_000_000_000_000;
const UINT32_MOD = 2 ** 32;

function getDayMsFromNow(nowMs) {
  const d = new Date(nowMs);
  return (
    d.getHours() * 60 * 60 * 1000 +
    d.getMinutes() * 60 * 1000 +
    d.getSeconds() * 1000 +
    d.getMilliseconds()
  );
}

function getUtcDayMsFromNow(nowMs) {
  const d = new Date(nowMs);
  return (
    d.getUTCHours() * 60 * 60 * 1000 +
    d.getUTCMinutes() * 60 * 1000 +
    d.getUTCSeconds() * 1000 +
    d.getUTCMilliseconds()
  );
}

function calcDayLatency(nowDayMs, tsDayMs) {
  let diff = nowDayMs - tsDayMs;
  if (diff < 0) diff += DAY_MS; // day rollover
  return Number.isFinite(diff) ? Math.max(0, diff) : null;
}

function calcQuoteSeqDelta(currSeq, prevSeq) {
  if (!Number.isFinite(currSeq) || !Number.isFinite(prevSeq)) return null;
  if (currSeq >= prevSeq) return currSeq - prevSeq;
  // uint32 rollover
  return (UINT32_MOD - prevSeq) + currSeq;
}

function calcLatencyFromTimeMsc(ts, nowMs, expectedMs = null) {
  if (!Number.isFinite(ts) || ts <= 0) return null;

  let normalizedTsMs = null;

  // Epoch nanoseconds
  if (ts >= EPOCH_NS_THRESHOLD) {
    normalizedTsMs = ts / 1_000_000;
  // Epoch microseconds
  } else if (ts >= EPOCH_US_THRESHOLD) {
    normalizedTsMs = ts / 1_000;
  // Epoch milliseconds
  } else if (ts >= EPOCH_MS_THRESHOLD) {
    normalizedTsMs = ts;
  // Epoch seconds (giới hạn upper-bound để tránh nhầm với intraday microseconds)
  } else if (ts >= EPOCH_SECONDS_THRESHOLD && ts < 10_000_000_000) {
    normalizedTsMs = ts * 1_000;
  }

  if (Number.isFinite(normalizedTsMs)) {
    const diff = nowMs - normalizedTsMs;
    return Number.isFinite(diff) ? Math.max(0, diff) : null;
  }

  // Intraday timestamp: ms/us/ns kể từ đầu ngày
  let intradayMs = null;
  if (ts < DAY_MS) {
    intradayMs = ts;
  } else if (ts < DAY_US) {
    intradayMs = ts / 1_000;
  } else if (ts < DAY_NS) {
    intradayMs = ts / 1_000_000;
  }

  if (Number.isFinite(intradayMs)) {
    const localDiff = calcDayLatency(getDayMsFromNow(nowMs), intradayMs);
    const utcDiff = calcDayLatency(getUtcDayMsFromNow(nowMs), intradayMs);

    const candidates = [localDiff, utcDiff].filter((v) => Number.isFinite(v));
    if (!candidates.length) return null;

    const expected = Number(expectedMs);
    if (Number.isFinite(expected) && expected >= 0) {
      return candidates.reduce((best, cur) =>
        Math.abs(cur - expected) < Math.abs(best - expected) ? cur : best
      );
    }

    // Không có baseline thì chọn giá trị nhỏ hơn để tránh lệch timezone lớn.
    return Math.min(...candidates);
  }

  return null;
}

function getEffectiveLatencyMs(row, fallbackMs) {
  const nowMs = Date.now();
  const ts = Number(row?.time_msc);
  const parsed = calcLatencyFromTimeMsc(ts, nowMs, fallbackMs);
  if (Number.isFinite(parsed) && parsed <= MAX_REASONABLE_LATENCY_MS) return parsed;

  const fallback = Number(fallbackMs);
  if (!Number.isFinite(fallback)) return 0;
  return Math.max(0, fallback);
}

function formatIsoWithFixedOffset(nowMs, offsetMinutes = BANGKOK_TZ_OFFSET_MINUTES) {
  const utcMs = Number(nowMs);
  if (!Number.isFinite(utcMs)) return "";

  const shifted = new Date(utcMs + offsetMinutes * 60 * 1000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  const hh = String(shifted.getUTCHours()).padStart(2, "0");
  const mm = String(shifted.getUTCMinutes()).padStart(2, "0");
  const ss = String(shifted.getUTCSeconds()).padStart(2, "0");
  const ms = String(shifted.getUTCMilliseconds()).padStart(3, "0");

  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const tzH = String(Math.floor(abs / 60)).padStart(2, "0");
  const tzM = String(abs % 60).padStart(2, "0");
  return `${y}-${m}-${d}T${hh}:${mm}:${ss}.${ms}${sign}${tzH}:${tzM}`;
}

function createHoldState() {
  return {
    holding: false,
    windowStart: 0,
    log: [],
  };
}

function resetHoldState(sideState) {
  sideState.holding = false;
  sideState.windowStart = 0;
  sideState.log = [];
}

function stablePairKey(exchangeA, exchangeB) {
  return [String(exchangeA || "").trim(), String(exchangeB || "").trim()]
    .sort((a, b) => a.localeCompare(b))
    .join("-");
}

function getOrCreatePairState(pairStates, pairKey) {
  let pairState = pairStates.get(pairKey);
  if (!pairState) {
    pairState = {
      buyState: createHoldState(),
      sellState: createHoldState(),
    };
    pairStates.set(pairKey, pairState);
  }
  return pairState;
}

function calcPairGaps(quoteByMap, exchangeA, exchangeB, pointValue) {
  const quoteA = quoteByMap?.[exchangeA];
  const quoteB = quoteByMap?.[exchangeB];
  if (quoteA?.status !== "FOUND" || quoteB?.status !== "FOUND") {
    return null;
  }

  const askA = Number(quoteA.ask);
  const bidA = Number(quoteA.bid);
  const askB = Number(quoteB.ask);
  const bidB = Number(quoteB.bid);
  const point = Number(pointValue);

  if (![askA, bidA, askB, bidB, point].every(Number.isFinite)) {
    return null;
  }

  const gapBuy = (bidB - askA) * point;
  const gapSell = (askB - bidA) * point;
  if (!Number.isFinite(gapBuy) || !Number.isFinite(gapSell)) {
    return null;
  }

  return { gapBuy, gapSell };
}

function enqueueCsvLog(reader, row) {
  if (!reader?.signal?.csvSessionId) return;

  window.shm
    .enqueueCsvRow(reader.signal.csvSessionId, row)
    .catch((err) => console.error("CSV enqueue failed:", err));
}

function roundToInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

function processBuySignal(reader, pairKey, pairState, gapBuy, isoTime, nowMs) {
  const signal = reader?.signal;
  if (!signal) return;
  if (!Number.isFinite(gapBuy)) return;
  const gapBuyRounded = roundToInt(gapBuy);
  if (!Number.isFinite(gapBuyRounded)) return;

  const confirmGapPts = signal.confirmGapPts;
  const openPts = signal.openPts;
  const holdMs = signal.holdConfirmMs;
  const state = pairState.buyState;

  if (!state.holding) {
    if (gapBuy >= confirmGapPts) {
      state.holding = true;
      state.windowStart = nowMs;
      state.log = [gapBuyRounded];
    }
    return;
  }

  if (gapBuy < confirmGapPts) {
    resetHoldState(state);
    return;
  }

  state.log.push(gapBuyRounded);
  const duration = nowMs - state.windowStart;
  if (duration < holdMs) return;

  if (gapBuy >= openPts) {
    enqueueCsvLog(reader, {
      Time: isoTime,
      Type: "BUY",
      San: pairKey,
      GAP: String(gapBuyRounded),
      LogGAP: state.log
        .map((v) => {
          const n = Number(v);
          return Number.isFinite(n) ? String(Math.round(n)) : "";
        })
        .filter(Boolean)
        .join("|"),
    });
  }

  resetHoldState(state);
}

function processSellSignal(reader, pairKey, pairState, gapSell, isoTime, nowMs) {
  const signal = reader?.signal;
  if (!signal) return;
  if (!Number.isFinite(gapSell)) return;
  const gapSellRounded = roundToInt(gapSell);
  if (!Number.isFinite(gapSellRounded)) return;

  const confirmGapPts = signal.confirmGapPts;
  const openPts = signal.openPts;
  const holdMs = signal.holdConfirmMs;
  const state = pairState.sellState;

  if (!state.holding) {
    if (gapSell <= -confirmGapPts) {
      state.holding = true;
      state.windowStart = nowMs;
      state.log = [gapSellRounded];
    }
    return;
  }

  if (gapSell > -confirmGapPts) {
    resetHoldState(state);
    return;
  }

  state.log.push(gapSellRounded);
  const duration = nowMs - state.windowStart;
  if (duration < holdMs) return;

  if (gapSell <= -openPts) {
    enqueueCsvLog(reader, {
      Time: isoTime,
      Type: "SELL",
      San: pairKey,
      GAP: String(gapSellRounded),
      LogGAP: state.log
        .map((v) => {
          const n = Number(v);
          return Number.isFinite(n) ? String(Math.round(n)) : "";
        })
        .filter(Boolean)
        .join("|"),
    });
  }

  resetHoldState(state);
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
  globalPoller.lastRenderAt = 0;
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
            prevQuoteSeq: null,
            cumulativeTicks: 0,
            tickSamples: [],
            maxLatencyMs: 0,
            totalLatencyMs: 0,
            latencySamples: 0,
          };

          const row = byMapName[mapName];

          let tps = 0;
          const pollerTps = stat.prevTs > 0 ? 1000 / Math.max(1, nowTs - stat.prevTs) : 0;
          stat.prevTs = nowTs;

          if (row?.status === "FOUND") {
            const quoteSeq = Number(row.quote_seq);
            if (Number.isFinite(quoteSeq) && quoteSeq >= 0) {
              const prevQuoteSeq = Number(stat.prevQuoteSeq);
              const seqDelta = calcQuoteSeqDelta(quoteSeq, prevQuoteSeq);
              if (Number.isFinite(seqDelta) && seqDelta >= 0) {
                stat.cumulativeTicks = Number(stat.cumulativeTicks || 0) + seqDelta;
              }

              const samples = Array.isArray(stat.tickSamples) ? stat.tickSamples : [];
              samples.push({ ts: nowTs, ticks: Number(stat.cumulativeTicks || 0) });

              const minTs = nowTs - TPS_ROLLING_WINDOW_MS;
              while (samples.length > 1 && samples[0].ts < minTs) {
                samples.shift();
              }

              if (samples.length >= 2) {
                const first = samples[0];
                const last = samples[samples.length - 1];
                const dt = last.ts - first.ts;
                const tickDelta = last.ticks - first.ticks;
                if (dt > 0 && Number.isFinite(tickDelta) && tickDelta >= 0) {
                  tps = (tickDelta * 1000) / dt;
                }
              }

              stat.tickSamples = samples;
              stat.prevQuoteSeq = quoteSeq;
            } else {
              // fallback khi thiếu quote_seq
              tps = pollerTps;
            }

            const effectiveLatencyMs = getEffectiveLatencyMs(row, fallbackLatencyMs);
            stat.totalLatencyMs += effectiveLatencyMs;
            stat.latencySamples = (stat.latencySamples || 0) + 1;
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
              avgLatencyMs: stat.latencySamples > 0 ? stat.totalLatencyMs / stat.latencySamples : 0,
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

        const config = appState.displayedConfigs[idx];
        const nowMs = Date.now();
        const isoTime = formatIsoWithFixedOffset(nowMs);
        const pointValue = Number(config?.point);
        const exchanges = Array.isArray(reader.mapNames) ? reader.mapNames : [];
        const processedPairKeys = new Set();

        for (let i = 0; i < exchanges.length; i += 1) {
          for (let j = i + 1; j < exchanges.length; j += 1) {
            const exchangeA = String(exchanges[i] || "").trim();
            const exchangeB = String(exchanges[j] || "").trim();
            if (!exchangeA || !exchangeB || exchangeA === exchangeB) continue;

            const pairKey = stablePairKey(exchangeA, exchangeB);
            if (processedPairKeys.has(pairKey)) continue;
            processedPairKeys.add(pairKey);

            const gaps = calcPairGaps(quoteByMap, exchangeA, exchangeB, pointValue);
            if (!gaps) continue;

            const pairState = getOrCreatePairState(reader.signal.pairStates, pairKey);
            processBuySignal(reader, pairKey, pairState, gaps.gapBuy, isoTime, nowMs);
            processSellSignal(reader, pairKey, pairState, gaps.gapSell, isoTime, nowMs);
          }
        }
      });

      if (nowTs - globalPoller.lastRenderAt >= RENDER_INTERVAL_MS) {
        configListView.render(appState.displayedConfigs);
        globalPoller.lastRenderAt = nowTs;
      }
    } finally {
      globalPoller.inFlight = false;
      scheduleNext();
    }
  };

  scheduleNext(0);
}

function stopQuoteReader(idx) {
  const reader = activeReadersByIdx[idx];
  if (reader?.signal?.csvSessionId) {
    window.shm
      .endCsvSession(reader.signal.csvSessionId)
      .catch((err) => console.error("CSV endSession failed:", err));
  }

  delete activeReadersByIdx[idx];

  appState.runStateByIdx[idx] = "END";
  appState.quoteTableByIdx[idx] = buildEndCellsForConfig(appState.displayedConfigs[idx]);
  configListView.render(appState.displayedConfigs);

  stopGlobalPollerIfIdle();
}

function stopAllQuoteReaders() {
  Object.keys(activeReadersByIdx).forEach((key) => {
    stopQuoteReader(Number(key));
  });
  stopGlobalPollerIfIdle();
}

async function startQuoteReader(idx) {
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
      prevQuoteSeq: null,
      cumulativeTicks: 0,
      tickSamples: [],
      maxLatencyMs: 0,
      totalLatencyMs: 0,
      latencySamples: 0,
    };
  });

  activeReadersByIdx[idx] = {
    mapNames,
    metricsByMap,
    signal: {
      confirmGapPts: Number(config.confirm_gap_pts) || 0,
      openPts: Number(config.open_pts) || 0,
      holdConfirmMs: Math.max(0, Number(config.hold_confirm_ms) || 0),
      pairStates: new Map(),
      csvSessionId: null,
    },
  };

  try {
    const startTimestamp = Date.now();
    const sessionRes = await window.shm.startCsvSession(startTimestamp);
    if (sessionRes?.ok && activeReadersByIdx[idx]) {
      activeReadersByIdx[idx].signal.csvSessionId = sessionRes.sessionId;
    } else if (sessionRes?.ok) {
      // Reader đã bị stop trong lúc chờ tạo session => đóng session để tránh leak file handle.
      window.shm
        .endCsvSession(sessionRes.sessionId)
        .catch((err) => console.error("CSV cleanup failed:", err));
    } else if (!sessionRes?.ok) {
      console.error("Không tạo được CSV session:", sessionRes?.message || "Unknown error");
    }
  } catch (err) {
    console.error("Không tạo được CSV session:", err);
  }

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
