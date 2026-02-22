/* =========================
     Supabase init
  ========================== */
  const SUPABASE_URL = "https://yrrzgssbafjpkrsetsot.supabase.co";
  const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inlycnpnc3NiYWZqcGtyc2V0c290Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE1OTU1MjYsImV4cCI6MjA4NzE3MTUyNn0.H9LL2VcNlA_n1HjcK3IH_8US8HMVW6hOBbHHp-5MobE";

  // Không để app crash nếu CDN Supabase chưa load / mất mạng.
  // Nếu crash ở đây thì các event (ví dụ nút "+ Tạo") sẽ không được bind.
  let supabase = null;
  let platform = "unknown";
  let shownUnsupportedHint = false;
  let displayedConfigs = [];
  let activeConfigIdx = -1;
  const runStateByIdx = {};

  function getSupabaseClient() {
    if (!supabase && window.supabase?.createClient) {
      supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    }
    return supabase;
  }

  async function ensureSupabaseLoaded(timeoutMs = 3000) {
    if (window.supabase?.createClient) return true;

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await new Promise(r => setTimeout(r, 100));
      if (window.supabase?.createClient) return true;
    }

    return false;
  }

  async function insertConfig(payload) {
    // Ưu tiên SDK nếu có
    const sdkReady = await ensureSupabaseLoaded();
    const client = sdkReady ? getSupabaseClient() : null;

    if (client) {
      const { error } = await client.from("configs").insert(payload);
      if (error) throw new Error(error.message || "Supabase SDK insert failed");
      return;
    }

    // Fallback: gọi REST API trực tiếp khi CDN SDK không load được trong Electron
    const res = await fetch(`${SUPABASE_URL}/rest/v1/configs`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const data = await res.json();
        msg = data?.message || data?.error || msg;
      } catch (_) {}
      throw new Error(msg);
    }
  }

  async function initPlatform() {
    try {
      if (window.shm?.getPlatform) {
        platform = await window.shm.getPlatform();
      }
    } catch (_) {
      platform = "unknown";
    }
  }

  initPlatform();

  /* =========================
     Modal control
  ========================== */
  const modal = document.getElementById("modal");
  const btnOpen = document.getElementById("btnOpen");
  const btnClose = document.getElementById("btnClose");
  const sanList = document.getElementById("sanList");
  const loadingOverlay = document.getElementById("loadingOverlay");
  const loadingText = document.getElementById("loadingText");

  function setLoading(isLoading, message = "Đang xử lý...") {
    if (!loadingOverlay) return;
    loadingText.textContent = message;
    loadingOverlay.style.display = isLoading ? "flex" : "none";
  }

  btnOpen.onclick = () => {
    modal.style.display = "block";
    if (!sanList.children.length) addSanRow();
  };

  btnClose.onclick = () => modal.style.display = "none";

  /* =========================
     Sàn rows
  ========================== */
  document.getElementById("btnAddSan").onclick = addSanRow;

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
      const v = input.value.trim();
      if (!v) {
        setBadge(badge, "EMPTY");
        return;
      }

      // TẠM THỜI DISABLE CHECK MAP NAME THEO YÊU CẦU.
      // Giữ lại đoạn logic cũ để sau này bật lại dễ dàng.
      setBadge(badge, "SKIPPED");

      /*
      setBadge(badge, "CHECKING");

      try {
        const res = await window.shm.check(v);
        setBadge(badge, res?.status || "ERROR");

        if (res?.status === "UNSUPPORTED" && !shownUnsupportedHint) {
          shownUnsupportedHint = true;
          alert("Tính năng Check SHM hiện chỉ hỗ trợ trên Windows.\nMáy hiện tại: " + platform);
        }
      } catch (err) {
        console.error(err);
        setBadge(badge, "ERROR");
      }
      */
    };

    sanList.appendChild(row);
  }

  function setBadge(el, status) {
    el.className = "badge " + status;
    el.textContent = status;
  }

  function escapeHtml(v) {
    return String(v ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  async function fetchConfigs() {
    // Ưu tiên SDK
    const sdkReady = await ensureSupabaseLoaded(1200);
    const client = sdkReady ? getSupabaseClient() : null;

    if (client) {
      const { data, error } = await client
        .from("configs")
        .select("*")
        .limit(200);

      if (error) throw new Error(error.message || "Không tải được danh sách");
      return data || [];
    }

    // Fallback REST
    const res = await fetch(`${SUPABASE_URL}/rest/v1/configs?select=*`, {
      method: "GET",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  }

  function normalizeSans(sans) {
    if (Array.isArray(sans)) return sans;
    if (typeof sans === "string") {
      try {
        const parsed = JSON.parse(sans);
        if (Array.isArray(parsed)) return parsed;
      } catch (_) {}
      return sans ? [sans] : [];
    }
    return [];
  }

  function renderConfigs(items) {
    const wrap = document.getElementById("listConfigs");
    if (!items.length) {
      wrap.innerHTML = "";
      activeConfigIdx = -1;
      return;
    }

    displayedConfigs = [...items];

    const cards = displayedConfigs.map((it, idx) => {
      const sans = normalizeSans(it.sans);
      const isActive = idx === activeConfigIdx;
      const runState = runStateByIdx[idx] || "END";
      const headerCols = sans.length
        ? sans.map((s) => `<th>${escapeHtml(s)}</th>`).join("")
        : "<th>(chưa có sàn)</th>";

      const emptyCells = sans.length
        ? sans.map(() => "<td>-</td>").join("")
        : "<td>-</td>";

      return `
        <div class="config-card">
          <div class="config-head">
            <h4 class="config-title">${runState === "START" ? '<span class="run-label">START</span>' : ''}${escapeHtml(it.group_name || "(không có tên)")}</h4>
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

    wrap.innerHTML = `<div class="config-list">${cards}</div>`;

    wrap.querySelectorAll(".btn-active").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.getAttribute("data-idx"));
        activeConfigIdx = activeConfigIdx === idx ? -1 : idx;
        renderConfigs(displayedConfigs);
      });
    });

    wrap.querySelectorAll(".btn-toggle").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.getAttribute("data-idx"));
        const value = btn.getAttribute("data-value");
        runStateByIdx[idx] = value;
        renderConfigs(displayedConfigs);
      });
    });
  }

  async function loadConfigs() {
    setLoading(true, "Đang tải danh sách...");
    try {
      const data = await fetchConfigs();
      renderConfigs([...data].reverse());
    } catch (err) {
      console.error(err);
      document.getElementById("listConfigs").innerHTML =
        '<div style="color:#b91c1c;font-weight:600">Không tải được danh sách từ Supabase.</div>';
    } finally {
      setLoading(false);
    }
  }

  /* =========================
     Submit form
  ========================== */
  document.getElementById("formCreate").onsubmit = async (e) => {
    e.preventDefault();
    setLoading(true, "Đang lưu cấu hình...");

    const rows = Array.from(document.querySelectorAll(".san-row"));

    // 1) TẠM THỜI BỎ CHECK MAP NAME TRƯỚC KHI LƯU.
    // Chỉ validate không để trống map_name. Logic check tồn tại SHM được comment lại bên dưới.
    for (const row of rows) {
      const input = row.querySelector("input");
      const badge = row.querySelector(".badge");
      const v = input.value.trim();

      if (!v) {
        setBadge(badge, "EMPTY");
        setLoading(false);
        return;
      }

      setBadge(badge, "SKIPPED");
    }

    /*
    // 1) Check tất cả sàn (logic cũ - bật lại khi cần)
    for (const row of rows) {
      const input = row.querySelector("input");
      const badge = row.querySelector(".badge");
      const v = input.value.trim();

      if (!v) {
        setBadge(badge, "NOT_FOUND");
        return;
      }

      setBadge(badge, "CHECKING");

      const res = await window.shm.check(v);

      if (!res || res.status !== "FOUND") {
        setBadge(badge, res?.status || "ERROR");
        return;
      }

      setBadge(badge, "FOUND");
    }
    */

    // 2) Gom data
    const fd = new FormData(e.target);

    const payload = {
      group_name: String(fd.get("group_name") || "").trim(),
      point: Number(fd.get("point") || 0),
      open_pts: Number(fd.get("open_pts") || 0),
      confirm_gap_pts: Number(fd.get("confirm_gap_pts") || 0),
      hold_confirm_ms: Number(fd.get("hold_confirm_ms") || 0),
      sans: rows.map(r => r.querySelector("input").value.trim()),
    };

    if (!payload.group_name) {
      alert("Vui lòng nhập group_name");
      setLoading(false);
      return;
    }

    // 3) Insert Supabase
    try {
      await insertConfig(payload);
    } catch (err) {
      console.error(err);
      alert("Lưu thất bại: " + (err?.message || "Không thể kết nối Supabase"));
      setLoading(false);
      return;
    }

    alert("Đã lưu lên Supabase!");
    modal.style.display = "none";
    e.target.reset();
    sanList.innerHTML = "";
    addSanRow();
    await loadConfigs();
    setLoading(false);
  };

  loadConfigs();
