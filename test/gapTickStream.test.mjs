import { test } from "node:test";
import assert from "node:assert/strict";

import { createPairTickStream, DEFAULT_HEARTBEAT_MS } from "../src/renderer/utils/gapTickStream.js";
import { decodeGapTickRecord, toGapTickLineInput, TICKS_MAX } from "../src/renderer/utils/gapTickRecord.js";
import { formatGapTickLine } from "../src/renderer/utils/gapTickLine.js";

const POINT = 100;

// Quote đúng như poller dựng trong quoteByMap (xem app.js: {...row, spread, latencyMs, status}).
function quote({ seq, symbol = "XAUUSD", bid, ask, lat = 8, timeMsc = 1_789_000_000_000 }) {
  return {
    status: "FOUND",
    symbol,
    bid,
    ask,
    spread: ask - bid,
    latencyMs: lat,
    quote_seq: seq,
    time_msc: timeMsc,
  };
}

function lineFromRecord(emitted, symA, symB) {
  const rec = decodeGapTickRecord(new Uint8Array(emitted.bytes));
  return formatGapTickLine(toGapTickLineInput(rec, { symA, symB, point: POINT }));
}

// Đúng cách writer text cũ dựng dòng cho một lần poll.
function legacyLine(nowMs, qA, qB) {
  const side = (q) =>
    q?.status === "FOUND" ? { sym: q.symbol, bid: q.bid, ask: q.ask, spread: q.spread, lat: q.latencyMs } : {};
  const ok = qA?.status === "FOUND" && qB?.status === "FOUND";
  return formatGapTickLine({
    timeMs: nowMs,
    gapBuy: ok ? (qB.bid - qA.ask) * POINT : null,
    gapSell: ok ? (qB.ask - qA.bid) * POINT : null,
    a: side(qA),
    b: side(qB),
    point: POINT,
  });
}

test("bản ghi nhị phân dựng lại đúng dòng text mà writer cũ sẽ ghi", () => {
  const stream = createPairTickStream();
  const qA = quote({ seq: 10, bid: 2412.35, ask: 2412.55, lat: 8 });
  const qB = quote({ seq: 20, symbol: "XAUUSD.m", bid: 2412.67, ask: 2412.88, lat: 11 });

  const emitted = stream.next(qA, qB, 1_700_000_000_123);
  assert.ok(emitted);
  assert.equal(lineFromRecord(emitted, "XAUUSD", "XAUUSD.m"), legacyLine(1_700_000_000_123, qA, qB));
});

test("một phía mất dữ liệu: dòng dựng lại vẫn khớp writer cũ", () => {
  const stream = createPairTickStream();
  const qA = quote({ seq: 10, bid: 2412.35, ask: 2412.55 });
  const emitted = stream.next(qA, { status: "NOT_FOUND" }, 1_700_000_000_000);

  assert.ok(emitted);
  assert.equal(emitted.symB, undefined);
  assert.equal(
    lineFromRecord(emitted, "XAUUSD", "XAUUSD.m"),
    legacyLine(1_700_000_000_000, qA, { status: "NOT_FOUND" })
  );
});

test("giá không đổi (quote_seq giữ nguyên) thì không ghi gì", () => {
  const stream = createPairTickStream();
  const qA = quote({ seq: 10, bid: 1, ask: 2 });
  const qB = quote({ seq: 20, bid: 3, ask: 4 });

  assert.ok(stream.next(qA, qB, 1000));
  // 30 ms/lần trong gần 1 giây, quote_seq không đổi -> im lặng hoàn toàn.
  for (let t = 1030; t < 1000 + DEFAULT_HEARTBEAT_MS; t += 30) {
    assert.equal(stream.next(qA, qB, t), null, `t=${t} không được ghi`);
  }
});

test("chỉ cần một phía đổi quote_seq là ghi", () => {
  const stream = createPairTickStream();
  const qA = quote({ seq: 10, bid: 1, ask: 2 });
  const qB = quote({ seq: 20, bid: 3, ask: 4 });
  stream.next(qA, qB, 1000);

  assert.equal(stream.next(qA, qB, 1030), null);
  assert.ok(stream.next(quote({ seq: 11, bid: 1, ask: 2 }), qB, 1060), "A đổi seq phải ghi");
  assert.ok(stream.next(quote({ seq: 11, bid: 1, ask: 2 }), quote({ seq: 21, bid: 3, ask: 4 }), 1090), "B đổi seq phải ghi");
});

