import { test } from "node:test";
import assert from "node:assert/strict";
import { formatGapTickLine, formatTickTime } from "../src/renderer/utils/gapTickLine.js";

// 2026-09-19 14:32:07.412 giờ local của máy chạy test.
const TIME_MS = new Date(2026, 8, 19, 14, 32, 7, 412).getTime();

test("dòng đủ trường, đúng thứ tự và prefix timestamp như trade-multi", () => {
  const line = formatGapTickLine({
    timeMs: TIME_MS,
    gapBuy: 12,
    gapSell: -3,
    a: { sym: "XAUUSD", bid: 2412.35, ask: 2412.55, spread: 0.2, lat: 8 },
    b: { sym: "XAUUSD.m", bid: 2412.67, ask: 2412.88, spread: 0.21, lat: 11 },
    point: 100,
  });

  assert.equal(
    line,
    "[14:32:07.412] [GAP_TICK] gap_buy=12 gap_sell=-3 " +
      "a_sym=XAUUSD a_bid=2412.35 a_ask=2412.55 a_spread=0.2 a_lat=8 " +
      "b_sym=XAUUSD.m b_bid=2412.67 b_ask=2412.88 b_spread=0.21 b_lat=11 point=100"
  );
});

test("thiếu dữ liệu một sàn và không có gap thì ghi '-'", () => {
  const line = formatGapTickLine({
    timeMs: TIME_MS,
    gapBuy: null,
    gapSell: undefined,
    a: { sym: "XAUUSD", bid: 2412.35, ask: 2412.55, spread: 0.2, lat: 8 },
    b: {},
    point: 100,
  });

  assert.match(line, / gap_buy=- gap_sell=- /);
  assert.match(line, / b_sym=- b_bid=- b_ask=- b_spread=- b_lat=- point=100$/);
});

test("giá trị không phải số hữu hạn và symbol rỗng đều thành '-'", () => {
  const line = formatGapTickLine({
    timeMs: TIME_MS,
    gapBuy: Number.NaN,
    gapSell: Infinity,
    a: { sym: "   ", bid: "abc", ask: Infinity, spread: null, lat: undefined },
    b: { sym: "B", bid: 1, ask: 2, spread: 1, lat: 0 },
    point: undefined,
  });

  assert.match(line, / gap_buy=- gap_sell=- a_sym=- a_bid=- a_ask=- a_spread=- a_lat=- /);
  assert.match(line, / point=-$/);
});

test("gap làm tròn về số nguyên point, latency làm tròn ms, số dùng dấu chấm", () => {
  const line = formatGapTickLine({
    timeMs: TIME_MS,
    gapBuy: 11.999999999,
    gapSell: -2.5000001,
    a: { sym: "A", bid: 1234.5, ask: 1234.75, spread: 0.25, lat: 7.6 },
    b: { sym: "B", bid: 1234.6, ask: 1234.8, spread: 0.2, lat: 0.2 },
    point: 100,
  });

  assert.match(line, / gap_buy=12 gap_sell=-3 /);
  assert.match(line, / a_bid=1234.5 a_ask=1234.75 a_spread=0.25 a_lat=8 /);
  assert.match(line, / b_lat=0 /);
  assert.doesNotMatch(line, /,/);
});

test("spread/giá khử nhiễu dấu phẩy động", () => {
  const line = formatGapTickLine({
    timeMs: TIME_MS,
    a: { sym: "XAUUSD", bid: 2412.35, ask: 2412.55, spread: 2412.55 - 2412.35, lat: 8 },
    b: { sym: "EURUSD", bid: 1.08331, ask: 1.08345, spread: 1.08345 - 1.08331, lat: 8 },
    point: 100,
  });
  assert.match(line, / a_spread=0\.2 /);
  assert.match(line, / b_bid=1\.08331 b_ask=1\.08345 b_spread=0\.00014 /);
});

test("formatTickTime đệm số 0 và thời điểm không hợp lệ ra '-'", () => {
  assert.equal(formatTickTime(new Date(2026, 0, 2, 3, 4, 5, 6).getTime()), "03:04:05.006");
  assert.equal(formatTickTime(Number.NaN), "-");
});
