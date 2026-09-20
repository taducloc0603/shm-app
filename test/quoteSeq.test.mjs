import { test } from "node:test";
import assert from "node:assert/strict";

import { calcQuoteSeqDelta } from "../src/renderer/utils/quoteSeq.js";

test("hiệu quote_seq thông thường", () => {
  assert.equal(calcQuoteSeqDelta(105, 100), 5);
  assert.equal(calcQuoteSeqDelta(100, 100), 0);
});

test("quay vòng uint32", () => {
  assert.equal(calcQuoteSeqDelta(3, 2 ** 32 - 2), 5);
  assert.equal(calcQuoteSeqDelta(0, 2 ** 32 - 1), 1);
});

test("thiếu số thì trả null", () => {
  assert.equal(calcQuoteSeqDelta(NaN, 1), null);
  assert.equal(calcQuoteSeqDelta(1, null), null);
  assert.equal(calcQuoteSeqDelta(1, undefined), null);
});
