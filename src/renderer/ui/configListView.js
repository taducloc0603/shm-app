import { escapeHtml } from "../utils/escapeHtml.js";
import { normalizeSans } from "../utils/normalizeSans.js";

export function createConfigListView({ listEl, state, onActiveToggle, onRunStateToggle }) {
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
      const headerCols = sans.length
        ? sans.map((s) => `<th>${escapeHtml(s)}</th>`).join("")
        : "<th>(chưa có sàn)</th>";

      const emptyCells = sans.length
        ? sans.map(() => "<td>-</td>").join("")
        : "<td>-</td>";

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
                    <td class="row-label">Bid</td>
                    ${emptyCells}
                  </tr>
                  <tr>
                    <td class="row-label">Ask</td>
                    ${emptyCells}
                  </tr>
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
