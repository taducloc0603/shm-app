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
        const errText = String(stderr || "").trim();

        console.log("PS OUT:", out);
        if (errText) console.log("PS ERR:", errText);

        if (out === "FOUND") return resolve({ ok: true, status: "FOUND" });
        if (out === "NOT_FOUND") return resolve({ ok: true, status: "NOT_FOUND" });

        const normalizedMessage = out.startsWith("ERROR:")
          ? out.slice("ERROR:".length).trim()
          : out;

        return resolve({
          ok: false,
          status: "ERROR",
          message: normalizedMessage || errText || err?.message || "Unknown error",
        });
      }
    );
  });
}

module.exports = { checkShm };
