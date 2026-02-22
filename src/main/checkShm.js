const { execFile } = require("child_process");

/**
 * Check shared memory map name.
 * Current implementation supports Windows via PowerShell.
 */
async function checkShm(mapName) {
  const name = String(mapName || "").trim();
  if (!name) return { ok: false, status: "EMPTY" };

  if (process.platform !== "win32") {
    return {
      ok: false,
      status: "UNSUPPORTED",
      message: "Hiện check_shm bằng PowerShell chỉ chạy trên Windows (powershell.exe).",
    };
  }

  const escaped = name.replace(/\\/g, "\\\\").replace(/'/g, "''");

  const psCommand =
    "[System.Reflection.Assembly]::LoadWithPartialName('System.Core') | Out-Null; " +
    "try { " +
    "[System.IO.MemoryMappedFiles.MemoryMappedFile]::OpenExisting('" + escaped + "') | Out-Null; " +
    "Write-Output 'FOUND' " +
    "} catch [System.IO.FileNotFoundException] { " +
    "Write-Output 'NOT_FOUND' " +
    "} catch { " +
    "Write-Output ('ERROR:' + $_.Exception.Message) " +
    "}";

  return await new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psCommand],
      { windowsHide: true },
      (err, stdout, stderr) => {
        const out = String(stdout || "").trim();

        console.log("PS OUT:", out);
        if (stderr) console.log("PS ERR:", String(stderr).trim());

        if (out === "FOUND") return resolve({ ok: true, status: "FOUND" });
        if (out === "NOT_FOUND") return resolve({ ok: true, status: "NOT_FOUND" });

        return resolve({
          ok: false,
          status: "ERROR",
          message: out || err?.message || "Unknown error",
        });
      }
    );
  });
}

module.exports = { checkShm };
