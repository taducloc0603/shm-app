const { execFile } = require("child_process");

function runPowerShell(script, timeout = 5000) {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, timeout },
      (err, stdout, stderr) => {
        resolve({
          err,
          out: String(stdout || "").trim(),
          errText: String(stderr || "").trim(),
        });
      }
    );
  });
}

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

  const { err, out, errText } = await runPowerShell(psCommand, 5000);
  const statusLine = out
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((line) => line.startsWith("__SHM_STATUS__:"));

  console.log("PS OUT:", out);
  if (errText) console.log("PS ERR:", errText);

  if (statusLine === "__SHM_STATUS__:FOUND") {
    return { ok: true, status: "FOUND" };
  }

  if (statusLine === "__SHM_STATUS__:NOT_FOUND") {
    return { ok: true, status: "NOT_FOUND" };
  }

  const normalizedMessage = statusLine?.startsWith("__SHM_STATUS__:ERROR:")
    ? statusLine.slice("__SHM_STATUS__:ERROR:".length).trim()
    : out;

  return {
    ok: false,
    status: "ERROR",
    message:
      normalizedMessage ||
      errText ||
      (err?.killed ? "PowerShell timeout khi check map name." : err?.message) ||
      "Unknown error",
  };
}

async function readShmQuote(mapName) {
  const name = String(mapName || "").trim();
  if (!name) return { ok: false, status: "EMPTY" };

  if (process.platform !== "win32") {
    return {
      ok: false,
      status: "UNSUPPORTED",
      message: "Đọc shared memory realtime hiện chỉ hỗ trợ Windows.",
    };
  }

  const escaped = name.replace(/'/g, "''");
  const psCommand =
    "$ErrorActionPreference = 'Stop'; " +
    "$maxRetry = 3; " +
    "$result = $null; " +
    "for ($i = 0; $i -lt $maxRetry; $i++) { " +
    "$mmf = $null; $view = $null; $br = $null; " +
    "try { " +
    "$mmf = [System.IO.MemoryMappedFiles.MemoryMappedFile]::OpenExisting('" + escaped + "'); " +
    "$view = $mmf.CreateViewStream(); " +
    "$br = New-Object System.IO.BinaryReader($view); " +
    "$quote_seq_1 = $br.ReadUInt32(); " +
    "$cmd_seq = $br.ReadUInt32(); " +
    "$ack_seq = $br.ReadUInt32(); " +
    "$ack_code = $br.ReadUInt32(); " +
    "$slot = $br.ReadUInt32(); " +
    "$base_addr = $br.ReadUInt64(); " +
    "$symbol_bytes = $br.ReadBytes(32); " +
    "$symbol = [System.Text.Encoding]::ASCII.GetString($symbol_bytes).Trim([char]0); " +
    "$bid = $br.ReadDouble(); " +
    "$ask = $br.ReadDouble(); " +
    "$time_msc = $br.ReadInt64(); " +
    "$view.Position = 0; " +
    "$quote_seq_2 = $br.ReadUInt32(); " +
    "if ($quote_seq_1 -eq $quote_seq_2) { " +
    "$result = @{ status='FOUND'; quote_seq=$quote_seq_2; cmd_seq=$cmd_seq; ack_seq=$ack_seq; ack_code=$ack_code; slot=$slot; base_addr=('0x' + $base_addr.ToString('X')); symbol=$symbol; bid=$bid; ask=$ask; spread=($ask - $bid); time_msc=$time_msc; retries=$i }; " +
    "break; " +
    "} " +
    "Start-Sleep -Milliseconds 2; " +
    "} catch [System.IO.FileNotFoundException] { " +
    "$result = @{ status='NOT_FOUND' }; " +
    "break; " +
    "} catch { " +
    "$result = @{ status='ERROR'; message=$_.Exception.Message }; " +
    "} finally { " +
    "if ($br -ne $null) { $br.Close() }; " +
    "if ($view -ne $null) { $view.Close() }; " +
    "if ($mmf -ne $null) { $mmf.Dispose() }; " +
    "} " +
    "} " +
    "if ($result -eq $null) { $result = @{ status='ERROR'; message='Không lấy được snapshot ổn định sau nhiều lần thử.' } }; " +
    "$result | ConvertTo-Json -Compress;";

  const { err, out, errText } = await runPowerShell(psCommand, 3000);

  if (!out) {
    return {
      ok: false,
      status: "ERROR",
      message: errText || err?.message || "Không nhận được dữ liệu từ shared memory.",
    };
  }

  try {
    const parsed = JSON.parse(out);
    const status = parsed?.status || "ERROR";

    if (status === "FOUND") {
      return {
        ok: true,
        status: "FOUND",
        data: {
          quote_seq: parsed.quote_seq,
          cmd_seq: parsed.cmd_seq,
          ack_seq: parsed.ack_seq,
          ack_code: parsed.ack_code,
          slot: parsed.slot,
          base_addr: parsed.base_addr,
          symbol: parsed.symbol,
          bid: parsed.bid,
          ask: parsed.ask,
          spread: parsed.spread,
          time_msc: parsed.time_msc,
        },
      };
    }

    if (status === "NOT_FOUND") {
      return { ok: true, status: "NOT_FOUND" };
    }

    return {
      ok: false,
      status: "ERROR",
      message: parsed?.message || errText || err?.message || "Không đọc được dữ liệu map.",
    };
  } catch (parseErr) {
    return {
      ok: false,
      status: "ERROR",
      message: `Không parse được dữ liệu đọc từ map: ${parseErr?.message || "Unknown"}`,
      raw: out,
    };
  }
}

module.exports = { checkShm, readShmQuote };