test("quote_seq đổi nhưng giá y hệt vẫn ghi (tick thật của broker)", () => {
  const stream = createPairTickStream();
  const qB = quote({ seq: 20, bid: 3, ask: 4 });
  stream.next(quote({ seq: 10, bid: 1, ask: 2 }), qB, 1000);

  const emitted = stream.next(quote({ seq: 11, bid: 1, ask: 2 }), qB, 1030);
  assert.ok(emitted);
  assert.equal(emitted.heartbeat, false);
});

test("đứng yên quá heartbeat thì ghi heartbeat, mang theo giá và latency hiện tại", () => {
  const stream = createPairTickStream();
  const qA = quote({ seq: 10, bid: 1, ask: 2, lat: 5 });
  const qB = quote({ seq: 20, bid: 3, ask: 4, lat: 7 });
  stream.next(qA, qB, 1000);

  const hb = stream.next(qA, qB, 1000 + DEFAULT_HEARTBEAT_MS);
  assert.ok(hb, "phải có heartbeat để phân biệt giá đứng yên với app treo");
  assert.equal(hb.heartbeat, true);

  const rec = decodeGapTickRecord(new Uint8Array(hb.bytes));
  assert.equal(rec.heartbeat, true);
  assert.equal(rec.a.bid, 1);
  assert.equal(rec.a.lat, 5);
  assert.equal(rec.b.lat, 7);
  assert.equal(rec.dataGap, false);

  // Heartbeat làm mốc mới: chưa tới hạn kế tiếp thì lại im lặng.
  assert.equal(stream.next(qA, qB, 1000 + DEFAULT_HEARTBEAT_MS + 30), null);
});

test("ngắt quãng dài hơn 3 heartbeat được gắn cờ dataGap", () => {
  const stream = createPairTickStream();
  const qA = quote({ seq: 10, bid: 1, ask: 2 });
  const qB = quote({ seq: 20, bid: 3, ask: 4 });
  stream.next(qA, qB, 1000);

  const after = stream.next(qA, qB, 1000 + DEFAULT_HEARTBEAT_MS * 3 + 1);
  assert.equal(decodeGapTickRecord(new Uint8Array(after.bytes)).dataGap, true);
});

test("phía đổi trạng thái có/không có dữ liệu thì ghi ngay", () => {
  const stream = createPairTickStream();
  const qA = quote({ seq: 10, bid: 1, ask: 2 });
  const qB = quote({ seq: 20, bid: 3, ask: 4 });
  stream.next(qA, qB, 1000);

  const lost = stream.next(qA, { status: "NOT_FOUND" }, 1030);
  assert.ok(lost, "mất dữ liệu một phía phải ghi ngay, không đợi heartbeat");
  assert.equal(decodeGapTickRecord(new Uint8Array(lost.bytes)).b, null);

  assert.ok(stream.next(qA, qB, 1060), "có lại dữ liệu cũng phải ghi ngay");
});

test("thiếu quote_seq thì lùi về so giá, không im lặng bỏ hết", () => {
  const stream = createPairTickStream();
  const noSeq = (bid) => ({ status: "FOUND", symbol: "X", bid, ask: bid + 0.2, spread: 0.2, latencyMs: 5 });

  assert.ok(stream.next(noSeq(1), noSeq(3), 1000));
  assert.equal(stream.next(noSeq(1), noSeq(3), 1030), null);
  assert.ok(stream.next(noSeq(1.5), noSeq(3), 1060), "giá đổi mà không có quote_seq vẫn phải ghi");
});

test("mỗi lần ghi là một ArrayBuffer riêng, không dùng chung đệm", () => {
  const stream = createPairTickStream();
  const first = stream.next(quote({ seq: 1, bid: 1, ask: 2 }), quote({ seq: 2, bid: 3, ask: 4 }), 1000);
  const second = stream.next(quote({ seq: 2, bid: 9, ask: 10 }), quote({ seq: 3, bid: 3, ask: 4 }), 1030);

  assert.notEqual(first.bytes, second.bytes);
  assert.equal(decodeGapTickRecord(new Uint8Array(first.bytes)).a.bid, 1, "bản ghi cũ bị ghi đè");
  assert.equal(decodeGapTickRecord(new Uint8Array(second.bytes)).a.bid, 9);
});

