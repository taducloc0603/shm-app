#!/usr/bin/env node
// Bộ giải mã file tick nhị phân (.gtick). Chạy bằng Node thuần, không cần Electron.
//
//   node tools/ticks.mjs info   <file...>
//   node tools/ticks.mjs export <file...> [--log|--csv] [--out <file>]
//   node tools/ticks.mjs slice  <file...> --from <HH:mm[:ss]> --to <HH:mm[:ss]>
//   node tools/ticks.mjs stats  <file...> [--anonymize] [--confirm <pts>] [--open <pts>]
//
// "stats" là đường đi dành cho phân tích bằng AI: nó đọc HẾT dữ liệu rồi in một báo cáo vài KB.
// Đừng dán file thô vào AI — một giờ chạy đã vượt xa context window của mọi model, và đưa mẫu nhỏ
// rồi hỏi kết luận tổng thể là cách chắc chắn nhất để nhận về kết luận sai.

import fs from "node:fs";
import path from "node:path";

import { iterateRecords, readFileInfo, scanFile, listParts } from "./gapTickReader.mjs";
import { calcRecordGaps, toGapTickLineInput, TICKS_MAX } from "../src/renderer/utils/gapTickRecord.js";
import { formatGapTickLine } from "../src/renderer/utils/gapTickLine.js";

const USAGE = `Cách dùng:
  node tools/ticks.mjs info   <file.gtick...>
  node tools/ticks.mjs export <file.gtick...> [--log|--csv] [--out <file>]
  node tools/ticks.mjs slice  <file.gtick...> --from <HH:mm[:ss]> --to <HH:mm[:ss]> [--log|--csv]
  node tools/ticks.mjs stats  <file.gtick...> [--anonymize] [--confirm <pts>] [--open <pts>]

Ghi chú:
  - Truyền file gốc (.gtick) thì các part .001/.002... của nó được nạp theo, đúng thứ tự.
  - --anonymize thay host / tên shared memory map / symbol bằng bí danh trước khi in.`;

// --------------------------------------------------------------------------- tham số

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
    if (["log", "csv", "anonymize"].includes(name)) {
      flags[name] = true;
    } else {
      flags[name] = argv[++i];
    }
  }
  return { files, flags };
}

// Gom các part của cùng một cặp và bỏ trùng, giữ đúng thứ tự ghi.
function expandFiles(inputs) {
  const out = [];
  const seen = new Set();
  for (const input of inputs) {
    const resolved = path.resolve(input);
    if (!fs.existsSync(resolved)) throw new Error(`Không thấy file: ${input}`);
    // File không phải .gtick vẫn được nhận để parseFileHeader báo đúng lý do (sai magic / sai version).
    const parts = resolved.endsWith(".gtick") ? listParts(resolved) : [resolved];
    for (const part of parts) {
      if (seen.has(part)) continue;
      seen.add(part);
      out.push(part);
    }
  }
  if (!out.length) throw new Error("Không có file nào để đọc.");
  return out;
}

// --------------------------------------------------------------------------- hiển thị

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

