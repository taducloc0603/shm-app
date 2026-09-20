#!/usr/bin/env node
// CLI đọc file .ticks / .trace của TradeDesktop (Madeo). Chạy bằng Node thuần.
//
//   node tools/madeo.mjs info   <file.ticks|file.trace>
//   node tools/madeo.mjs export <file.ticks|file.trace> --csv [--out x.csv]
//   node tools/madeo.mjs log    <file.trace>
//
// Dùng để đối chiếu dữ liệu hai hệ thống trên cùng một phiên: gap trong .trace của họ so với
// gap tính từ .gtick của app này. Đặc tả từng trường: docs/tradedesktop-binary-format.md

import fs from "node:fs";
import path from "node:path";

import {
  TYPE_TICK,
  TYPE_PAIR_SNAPSHOT,
  TYPE_LOG,
  iterateMadeoRecords,
  decodeTickPayload,
  decodeLogPayload,
  decodePairSnapshotPayload,
} from "./madeoReader.mjs";

const USAGE = `Cách dùng:
  node tools/madeo.mjs info   <file.ticks|file.trace>
  node tools/madeo.mjs export <file.ticks|file.trace> --csv [--out x.csv]
  node tools/madeo.mjs log    <file.trace>

Ghi chú:
  - File Madeo không có magic/version. "info" đi hết khung; đi được tới đúng byte cuối file
    là bằng chứng duy nhất cho thấy đã đọc đúng định dạng.
  - Tên cột durMs / field52 phản ánh đúng mức chắc chắn: hai trường đó là suy đoán.`;

