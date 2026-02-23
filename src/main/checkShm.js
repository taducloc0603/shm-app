const { execFile } = require("child_process");
const path = require("path");

const SHM_LAYOUT = {
  H_QUOTE_SEQ: 0,
  H_CMD_SEQ: 4,
  H_ACK_SEQ: 8,
  H_ACK_CODE: 12,
  QUOTE_RING_OFFSET: 16,
  QUOTE_RING_SIZE: 64,
  QUOTE_MSG_SIZE: 48,
  Q_TS_OFFSET: 8,
  Q_BID_OFFSET: 16,
  Q_ASK_OFFSET: 24,
  Q_SYMBOL_OFFSET: 32,
  Q_SYMBOL_LEN: 16,
};

let nativeShmReader = null;
let nativeLoadError = null;

function loadNativeReader() {
  if (nativeShmReader || nativeLoadError) return nativeShmReader;

  try {
    const baseCandidates = [
      path.join(__dirname, "../../native/shm_reader/build/Release/shm_reader.node"),
      path.join(__dirname, "../../native/shm_reader/build/Debug/shm_reader.node"),
    ];

    const unpackedCandidates = baseCandidates
      .filter((p) => p.includes("app.asar"))
      .map((p) => p.replace("app.asar", "app.asar.unpacked"));

    const candidatePaths = [...baseCandidates, ...unpackedCandidates];

    for (const addonPath of candidatePaths) {
      try {
        // eslint-disable-next-line global-require, import/no-dynamic-require
        nativeShmReader = require(addonPath);
        break;
      } catch (_err) {
        // try next candidate
      }
    }

    if (!nativeShmReader) {
      throw new Error("Không load được native addon shm_reader (.node).");
    }
  } catch (err) {
    nativeLoadError = err;
  }

  return nativeShmReader;
}

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

function cleanSymbol(symbol) {
  return String(symbol || "")
    .replace(/[^\x20-\x7E]/g, "")
    .trim();
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
      message: "Hiện check_shm chỉ hỗ trợ Windows.",
    };
  }

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

function normalizeRows(rows) {
  return (Array.isArray(rows) ? rows : [rows]).map((row) =>
    row?.status === "FOUND"
      ? {
          ...row,
          symbol: cleanSymbol(row.symbol),
          spread: Number.isFinite(Number(row.spread))
            ? Number(row.spread)
            : Number(row.ask) - Number(row.bid),
        }
      : row
  );
}

