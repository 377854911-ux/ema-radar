import test from "node:test";
import assert from "node:assert/strict";
import { calculateEMA, analyzeLatestClosedSignal, rankAndDeduplicateSignals, EMA_WARMUP_BARS } from "../js/ema-engine.js";

function makeCandle(openTime, open, high, low, close, closeTime = openTime + 59_999) {
  return [openTime, String(open), String(high), String(low), String(close), "0", closeTime];
}

function risingHistory() {
  return Array.from({ length: EMA_WARMUP_BARS }, (_, i) => {
    const close = 100 + i * 0.1;
    return makeCandle(i * 60_000, close - 0.02, close + 0.03, close - 0.03, close);
  });
}

function fallingHistory() {
  return Array.from({ length: 100 }, (_, i) => {
    const close = 120 - i * 0.1;
    return makeCandle(i * 60_000, close + 0.02, close + 0.03, close - 0.03, close);
  });
}

test("EMA uses SMA seed and recursive smoothing", () => {
  const ema = calculateEMA([1, 2, 3, 4, 5], 3);
  assert.equal(ema[0], null);
  assert.equal(ema[1], null);
  assert.equal(ema[2], 2);
  assert.equal(ema[3], 3);
  assert.equal(ema[4], 4);
});

test("insufficient candles do not create a signal", () => {
  const result = analyzeLatestClosedSignal([]);
  assert.equal(result.signal, null);
  assert.equal(result.reason, "not_enough_candles");
});

test("detects a bullish candle containing all three EMAs with EMA100 lowest after 500 warm-up bars", () => {
  const candles = risingHistory();
  const closes = candles.map(row => Number(row[4]));
  const e25 = calculateEMA(closes, 25).at(-1);
  const e50 = calculateEMA(closes, 50).at(-1);
  const e100 = calculateEMA(closes, 100).at(-1);
  const open = e100 - 1;
  const close = Math.max(e25, e50, e100) + 1;
  candles.push(makeCandle(30_000_000, open, close + 0.1, open - 0.1, close));
  candles.push(makeCandle(30_060_000, close, close + 0.2, close - 0.2, close + 0.1));
  const result = analyzeLatestClosedSignal(candles, { timeframe: "1m" });
  assert.equal(result.signal?.direction, "LONG");
  assert.ok(result.signal.ema100 < result.signal.ema25);
  assert.ok(result.signal.ema100 < result.signal.ema50);
});

test("detects a bearish candle containing all three EMAs with EMA100 highest after 500 warm-up bars", () => {
  const candles = fallingHistory();
  const closes = candles.map(row => Number(row[4]));
  const e25 = calculateEMA(closes, 25).at(-1);
  const e50 = calculateEMA(closes, 50).at(-1);
  const e100 = calculateEMA(closes, 100).at(-1);
  const open = Math.max(e25, e50, e100) + 1;
  const close = Math.min(e25, e50, e100) - 1;
  candles.push(makeCandle(6_000_000, open, open + 0.1, close - 0.1, close));
  candles.push(makeCandle(6_060_000, close, close + 0.2, close - 0.2, close - 0.1));
  const result = analyzeLatestClosedSignal(candles, { timeframe: "1m" });
  assert.equal(result.signal?.direction, "SHORT");
  assert.ok(result.signal.ema100 > result.signal.ema25);
  assert.ok(result.signal.ema100 > result.signal.ema50);
});

test("only the latest completed candle can signal; a later completed candle expires it", () => {
  const candles = risingHistory();
  const closes = candles.map(row => Number(row[4]));
  const e25 = calculateEMA(closes, 25).at(-1);
  const e50 = calculateEMA(closes, 50).at(-1);
  const e100 = calculateEMA(closes, 100).at(-1);
  const open = e100 - 1;
  const close = Math.max(e25, e50, e100) + 1;
  candles.push(makeCandle(6_000_000, open, close + 0.1, open - 0.1, close));
  candles.push(makeCandle(6_060_000, close, close + 0.2, close - 0.2, close + 0.1));
  assert.equal(analyzeLatestClosedSignal(candles).signal?.direction, "LONG");
  candles.push(makeCandle(30_120_000, close + 0.1, close + 0.3, close, close + 0.2));
  assert.equal(analyzeLatestClosedSignal(candles).signal, null);
});

test("same symbol always keeps its shortest qualifying timeframe before ranking", () => {
  const ranked = rankAndDeduplicateSignals([
    { symbol: "AAAUSDT", direction: "LONG", timeframe: "1h", distanceRate: 0.01 },
    { symbol: "AAAUSDT", direction: "SHORT", timeframe: "15m", distanceRate: 0.2 },
    { symbol: "BBBUSDT", direction: "SHORT", timeframe: "4h", distanceRate: 0.1 }
  ]);
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].symbol, "BBBUSDT");
  assert.equal(ranked[1].symbol, "AAAUSDT");
  assert.equal(ranked[1].timeframe, "15m");
  assert.equal(ranked[1].direction, "SHORT");
});

test("supported timeframes match intervals available from Binance futures klines", async () => {
  const { TIMEFRAME_MINUTES } = await import("../js/ema-engine.js");
  assert.equal(Object.hasOwn(TIMEFRAME_MINUTES, "10m"), false);
  assert.equal(TIMEFRAME_MINUTES["15m"], 15);
  assert.equal(TIMEFRAME_MINUTES["30m"], 30);
});