function parseArgs(argv) {
  const files = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      files.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (name === "csv") flags[name] = true;
    else flags[name] = argv[++i];
  }
  return { files, flags };
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function clock(ms) {
  if (!Number.isFinite(ms)) return "-";
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

function stamp(ms) {
  if (!Number.isFinite(ms)) return "-";
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${clock(ms)}`;
}

function pct(sorted, p) {
  if (!sorted.length) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))];
}

function num(v, digits = 2) {
  return Number.isFinite(v) ? Number(v.toFixed(digits)) : "-";
}

// --------------------------------------------------------------------------- info

function cmdInfo(file) {
  const byType = new Map();
  const deltas = [];
  let prevMs = null;
  let firstMs = null;
  let lastMs = null;
  let dupQuotes = 0;
  let prevBid = null;
  let prevAsk = null;
  let tickRecords = 0;
  let totalBytes = 0;

  for (const rec of iterateMadeoRecords(file)) {
    totalBytes += 8 + rec.size;
    let entry = byType.get(rec.type);
    if (!entry) {
      entry = { count: 0, sizes: new Set() };
      byType.set(rec.type, entry);
    }
    entry.count += 1;
    entry.sizes.add(rec.size);

    let ms = null;
    if (rec.type === TYPE_TICK) {
      const t = decodeTickPayload(rec.payload);
      ms = t.timeMs;
      tickRecords += 1;
      if (prevBid === t.bid && prevAsk === t.ask) dupQuotes += 1;
      prevBid = t.bid;
      prevAsk = t.ask;
    } else if (rec.type === TYPE_PAIR_SNAPSHOT) {
      ms = decodePairSnapshotPayload(rec.payload).timeMs;
    } else if (rec.type === TYPE_LOG) {
      ms = decodeLogPayload(rec.payload).timeMs;
    }

    if (ms !== null && Number.isFinite(ms)) {
      if (firstMs === null) firstMs = ms;
      lastMs = ms;
      if (prevMs !== null) deltas.push(ms - prevMs);
      prevMs = ms;
    }
  }

  const fileSize = fs.statSync(file).size;
  const sorted = deltas.sort((a, b) => a - b);
  const spanSec = (lastMs - firstMs) / 1000;

  console.log(path.basename(file));
  console.log(`  khung      : đi hết ${totalBytes} / ${fileSize} byte — ${totalBytes === fileSize ? "KHỚP, đọc đúng định dạng" : "LỆCH"}`);
  for (const [type, entry] of [...byType.entries()].sort((a, b) => a[0] - b[0])) {
    const sizes = [...entry.sizes].sort((a, b) => a - b);
    const sizeText = sizes.length <= 3 ? sizes.join(", ") : `${sizes[0]}..${sizes[sizes.length - 1]} (${sizes.length} giá trị)`;
    console.log(`  type ${String(type).padStart(4)} : ${String(entry.count).padStart(7)} bản ghi, payload ${sizeText} byte`);
  }
  console.log(`  thời gian  : ${stamp(firstMs)} -> ${clock(lastMs)}  (${num(spanSec, 1)} s)`);
  if (spanSec > 0) console.log(`  tần suất   : ${num(deltas.length / spanSec)} bản ghi/s`);
  console.log(
    `  nhịp ghi   : khoảng cách giữa 2 bản ghi p50=${pct(sorted, 50)} ms  p90=${pct(sorted, 90)} ms  max=${pct(sorted, 100)} ms`
  );
  if (tickRecords) {
    console.log(
      `  trùng giá  : ${dupQuotes}/${tickRecords} bản ghi có bid/ask y hệt bản ghi liền trước ` +
        `(${num((100 * dupQuotes) / tickRecords, 1)}%)`
    );
  }
}

// --------------------------------------------------------------------------- export

const TICK_CSV_HEADER = "time_iso,time_ms,bid,ask,dur_ms,field52";
const PAIR_CSV_HEADER =
  "time_iso,time_ms,leg1_bid,leg1_ask,leg1_spread_pts,leg2_bid,leg2_ask,leg2_spread_pts,gap1_pts,gap2_pts";

function cmdExport(file, flags) {
  if (!flags.csv) throw new Error("export hiện chỉ hỗ trợ --csv.");
  const sink = flags.out ? fs.createWriteStream(flags.out) : process.stdout;
  const write = (text) => sink.write(`${text}\n`);

  let header = null;
  let rows = 0;

  for (const rec of iterateMadeoRecords(file)) {
    if (rec.type === TYPE_TICK) {
      if (!header) write((header = TICK_CSV_HEADER));
      const t = decodeTickPayload(rec.payload);
      write([new Date(t.timeMs).toISOString(), t.timeMs, t.bid, t.ask, t.durMs, t.field52].join(","));
      rows += 1;
    } else if (rec.type === TYPE_PAIR_SNAPSHOT) {
      if (!header) write((header = PAIR_CSV_HEADER));
      const p = decodePairSnapshotPayload(rec.payload);
      write(
        [
          new Date(p.timeMs).toISOString(), p.timeMs,
          p.leg1.bid, p.leg1.ask, p.leg1.spreadPts,
          p.leg2.bid, p.leg2.ask, p.leg2.spreadPts,
          p.gap1Pts, p.gap2Pts,
        ].join(",")
      );
      rows += 1;
    }
    // type 1000 (log chữ) không vào CSV — dùng lệnh "log".
  }

  if (flags.out) {
    sink.end();
    console.error(`Đã ghi ${rows} dòng vào ${flags.out}`);
  }
}

// --------------------------------------------------------------------------- log

function cmdLog(file) {
  for (const rec of iterateMadeoRecords(file)) {
    if (rec.type !== TYPE_LOG) continue;
    const l = decodeLogPayload(rec.payload);
    console.log(`[${clock(l.timeMs)}] ${l.level === 0 ? "INFO " : `LV${l.level}  `} ${l.text}`);
  }
}

// --------------------------------------------------------------------------- main

process.stdout.on("error", (err) => {
  if (err?.code === "EPIPE") process.exit(0);
  throw err;
});

function main(argv) {
  const [command, ...rest] = argv;
  if (!command || ["-h", "--help", "help"].includes(command)) {
    console.log(USAGE);
    return 0;
  }

  const { files, flags } = parseArgs(rest);
  if (!files.length) {
    console.error(`Thiếu đường dẫn file.\n\n${USAGE}`);
    return 2;
  }
  const file = path.resolve(files[0]);
  if (!fs.existsSync(file)) throw new Error(`Không thấy file: ${files[0]}`);

  switch (command) {
    case "info":
      cmdInfo(file);
      return 0;
    case "export":
      cmdExport(file, flags);
      return 0;
    case "log":
      cmdLog(file);
      return 0;
    default:
      console.error(`Lệnh không hiểu: "${command}".\n\n${USAGE}`);
      return 2;
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  console.error(`Lỗi: ${err?.message || err}`);
  process.exitCode = 1;
}
