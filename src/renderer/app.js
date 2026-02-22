import { appState } from "./state/appState.js";
import { createLoadingOverlay } from "./ui/loadingOverlay.js";
import { createSupabaseService } from "./services/supabaseService.js";
import { createSanRows } from "./ui/sanRows.js";
import { createConfigListView } from "./ui/configListView.js";
import { getPlatform } from "./services/platformService.js";

const supabaseService = createSupabaseService();

const modal = document.getElementById("modal");
const btnOpen = document.getElementById("btnOpen");
const btnClose = document.getElementById("btnClose");
const btnAddSan = document.getElementById("btnAddSan");
const formCreate = document.getElementById("formCreate");
const listConfigsEl = document.getElementById("listConfigs");
const sanListEl = document.getElementById("sanList");
let platform = "unknown";

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
    appState.runStateByIdx[idx] = value;
    configListView.render(appState.displayedConfigs);
  },
});

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
loadConfigs();
