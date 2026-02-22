export function createLoadingOverlay(overlayEl, textEl) {
  return function setLoading(isLoading, message = "Đang xử lý...") {
    if (!overlayEl || !textEl) return;
    textEl.textContent = message;
    overlayEl.style.display = isLoading ? "flex" : "none";
  };
}