function duration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 3600)}h${pad2(Math.floor((s % 3600) / 60))}m${pad2(s % 60)}s`;
}

function mb(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function num(value, digits = 2) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : "-";
}

// Mốc "HH:mm[:ss]" -> epoch ms, lấy theo NGÀY của phiên (file chỉ chạy trong vòng một phiên).
function parseTimeOfDay(text, referenceMs) {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(text || "").trim());
  if (!m) throw new Error(`Mốc thời gian không hợp lệ: "${text}" (cần HH:mm hoặc HH:mm:ss).`);
  const ref = new Date(referenceMs);
  return new Date(ref.getFullYear(), ref.getMonth(), ref.getDate(), Number(m[1]), Number(m[2]), Number(m[3] || 0)).getTime();
}

function anonymizeMeta(meta) {
  return { ...meta, host: "host", mapA: "A", mapB: "B", symA: "SYM_A", symB: "SYM_B", baseFile: "session.gtick" };
}

// --------------------------------------------------------------------------- info

function cmdInfo(files) {
  for (const file of files) {
    const info = readFileInfo(file);
    const scan = scanFile(file);
    const m = info.meta;

    console.log(`${info.fileName}`);
    console.log(`  cặp        : ${m.mapA} (${m.symA ?? "-"})  <->  ${m.mapB} (${m.symB ?? "-"})`);
    console.log(`  config     : ${m.group ?? "-"}  point=${m.point ?? "-"}  host=${m.host ?? "-"}`);
    console.log(`  part       : ${m.part}  (phiên bắt đầu ${stamp(m.startedAtMs)})`);
    console.log(`  kích thước : ${mb(info.fileSize)}  header=${info.headerBytes} B  bản ghi=${info.recordCount}`);
    console.log(`    dữ liệu=${scan.dataRecords}  điều khiển=${scan.controlRecords}  dropped=${scan.dropped}`);
    console.log(`  thời gian  : ${stamp(scan.firstWallMs)}  ->  ${clock(scan.lastWallMs)}  (${duration(scan.lastWallMs - scan.firstWallMs)})`);
    console.log(
      `  kết thúc   : ${scan.closedCleanly ? "đóng sạch" : scan.partEnded ? "hết part, ghi tiếp ở part sau" : "KHÔNG có dấu đóng (app crash / đang ghi dở)"}`
    );
    if (info.trailingBytes) {
      console.log(`  CẢNH BÁO   : dư ${info.trailingBytes} byte cuối file — bản ghi cuối bị cắt ngang, đã bỏ qua.`);
    }
    console.log("");
  }
}

// --------------------------------------------------------------------------- export / slice

const CSV_HEADER =
  "time_iso,wall_ms,heartbeat,data_gap,gap_buy,gap_sell," +
  "a_bid,a_ask,a_spread,a_lat,a_time_msc,a_ticks," +
  "b_bid,b_ask,b_spread,b_lat,b_time_msc,b_ticks";

function csvNum(value) {
  return Number.isFinite(value) ? String(value) : "";
}

function csvRow(record, point) {
  const { gapBuy, gapSell } = calcRecordGaps(record, point);
  const a = record.a;
  const b = record.b;
  return [
    new Date(record.wallMs).toISOString(),
    csvNum(record.wallMs),
    record.heartbeat ? 1 : 0,
    record.dataGap ? 1 : 0,
    csvNum(gapBuy),
    csvNum(gapSell),
    csvNum(a?.bid),
    csvNum(a?.ask),
    a ? csvNum(a.ask - a.bid) : "",
    a && a.lat !== null ? a.lat : "",
    csvNum(a?.timeMsc),
    a && a.ticks !== null ? a.ticks : "",
    csvNum(b?.bid),
    csvNum(b?.ask),
    b ? csvNum(b.ask - b.bid) : "",
    b && b.lat !== null ? b.lat : "",
    csvNum(b?.timeMsc),
    b && b.ticks !== null ? b.ticks : "",
  ].join(",");
}

function cmdExport(files, flags, { fromMs = -Infinity, toMs = Infinity } = {}) {
  const asCsv = Boolean(flags.csv);
  const meta = readFileInfo(files[0]).meta;
  const view = flags.anonymize ? anonymizeMeta(meta) : meta;

  const sink = flags.out ? fs.createWriteStream(flags.out) : process.stdout;
  const write = (text) => sink.write(`${text}\n`);

  if (asCsv) {
    write(CSV_HEADER);
  } else {
    write(`# ${view.mapA} <-> ${view.mapB}  sym=${view.symA ?? "-"}/${view.symB ?? "-"}  point=${view.point ?? "-"}`);
  }

  let written = 0;
  for (const file of files) {
    for (const { record, control } of iterateRecords(file)) {
      if (control) continue;
      if (record.wallMs < fromMs || record.wallMs > toMs) continue;
      write(
        asCsv
          ? csvRow(record, meta.point)
          : formatGapTickLine(toGapTickLineInput(record, { symA: view.symA, symB: view.symB, point: meta.point }))
      );
      written += 1;
    }
  }

  if (flags.out) {
    sink.end();
    console.error(`Đã ghi ${written} dòng vào ${flags.out}`);
  }
}