async function readShmQuotesViaPowerShell(names) {
  const namesJsonEscaped = JSON.stringify(names).replace(/'/g, "''");
  const c = SHM_LAYOUT;
  const psCommand =
    "$ErrorActionPreference = 'Stop'; " +
    `$quoteSeqOffset=${c.H_QUOTE_SEQ}; $cmdSeqOffset=${c.H_CMD_SEQ}; $ackSeqOffset=${c.H_ACK_SEQ}; $ackCodeOffset=${c.H_ACK_CODE}; ` +
    `$quoteRingOffset=${c.QUOTE_RING_OFFSET}; $quoteRingSize=${c.QUOTE_RING_SIZE}; $quoteMsgSize=${c.QUOTE_MSG_SIZE}; ` +
    `$qTsOffset=${c.Q_TS_OFFSET}; $qBidOffset=${c.Q_BID_OFFSET}; $qAskOffset=${c.Q_ASK_OFFSET}; $qSymbolOffset=${c.Q_SYMBOL_OFFSET}; $qSymbolLen=${c.Q_SYMBOL_LEN}; ` +
    "$mapNames = ConvertFrom-Json '" + namesJsonEscaped + "'; " +
    "$results = New-Object System.Collections.Generic.List[Object]; " +
    "foreach ($mapName in $mapNames) { " +
    "$mmf = $null; $view = $null; $item = $null; " +
    "try { " +
    "$mmf = [System.IO.MemoryMappedFiles.MemoryMappedFile]::OpenExisting($mapName); " +
    "$view = $mmf.CreateViewAccessor(); " +
    "$stable = $false; " +
    "for ($i = 0; $i -lt 4; $i++) { " +
    "$quote_seq_1 = $view.ReadUInt32($quoteSeqOffset); " +
    "$cmd_seq = $view.ReadUInt32($cmdSeqOffset); " +
    "$ack_seq = $view.ReadUInt32($ackSeqOffset); " +
    "$ack_code = $view.ReadInt32($ackCodeOffset); " +
    "$slot = [int]($quote_seq_1 % $quoteRingSize); " +
    "$base = $quoteRingOffset + ($slot * $quoteMsgSize); " +
    "$time_msc = $view.ReadInt64($base + $qTsOffset); " +
    "$bid = $view.ReadDouble($base + $qBidOffset); " +
    "$ask = $view.ReadDouble($base + $qAskOffset); " +
    "$symbolBytes = New-Object byte[] $qSymbolLen; " +
    "$null = $view.ReadArray($base + $qSymbolOffset, $symbolBytes, 0, $qSymbolLen); " +
    "$symbol = [System.Text.Encoding]::ASCII.GetString($symbolBytes).Trim([char]0); " +
    "$quote_seq_2 = $view.ReadUInt32($quoteSeqOffset); " +
    "if ($quote_seq_1 -eq $quote_seq_2) { " +
    "$stable = $true; " +
    "$item = [PSCustomObject]@{ map_name=$mapName; status='FOUND'; quote_seq=$quote_seq_2; cmd_seq=$cmd_seq; ack_seq=$ack_seq; ack_code=$ack_code; slot=$slot; base_addr=('0x' + $base.ToString('X')); symbol=$symbol; bid=$bid; ask=$ask; spread=($ask - $bid); time_msc=$time_msc; retries=$i }; " +
    "break; " +
    "} " +
    "Start-Sleep -Milliseconds 1; " +
    "} " +
    "if (-not $stable) { $item = [PSCustomObject]@{ map_name=$mapName; status='ERROR'; message='Không lấy được snapshot ổn định sau nhiều lần thử.' } } " +
    "} catch [System.IO.FileNotFoundException] { " +
    "$item = [PSCustomObject]@{ map_name=$mapName; status='NOT_FOUND' }; " +
    "} catch { " +
    "$item = [PSCustomObject]@{ map_name=$mapName; status='ERROR'; message=$_.Exception.Message }; " +
    "} finally { " +
    "if ($view -ne $null) { $view.Dispose() }; " +
    "if ($mmf -ne $null) { $mmf.Dispose() }; " +
    "if ($item -ne $null) { $results.Add($item) } " +
    "} " +
    "} " +
    "$results | ConvertTo-Json -Compress;";

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
    return {
      ok: true,
      status: "FOUND",
      data: normalizeRows(parsed),
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

async function readShmQuote(mapName) {
  const res = await readShmQuotes([mapName]);
  if (!res?.ok) return res;

  const row = Array.isArray(res.data) ? res.data[0] : null;
  if (!row) {
    return {
      ok: false,
      status: "ERROR",
      message: "Không nhận được dữ liệu quote.",
    };
  }

  if (row.status === "FOUND") {
    return {
      ok: true,
      status: "FOUND",
      data: {
        quote_seq: row.quote_seq,
        cmd_seq: row.cmd_seq,
        ack_seq: row.ack_seq,
        ack_code: row.ack_code,
        slot: row.slot,
        base_addr: row.base_addr,
        symbol: cleanSymbol(row.symbol),
        bid: row.bid,
        ask: row.ask,
        spread: row.spread,
        time_msc: row.time_msc,
      },
    };
  }

  if (row.status === "NOT_FOUND") {
    return { ok: true, status: "NOT_FOUND" };
  }

  return {
    ok: false,
    status: "ERROR",
    message: row?.message || "Không đọc được dữ liệu map.",
  };
}

async function readShmQuotes(mapNames) {
  const names = Array.isArray(mapNames)
    ? mapNames.map((v) => String(v || "").trim()).filter(Boolean)
    : [];

  if (!names.length) return { ok: false, status: "EMPTY" };

  if (process.platform !== "win32") {
    return {
      ok: false,
      status: "UNSUPPORTED",
      message: "Đọc shared memory realtime hiện chỉ hỗ trợ Windows.",
    };
  }

  const nativeReader = loadNativeReader();
  if (nativeReader?.readBatch) {
    try {
      const rows = nativeReader.readBatch(names);
      return {
        ok: true,
        status: "FOUND",
        data: normalizeRows(rows),
        source: "native",
      };
    } catch (err) {
      const fallback = await readShmQuotesViaPowerShell(names);
      if (fallback?.ok) {
        return {
          ...fallback,
          source: "powershell_fallback",
          nativeError: `Native reader error: ${err?.message || "Unknown"}`,
        };
      }

      return {
        ok: false,
        status: "ERROR",
        message: `Native reader error: ${err?.message || "Unknown"}`,
      };
    }
  }

  return readShmQuotesViaPowerShell(names);
}

module.exports = { checkShm, readShmQuote, readShmQuotes };
