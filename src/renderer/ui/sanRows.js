export function createSanRows(sanListEl, options = {}) {
  const {
    checkMapName = async () => ({ ok: false, status: "UNSUPPORTED" }),
    setLoading = () => {},
    getCurrentPlatform = async () => "unknown",
  } = options;

  let shownUnsupportedHint = false;

  function setBadge(el, status) {
    el.className = "badge " + status;
    el.textContent = status;
  }

  function setRowError(row, message = "") {
    const errorEl = row.querySelector(".san-error");
    if (!errorEl) return;
    errorEl.textContent = message;
    errorEl.style.display = message ? "block" : "none";
  }

  async function checkRow(row) {
    const input = row.querySelector("input");
    const badge = row.querySelector(".badge");
    const v = input.value.trim();

    if (!v) {
      setBadge(badge, "EMPTY");
      setRowError(row, "Vui lòng nhập map name trước khi check.");
      return false;
    }

    setRowError(row, "");
    setBadge(badge, "CHECKING");

    try {
      const res = await checkMapName(v);
      const status = res?.status || "ERROR";
      setBadge(badge, status);

      if (status === "ERROR") {
        setRowError(row, res?.message || "Có lỗi khi check map name.");
      } else if (status === "INVALID") {
        setRowError(row, res?.message || "Map name không hợp lệ.");
      } else if (status === "NOT_FOUND") {
        setRowError(row, "Không tìm thấy map name trong shared memory.");
      } else {
        setRowError(row, "");
      }

      if (status === "UNSUPPORTED" && !shownUnsupportedHint) {
        shownUnsupportedHint = true;
        const platform = await getCurrentPlatform();
        alert("Tính năng Check SHM hiện chỉ hỗ trợ trên Windows.\nMáy hiện tại: " + platform);
      }

      return status === "FOUND";
    } catch (err) {
      console.error(err);
      setBadge(badge, "ERROR");
      setRowError(row, err?.message || "Lỗi không xác định khi check map name.");
      return false;
    }
  }

  function addSanRow() {
    const row = document.createElement("div");
    row.className = "san-row";

    row.innerHTML = `
      <input placeholder="Map name..." />
      <button type="button">Check</button>
      <span class="badge">-</span>
      <div class="san-error" style="display:none"></div>
    `;

    const input = row.querySelector("input");
    const btn = row.querySelector("button");
    const badge = row.querySelector(".badge");

    btn.onclick = async () => {
      setLoading(true, "Đang check map name...");
      await checkRow(row);
      setLoading(false);
    };

    sanListEl.appendChild(row);
  }

  function getRows() {
    return Array.from(document.querySelectorAll(".san-row"));
  }

  async function validateRowsFound(rows) {
    for (const row of rows) {
      const ok = await checkRow(row);
      if (!ok) {
        return false;
      }
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
    validateRowsFound,
    resetRows,
  };
}
