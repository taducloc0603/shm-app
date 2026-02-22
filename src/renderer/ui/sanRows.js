export function createSanRows(sanListEl) {
  function setBadge(el, status) {
    el.className = "badge " + status;
    el.textContent = status;
  }

  function addSanRow() {
    const row = document.createElement("div");
    row.className = "san-row";

    row.innerHTML = `
      <input placeholder="Map name..." />
      <button type="button">Check</button>
      <span class="badge">-</span>
    `;

    const input = row.querySelector("input");
    const btn = row.querySelector("button");
    const badge = row.querySelector(".badge");

    // Tạm disable check theo yêu cầu hiện tại
    btn.onclick = () => {
      const v = input.value.trim();
      if (!v) {
        setBadge(badge, "EMPTY");
        return;
      }
      setBadge(badge, "SKIPPED");
    };

    sanListEl.appendChild(row);
  }

  function getRows() {
    return Array.from(document.querySelectorAll(".san-row"));
  }

  function validateRowsNotEmpty(rows) {
    for (const row of rows) {
      const input = row.querySelector("input");
      const badge = row.querySelector(".badge");
      const v = input.value.trim();

      if (!v) {
        setBadge(badge, "EMPTY");
        return false;
      }

      setBadge(badge, "SKIPPED");
    }

    return true;
  }

  function resetRows() {
    sanListEl.innerHTML = "";
    addSanRow();
  }

  return {
    addSanRow,
    getRows,
    validateRowsNotEmpty,
    resetRows,
  };
}
