import { escapeHtml } from "../utils/escapeHtml.js";
import { normalizeSans } from "../utils/normalizeSans.js";

export function createConfigListView({ listEl, state, onActiveToggle, onRunStateToggle }) {
  function formatNumber(value, digits = 5) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "-";
    return n.toFixed(digits);
  }

  function formatTrimTrailingZeros(value, digits = 5) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "-";
    return n.toFixed(digits).replace(/\.?0+$/, "");
  }

  function formatLatency(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "--";
    return String(Math.round(n));
  }

  function formatTimeMsc(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return "-";
    const d = new Date(n);
    if (Number.isNaN(d.getTime())) return "-";
    return d.toLocaleTimeString("vi-VN", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }) +
      "." +
      String(d.getMilliseconds()).padStart(3, "0");
  }

  function formatGapValue(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "-";
    return n.toFixed(2);
  }

  function getPairGapValues(sans, quoteByMap, point) {
    if (!Array.isArray(sans) || sans.length < 2) return [];

    const pointValue = Number(point);
    if (!Number.isFinite(pointValue)) return [];

    const pairs = [];

    for (let i = 0; i < sans.length; i += 1) {
      for (let j = i + 1; j < sans.length; j += 1) {
        const mapA = sans[i];
        const mapB = sans[j];
        const quoteA = quoteByMap?.[mapA];
        const quoteB = quoteByMap?.[mapB];

        let gapBuy = null;
        let gapSell = null;

        if (quoteA?.status === "FOUND" && quoteB?.status === "FOUND") {
          const askA = Number(quoteA.ask);
          const bidA = Number(quoteA.bid);
          const askB = Number(quoteB.ask);
          const bidB = Number(quoteB.bid);

          if ([askA, bidA, askB, bidB].every(Number.isFinite)) {
            gapBuy = (bidB - askA) * pointValue;
            gapSell = (askB - bidA) * pointValue;
          }
        }

        pairs.push({
          pairLabel: `${mapA}-${mapB}`,
          gapBuy,
          gapSell,
        });
      }
    }

    return pairs;
  }

  function getCellText(cell, field) {
    if (!cell || cell.status === "END") return "-";

    if (cell.status === "NOT_FOUND") {
      if (field === "status") return "NOT_FOUND";
      return "-";
    }

    if (cell.status === "ERROR") {
      if (field === "status") return "ERROR";
      return "-";
    }

    switch (field) {
      case "symbol":
        return cell.symbol || "-";
      case "bid":
        return formatTrimTrailingZeros(cell.bid, 5);
      case "ask":
        return formatTrimTrailingZeros(cell.ask, 5);
      case "spread":
        return formatTrimTrailingZeros(cell.spread, 5);
      case "latencyMs":
        return formatLatency(cell.latencyMs);
      case "tps":
        return formatNumber(cell.tps, 1);
      case "time":
        return formatTimeMsc(cell.time_msc);
      case "maxLatencyMs":
        return formatLatency(cell.maxLatencyMs);
      case "avgLatencyMs":
        return formatLatency(cell.avgLatencyMs);
      case "status":
        return cell.status || "-";
      default:
        return "-";
    }
  }

  function render(items) {
    if (!items.length) {
      listEl.innerHTML = "";
      state.activeConfigIdx = -1;
      state.displayedConfigs = [];
      return;
    }

    state.displayedConfigs = [...items];

    const cards = state.displayedConfigs.map((it, idx) => {
      const sans = normalizeSans(it.sans);
      const isActive = idx === state.activeConfigIdx;
      const runState = state.runStateByIdx[idx] || "END";
      const quoteByMap = state.quoteTableByIdx[idx] || {};
      const pairGaps = getPairGapValues(sans, quoteByMap, it.point);
      const headerCols = sans.length
        ? sans.map((s) => `<th>${escapeHtml(s)}</th>`).join("")
        : "<th>(chưa có sàn)</th>";

      const makeRowCells = (field) => sans.length
        ? sans
            .map((mapName) => `<td>${escapeHtml(getCellText(quoteByMap[mapName], field))}</td>`)
            .join("")
        : "<td>-</td>";

      const gapRowsHtml = pairGaps.length
        ? pairGaps
            .map((pair, pairIdx) => `
                  <tr class="gap-pair-header">
                    <td colspan="${Math.max(2, sans.length + 1)}">Cặp sàn: ${escapeHtml(pair.pairLabel)}</td>
                  </tr>
                  <tr class="gap-row">
                    <td class="row-label gap-sub-label">GAP_BUY</td>
                    <td colspan="${Math.max(1, sans.length)}" class="gap-value gap-buy-value">${escapeHtml(formatGapValue(pair.gapBuy))}</td>
                  </tr>
                  <tr class="gap-row">
                    <td class="row-label gap-sub-label">GAP_SELL</td>
                    <td colspan="${Math.max(1, sans.length)}" class="gap-value gap-sell-value">${escapeHtml(formatGapValue(pair.gapSell))}</td>
                  </tr>
                  ${pairIdx < pairGaps.length - 1
                    ? `<tr class="gap-pair-sep"><td colspan="${Math.max(2, sans.length + 1)}"></td></tr>`
                    : ""}
                `)
            .join("")
        : `
                  <tr>
                    <td class="row-label">GAP_BUY</td>
                    <td colspan="${Math.max(1, sans.length)}" class="gap-value">-</td>
                  </tr>
                  <tr>
                    <td class="row-label">GAP_SELL</td>
                    <td colspan="${Math.max(1, sans.length)}" class="gap-value">-</td>
                  </tr>
                `;

      return `
        <div class="config-card">
          <div class="config-head">
            <h4 class="config-title">${runState === "START" ? '<span class="run-label">START</span>' : ""}${escapeHtml(it.group_name || "(không có tên)")}</h4>
            <button type="button" class="btn-active" data-idx="${idx}">${isActive ? "Hide" : "Show"}</button>
          </div>
          <div class="config-meta">
            <div><b>Point:</b> ${escapeHtml(it.point)}</div>
            <div><b>Open PTS:</b> ${escapeHtml(it.open_pts)}</div>
            <div><b>Confirm Gap:</b> ${escapeHtml(it.confirm_gap_pts)}</div>
            <div><b>Hold MS:</b> ${escapeHtml(it.hold_confirm_ms)}</div>
          </div>
          <div class="sans-wrap">
            ${sans.length
              ? sans.map((s) => `<span class="sans-item">${escapeHtml(s)}</span>`).join("")
              : '<span class="sans-item">(không có sàn)</span>'}
          </div>

          ${isActive ? `
            <div class="active-panel">
              <div class="active-head">
                <h3>Thông tin</h3>
                <div class="active-actions">
                  <button type="button" class="btn-toggle ${runState === "START" ? "is-active" : ""}" data-idx="${idx}" data-value="START">Start</button>
                  <button type="button" class="btn-toggle ${runState === "END" ? "is-active" : ""}" data-idx="${idx}" data-value="END">End</button>
                </div>
              </div>

              <table class="san-table">
                <thead>
                  <tr>
                    <th></th>
                    ${headerCols}
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td class="row-label">Symbol</td>
                    ${makeRowCells("symbol")}
                  </tr>
                  <tr>
                    <td class="row-label">Bid</td>
                    ${makeRowCells("bid")}
                  </tr>
                  <tr>
                    <td class="row-label">Ask</td>
                    ${makeRowCells("ask")}
                  </tr>
                  <tr>
                    <td class="row-label">Spread</td>
                    ${makeRowCells("spread")}
                  </tr>
                  <tr>
                    <td class="row-label">Latency(ms)</td>
                    ${makeRowCells("latencyMs")}
                  </tr>
                  <tr>
                    <td class="row-label">TPS</td>
                    ${makeRowCells("tps")}
                  </tr>
                  <tr>
                    <td class="row-label">Time</td>
                    ${makeRowCells("time")}
                  </tr>
                  <tr>
                    <td class="row-label">Max Lat(ms)</td>
                    ${makeRowCells("maxLatencyMs")}
                  </tr>
                  <tr>
                    <td class="row-label">Avg Lat(ms)</td>
                    ${makeRowCells("avgLatencyMs")}
                  </tr>
                  <tr>
                    <td class="row-label">Status</td>
                    ${makeRowCells("status")}
                  </tr>
                  ${gapRowsHtml}
                </tbody>
              </table>
            </div>
          ` : ""}
        </div>
      `;
    }).join("");

    listEl.innerHTML = `<div class="config-list">${cards}</div>`;

    listEl.querySelectorAll(".btn-active").forEach((btn) => {
      btn.addEventListener("click", () => onActiveToggle(Number(btn.getAttribute("data-idx"))));
    });

    listEl.querySelectorAll(".btn-toggle").forEach((btn) => {
      btn.addEventListener("click", () => {
        onRunStateToggle(Number(btn.getAttribute("data-idx")), btn.getAttribute("data-value"));
      });
    });
  }

  return { render };
}
