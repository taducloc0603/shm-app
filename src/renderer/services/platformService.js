export async function getPlatform() {
  try {
    if (window.shm?.getPlatform) {
      return await window.shm.getPlatform();
    }
  } catch (_) {
    // ignore
  }

  return "unknown";
}
