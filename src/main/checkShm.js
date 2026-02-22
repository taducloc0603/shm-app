const { execFile } = require("child_process");

/**
 * Check shared memory map name.
 * Current implementation supports Windows via PowerShell.
 */
async function checkShm(mapName) {
  const name = String(mapName || "").trim();
  if (!name) return { ok: false, status: "EMPTY" };

  if (/[\r\n\t\0]/.test(name)) {
    return {
      ok: false,
      status: "INVALID",
      message: "Map name chứa ký tự không hợp lệ (newline/tab/null).",
    };
  }

  if (process.platform !== "win32") {
    return {
      ok: false,
      status: "UNSUPPORTED",
      message: "Hiện check_shm bằng PowerShell chỉ chạy trên Windows (powershell.exe).",
    };
  }

  // PowerShell single-quoted string không cần escape dấu backslash.
  // Chỉ cần escape dấu nháy đơn để giữ nguyên map name (vd: Global\MyMap).
  const escaped = name.replace(/'/g, "''");

  const psCommand =
    "[System.Reflection.Assembly]::LoadWithPartialName('System.Core') | Out-Null; " +
    "try { " +
    "$mmf = [System.IO.MemoryMappedFiles.MemoryMappedFile]::OpenExisting('" + escaped + "'); " +
    "if ($mmf -ne $null) { $mmf.Dispose() }; " +
    "Write-Output '__SHM_STATUS__:FOUND' " +
    "} catch [System.IO.FileNotFoundException] { " +
    "Write-Output '__SHM_STATUS__:NOT_FOUND' " +
    "} catch { " +
    "Write-Output ('__SHM_STATUS__:ERROR:' + $_.Exception.Message) " +
    "}";

  return await new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", psCommand],
      { windowsHide: true, timeout: 5000 },
      (err, stdout, stderr) => {
        const out = String(stdout || "").trim();
        const errText = String(stderr || "").trim();
        const statusLine = out
          .split(/\r?\n/)
          .map((s) => s.trim())
          .find((line) => line.startsWith("__SHM_STATUS__:"));

        console.log("PS OUT:", out);
        if (errText) console.log("PS ERR:", errText);

        if (statusLine === "__SHM_STATUS__:FOUND") {
          return resolve({ ok: true, status: "FOUND" });
        }

        if (statusLine === "__SHM_STATUS__:NOT_FOUND") {
          return resolve({ ok: true, status: "NOT_FOUND" });
        }

        const normalizedMessage = statusLine?.startsWith("__SHM_STATUS__:ERROR:")
          ? statusLine.slice("__SHM_STATUS__:ERROR:".length).trim()
          : out;

        return resolve({
          ok: false,
          status: "ERROR",
          message:
            normalizedMessage ||
            errText ||
            (err?.killed ? "PowerShell timeout khi check map name." : err?.message) ||
            "Unknown error",
        });
      }
    );
  });
}

module.exports = { checkShm };