test("ticks = số tick giữa hai lần GHI; 0 và 1 phân biệt được", () => {
  const stream = createPairTickStream();
  const qB = quote({ seq: 20, bid: 3, ask: 4 });

  // Bản ghi đầu: chưa có mốc so sánh nhưng đang cầm một tick -> 1.
  let rec = decodeGapTickRecord(new Uint8Array(stream.next(quote({ seq: 10, bid: 1, ask: 2 }), qB, 1000).bytes));
  assert.equal(rec.a.ticks, 1);
  assert.equal(rec.b.ticks, 1);

  // seq nhảy 10 -> 14: có 4 tick, bắt được cái cuối, bỏ sót 3.
  rec = decodeGapTickRecord(new Uint8Array(stream.next(quote({ seq: 14, bid: 1.1, ask: 2.1 }), qB, 1030).bytes));
  assert.equal(rec.a.ticks, 4);
  assert.equal(rec.b.ticks, 0, "B không đổi seq thì không có tick mới");

  // Liền kề -> đúng 1 tick, không bỏ sót.
  rec = decodeGapTickRecord(new Uint8Array(stream.next(quote({ seq: 15, bid: 1.2, ask: 2.2 }), qB, 1060).bytes));
  assert.equal(rec.a.ticks, 1);
});

test("ticks tính đúng qua mốc quay vòng uint32", () => {
  const stream = createPairTickStream();
  const qB = quote({ seq: 20, bid: 3, ask: 4 });
  stream.next(quote({ seq: 2 ** 32 - 3, bid: 1, ask: 2 }), qB, 1000);

  const rec = decodeGapTickRecord(new Uint8Array(stream.next(quote({ seq: 1, bid: 1.1, ask: 2.1 }), qB, 1030).bytes));
  assert.equal(rec.a.ticks, 4); // 4294967293 -> 4294967294, 4294967295, 0, 1
});

test("heartbeat không mang tick mới nào", () => {
  const stream = createPairTickStream();
  const qA = quote({ seq: 10, bid: 1, ask: 2 });
  const qB = quote({ seq: 20, bid: 3, ask: 4 });
  stream.next(qA, qB, 1000);

  const hb = stream.next(qA, qB, 1000 + DEFAULT_HEARTBEAT_MS);
  assert.equal(hb.heartbeat, true);
  const rec = decodeGapTickRecord(new Uint8Array(hb.bytes));
  assert.equal(rec.a.ticks, 0);
  assert.equal(rec.b.ticks, 0);
});

test("quá 255 tick thì chặn trần, không tràn byte", () => {
  const stream = createPairTickStream();
  const qB = quote({ seq: 20, bid: 3, ask: 4 });
  stream.next(quote({ seq: 10, bid: 1, ask: 2 }), qB, 1000);

  const rec = decodeGapTickRecord(new Uint8Array(stream.next(quote({ seq: 10_000, bid: 1.1, ask: 2.1 }), qB, 1030).bytes));
  assert.equal(rec.a.ticks, TICKS_MAX);
});

test("không có quote_seq thì không đo được -> 0", () => {
  const stream = createPairTickStream();
  const noSeq = (bid) => ({ status: "FOUND", symbol: "X", bid, ask: bid + 0.2, spread: 0.2, latencyMs: 5 });
  stream.next(noSeq(1), noSeq(3), 1000);

  const rec = decodeGapTickRecord(new Uint8Array(stream.next(noSeq(1.5), noSeq(3), 1030).bytes));
  assert.equal(rec.a.ticks, 0);
});

test("ticks không lọt vào dòng text dựng lại", () => {
  const stream = createPairTickStream();
  const qB = quote({ seq: 20, symbol: "XAUUSD.m", bid: 2412.67, ask: 2412.88, lat: 11 });
  stream.next(quote({ seq: 10, bid: 2412.35, ask: 2412.55, lat: 8 }), qB, 1_700_000_000_000);

  const qA2 = quote({ seq: 99, bid: 2412.4, ask: 2412.6, lat: 8 });
  const emitted = stream.next(qA2, qB, 1_700_000_000_123);
  assert.equal(decodeGapTickRecord(new Uint8Array(emitted.bytes)).a.ticks, 89);
  // Dòng text cũ không có trường này, nên bản dựng lại phải y hệt writer cũ.
  assert.equal(lineFromRecord(emitted, "XAUUSD", "XAUUSD.m"), legacyLine(1_700_000_000_123, qA2, qB));
});

test("reset() xóa trạng thái để phiên Start mới ghi lại từ đầu", () => {
  const stream = createPairTickStream();
  const qA = quote({ seq: 10, bid: 1, ask: 2 });
  const qB = quote({ seq: 20, bid: 3, ask: 4 });
  stream.next(qA, qB, 1000);
  assert.equal(stream.next(qA, qB, 1030), null);

  stream.reset();
  assert.ok(stream.next(qA, qB, 1060));
});
