import test from "node:test";
import assert from "node:assert/strict";
import { buildDailyUniverse, normalizeKline } from "../js/historical-data.js";

test("normalizes Binance kline fields including quote turnover", () => {
  const candle = normalizeKline([0,"100","110","90","105","12",86399999,"1234"]);
  assert.equal(candle.open, 100);
  assert.equal(candle.close, 105);
  assert.equal(candle.quoteVolume, 1234);
});

test("builds a separate turnover-ranked top list for each UTC day", () => {
  const day = 1_800_000_000_000;
  const input = {
    AAAUSDT: [{ openTime: day, open: 100, close: 110, quoteVolume: 1000 }],
    BBBUSDT: [{ openTime: day, open: 100, close: 101, quoteVolume: 2000 }],
    CCCUSDT: [{ openTime: day, open: 100, close: 140, quoteVolume: 9000 }],
    DDDUSDT: [{ openTime: day + 86_400_000, open: 100, close: 99, quoteVolume: 3000 }]
  };
  const result = buildDailyUniverse(input, { startTime: day, endTime: day + 2 * 86_400_000, limit: 2 });
  assert.deepEqual(result[day].map(x => x.symbol), ["BBBUSDT", "AAAUSDT"]);
  assert.deepEqual(result[day + 86_400_000].map(x => x.symbol), ["DDDUSDT"]);
});

test("excludes daily moves strictly beyond plus or minus 30 percent", () => {
  const day = 1_800_000_000_000;
  const input = {
    UPUSDT: [{ openTime: day, open: 100, close: 130.01, quoteVolume: 1000 }],
    DOWNUSDT: [{ openTime: day, open: 100, close: 69.99, quoteVolume: 900 }],
    EDGEUSDT: [{ openTime: day, open: 100, close: 130, quoteVolume: 800 }]
  };
  const result = buildDailyUniverse(input, { startTime: day, endTime: day + 86_400_000 });
  assert.deepEqual(result[day].map(x => x.symbol), ["EDGEUSDT"]);
});