function cmdSlice(files, flags) {
  if (!flags.from || !flags.to) throw new Error("slice cần --from và --to.");
  const reference = scanFile(files[0]).firstWallMs ?? Date.now();
  const fromMs = parseTimeOfDay(flags.from, reference);
  const toMs = parseTimeOfDay(flags.to, reference);
  if (toMs < fromMs) throw new Error("--to phải sau --from.");
  cmdExport(files, flags, { fromMs, toMs });
}

// --------------------------------------------------------------------------- stats

function percentile(sorted, p) {
  if (!sorted.length) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}

function describe(values) {
  const sorted = Float64Array.from(values).sort();
  return {
    n: sorted.length,
    min: sorted.length ? sorted[0] : NaN,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p99: percentile(sorted, 99),
    max: sorted.length ? sorted[sorted.length - 1] : NaN,
  };
}

function describeLine(label, d, digits = 1) {
  return `  ${label.padEnd(12)} n=${String(d.n).padStart(7)}  min=${String(num(d.min, digits)).padStart(9)}  p50=${String(num(d.p50, digits)).padStart(9)}  p90=${String(num(d.p90, digits)).padStart(9)}  p99=${String(num(d.p99, digits)).padStart(9)}  max=${String(num(d.max, digits)).padStart(9)}`;
}

function collect(files, point) {
  const gapBuy = [];
  const gapSell = [];
  const latA = [];
  const latB = [];
  const skipA = [];
  const skipB = [];
  const skew = [];
  const buckets = new Map(); // phút -> { records, changes, maxAbsGap }
  const stalls = [];

  let dataRecords = 0;
  let heartbeats = 0;
  let missingA = 0;
  let missingB = 0;
  let bothMissing = 0;
  let firstMs = null;
  let lastMs = null;
  let prevMs = null;
  let closedCleanly = false;
  let dropped = 0;
  let truncatedParts = 0;
  let fileBytes = 0;
  let capturedA = 0;
  let capturedB = 0;
  let realTicksA = 0;
  let realTicksB = 0;
  let ticksClamped = 0;
  let ticksKnown = false;

  for (const file of files) {
    const info = readFileInfo(file);
    fileBytes += info.fileSize;
    if (info.trailingBytes) truncatedParts += 1;

    for (const { record, control } of iterateRecords(file)) {
      if (control) {
        if (control.code === 1) {
          closedCleanly = true;
          dropped += control.dropped;
        }
        continue;
      }

      dataRecords += 1;
      if (record.heartbeat) heartbeats += 1;
      if (!record.a) missingA += 1;
      if (!record.b) missingB += 1;
      if (!record.a && !record.b) bothMissing += 1;

      const ms = record.wallMs;
      if (Number.isFinite(ms)) {
        if (firstMs === null) firstMs = ms;
        lastMs = ms;
        // dataGap được writer gắn khi bản ghi cách bản ghi trước > 3 heartbeat: app treo hoặc đứng máy.
        if (record.dataGap && prevMs !== null) stalls.push({ fromMs: prevMs, toMs: ms });
        prevMs = ms;

        const minute = Math.floor(ms / 60000);
        let bucket = buckets.get(minute);
        if (!bucket) {
          bucket = { records: 0, changes: 0, maxAbsGap: 0 };
          buckets.set(minute, bucket);
        }
        bucket.records += 1;
        if (!record.heartbeat) bucket.changes += 1;
      }

      if (record.a?.lat !== null && record.a) latA.push(record.a.lat);
      if (record.b?.lat !== null && record.b) latB.push(record.b.lat);

      // Độ phủ tính THEO TỪNG PHÍA: một bản ghi có thể bắt tick của A, của B, hoặc cả hai.
      // ticks = số tick đã xảy ra kể từ bản ghi trước; ticks >= 1 nghĩa là bản ghi này bắt được
      // một tick của phía đó (cái cuối cùng), ticks - 1 là số bị bỏ sót.
      // v1 trả null: không đo được, khác hẳn với "không có tick nào".
      for (const [side, bucket] of [
        [record.a, { skip: skipA, cap: "A" }],
        [record.b, { skip: skipB, cap: "B" }],
      ]) {
        if (!side || side.ticks === null || side.ticks === undefined) continue;
        ticksKnown = true;
        if (side.ticks >= 1) {
          if (bucket.cap === "A") capturedA += 1;
          else capturedB += 1;
        }
        if (bucket.cap === "A") realTicksA += side.ticks;
        else realTicksB += side.ticks;
        bucket.skip.push(Math.max(0, side.ticks - 1));
        if (side.ticks >= TICKS_MAX) ticksClamped += 1;
      }
      if (record.a && record.b && Number.isFinite(record.a.timeMsc) && Number.isFinite(record.b.timeMsc)) {
        skew.push(record.b.timeMsc - record.a.timeMsc);
      }

      const { gapBuy: gb, gapSell: gs } = calcRecordGaps(record, point);
      if (gb !== null) {
        gapBuy.push(gb);
        gapSell.push(gs);
        const minute = Math.floor(ms / 60000);
        const bucket = buckets.get(minute);
        if (bucket) bucket.maxAbsGap = Math.max(bucket.maxAbsGap, Math.abs(gb), Math.abs(gs));
      }
    }
  }

  return {
    gapBuy, gapSell, latA, latB, skew, buckets, stalls, skipA, skipB,
    dataRecords, heartbeats, missingA, missingB, bothMissing,
    firstMs, lastMs, closedCleanly, dropped, truncatedParts, fileBytes,
    capturedA, capturedB, realTicksA, realTicksB, ticksClamped, ticksKnown,
  };
}

