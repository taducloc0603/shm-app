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

  async function checkRow(row) {
    const input = row.querySelector("input");
    const badge = row.querySelector(".badge");
    const v = input.value.trim();

    if (!v) {
      setBadge(badge, "EMPTY");
      return false;
    }

    setBadge(badge, "CHECKING");

    try {
      const res = await checkMapName(v);
      const status = res?.status || "ERROR";
      setBadge(badge, status);

      if (status === "UNSUPPORTED" && !shownUnsupportedHint) {
        shownUnsupportedHint = true;
        const platform = await getCurrentPlatform();
        alert("Tính năng Check SHM hiện chỉ hỗ trợ trên Windows.\nMáy hiện tại: " + platform);
      }

      return status === "FOUND";
    } catch (err) {
      console.error(err);
      setBadge(badge, "ERROR");
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