// Số lần và tổng thời lượng gap vượt ngưỡng. Mỗi bản ghi chiếm khoảng thời gian tới bản ghi kế
// tiếp, nên thời lượng tính được kể cả khi đã bỏ các lần poll trùng.
function thresholdRuns(records, threshold) {
  let count = 0;
  let totalMs = 0;
  let inRun = false;
  for (let i = 0; i < records.length; i += 1) {
    const over = records[i].value >= threshold;
    if (over) {
      if (!inRun) {
        count += 1;
        inRun = true;
      }
      const next = records[i + 1];
      if (next) totalMs += next.ms - records[i].ms;
    } else {
      inRun = false;
    }
  }
  return { count, totalMs };
}

function cmdStats(files, flags) {
  const meta = readFileInfo(files[0]).meta;
  const view = flags.anonymize ? anonymizeMeta(meta) : meta;
  const point = meta.point;

  const s = collect(files, point);
  const spanMs = s.firstMs !== null ? s.lastMs - s.firstMs : 0;
  const spanSec = spanMs / 1000;
  const changes = s.dataRecords - s.heartbeats;

  const out = [];
  out.push(`# BÁO CÁO PHIÊN TICK — ${view.mapA} <-> ${view.mapB}`);
  out.push("");
  out.push(`symbol       : ${view.symA ?? "-"} / ${view.symB ?? "-"}   point=${point ?? "-"}   config=${view.group ?? "-"}`);
  out.push(`host         : ${view.host ?? "-"}`);
  out.push(`file         : ${files.length} part, ${mb(s.fileBytes)}`);
  out.push(`thời gian    : ${stamp(s.firstMs)} -> ${clock(s.lastMs)}  (${duration(spanMs)})`);
  out.push(
    `kết thúc     : ${s.closedCleanly ? "đóng sạch" : "KHÔNG có dấu đóng — app crash hoặc file đang ghi dở"}` +
      `${s.truncatedParts ? `, ${s.truncatedParts} part bị cắt cụt` : ""}`
  );
  out.push("");
  out.push("## Khối lượng");
  out.push(`bản ghi      : ${s.dataRecords} (đổi giá ${changes}, heartbeat ${s.heartbeats}), dropped ${s.dropped}`);
  if (spanSec > 0) {
    out.push(`tần suất     : ${num(s.dataRecords / spanSec)} bản ghi/s, trong đó ${num(changes / spanSec)} lần đổi giá/s`);
    out.push(`dung lượng   : ${num(s.fileBytes / (1024 * 1024) / (spanSec / 3600))} MB/giờ ở nhịp này`);
  }
  out.push(
    `thiếu dữ liệu: A ${num((100 * s.missingA) / Math.max(1, s.dataRecords))}%, ` +
      `B ${num((100 * s.missingB) / Math.max(1, s.dataRecords))}%, cả hai ${num((100 * s.bothMissing) / Math.max(1, s.dataRecords))}%`
  );
  if (s.dropped > 0) {
    out.push(`CẢNH BÁO     : ${s.dropped} bản ghi bị bỏ vì hàng đợi đầy — số liệu dưới đây KHÔNG đầy đủ.`);
  }

  // Poll 30 ms không thấy hết tick của feed; hiệu quote_seq cho biết bỏ sót bao nhiêu.
  // Đây là câu trả lời cho "dữ liệu này có đủ để phân tích không", nên đặt ngay cạnh dropped.
  if (!s.ticksKnown) {
    out.push("độ phủ       : file version 1 không ghi số tick — không đo được.");
  } else {
    const captured = s.capturedA + s.capturedB;
    const real = s.realTicksA + s.realTicksB;
    out.push(
      `độ phủ       : bắt được ${captured} / ${real} tick thực tế ` +
        `(${num((100 * captured) / Math.max(1, real), 1)}%) — poll bỏ sót ${real - captured}`
    );
    out.push(
      `               A ${s.capturedA}/${s.realTicksA}, B ${s.capturedB}/${s.realTicksB}` +
        (s.skipA.length || s.skipB.length
          ? `   |  bỏ sót mỗi bản ghi: A p90=${num(describe(s.skipA).p90, 0)} max=${num(describe(s.skipA).max, 0)}` +
            `, B p90=${num(describe(s.skipB).p90, 0)} max=${num(describe(s.skipB).max, 0)}`
          : "")
    );
    if (s.ticksClamped > 0) {
      out.push(
        `CẢNH BÁO     : ${s.ticksClamped} bản ghi chạm trần ${TICKS_MAX} tick — ` +
          `số thật còn cao hơn, độ phủ ở trên là mức LẠC QUAN.`
      );
    }
  }
  out.push("");

  out.push("## Gap (point)");
  if (s.gapBuy.length) {
    out.push(describeLine("gap_buy", describe(s.gapBuy)));
    out.push(describeLine("gap_sell", describe(s.gapSell)));
  } else {
    out.push("  (không có bản ghi nào đủ dữ liệu hai phía)");
  }

  const confirm = Number(flags.confirm ?? meta.confirmGapPts);
  const open = Number(flags.open ?? meta.openPts);
  if (s.gapBuy.length && (Number.isFinite(confirm) || Number.isFinite(open))) {
    // Dựng lại chuỗi (thời điểm, gap) để đo thời lượng vượt ngưỡng.
    const seriesBuy = [];
    const seriesSell = [];
    let i = 0;
    for (const file of files) {
      for (const { record, control } of iterateRecords(file)) {
        if (control) continue;
        const { gapBuy: gb, gapSell: gs } = calcRecordGaps(record, point);
        if (gb === null) continue;
        seriesBuy.push({ ms: record.wallMs, value: gb });
        seriesSell.push({ ms: record.wallMs, value: gs });
        i += 1;
      }
    }
    out.push("");
    out.push("## Vượt ngưỡng");
    for (const [label, threshold] of [["confirm_gap_pts", confirm], ["open_pts", open]]) {
      if (!Number.isFinite(threshold)) continue;
      const buy = thresholdRuns(seriesBuy, threshold);
      const sell = thresholdRuns(seriesSell, threshold);
      out.push(
        `  ${label}=${threshold}: buy ${buy.count} lần / ${duration(buy.totalMs)}, ` +
          `sell ${sell.count} lần / ${duration(sell.totalMs)} (trên ${i} bản ghi có gap)`
      );
    }
  }
  out.push("");

  out.push("## Latency (ms)");
  out.push(describeLine("sàn A", describe(s.latA), 0));
  out.push(describeLine("sàn B", describe(s.latB), 0));
  if (s.skew.length) {
    const d = describe(s.skew);
    out.push(`  lệch time_msc B-A (đơn vị thô của broker): p50=${num(d.p50, 0)}  p90=${num(d.p90, 0)}  max=${num(d.max, 0)}`);
  }
  out.push("");

  out.push("## Ngắt quãng (heartbeat bị thiếu)");
  if (!s.stalls.length) {
    out.push("  không có — heartbeat liên tục suốt phiên.");
  } else {
    out.push(`  ${s.stalls.length} lần app/feed im lặng quá lâu:`);
    for (const stall of s.stalls.slice(0, 20)) {
      out.push(`    ${clock(stall.fromMs)} -> ${clock(stall.toMs)}  (${duration(stall.toMs - stall.fromMs)})`);
    }
    if (s.stalls.length > 20) out.push(`    ... và ${s.stalls.length - 20} lần nữa`);
  }
  out.push("");

  out.push("## Theo thời gian");
  const minutes = [...s.buckets.keys()].sort((a, b) => a - b);
  // Gộp để bảng không quá 60 dòng dù phiên chạy cả ngày.
  const step = Math.max(1, Math.ceil(minutes.length / 60));
  out.push(`  (mỗi dòng ${step} phút)   bản_ghi   đổi_giá   |gap|_max`);
  for (let i = 0; i < minutes.length; i += step) {
    let records = 0;
    let changed = 0;
    let maxAbsGap = 0;
    for (let j = i; j < Math.min(i + step, minutes.length); j += 1) {
      const bucket = s.buckets.get(minutes[j]);
      records += bucket.records;
      changed += bucket.changes;
      maxAbsGap = Math.max(maxAbsGap, bucket.maxAbsGap);
    }
    out.push(
      `  ${clock(minutes[i] * 60000).slice(0, 5)}   ${String(records).padStart(9)} ${String(changed).padStart(9)} ${String(num(maxAbsGap, 0)).padStart(11)}`
    );
  }

  console.log(out.join("\n"));
}

// --------------------------------------------------------------------------- main

function main(argv) {
  const [command, ...rest] = argv;
  if (!command || ["-h", "--help", "help"].includes(command)) {
    console.log(USAGE);
    return 0;
  }

  const { files: inputs, flags } = parseArgs(rest);
  if (!inputs.length) {
    console.error(`Thiếu đường dẫn file.\n\n${USAGE}`);
    return 2;
  }
  const files = expandFiles(inputs);

  switch (command) {
    case "info":
      cmdInfo(files);
      return 0;
    case "export":
      cmdExport(files, flags);
      return 0;
    case "slice":
      cmdSlice(files, flags);
      return 0;
    case "stats":
      cmdStats(files, flags);
      return 0;
    default:
      console.error(`Lệnh không hiểu: "${command}".\n\n${USAGE}`);
      return 2;
  }
}

// Ống dẫn bị đóng sớm (vd `| head`) là chuyện bình thường của một bộ lọc, không phải lỗi.
process.stdout.on("error", (err) => {
  if (err?.code === "EPIPE") process.exit(0);
  throw err;
});

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  console.error(`Lỗi: ${err?.message || err}`);
  process.exitCode = 1;
}
