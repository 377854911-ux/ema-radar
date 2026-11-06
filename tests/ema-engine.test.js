import test from "node:test";
import assert from "node:assert/strict";
import { calculateEMA, analyzeLatestClosedSignal, rankAndDeduplicateSignals } from "../js/ema-engine.js";

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

test("only EMA distance ranks signals; shortest timeframe wins same-symbol tie", () => {
  const ranked = rankAndDeduplicateSignals([
    { symbol: "AAAUSDT", direction: "LONG", timeframe: "1h", distanceRate: 0.2 },
    { symbol: "AAAUSDT", direction: "LONG", timeframe: "15m", distanceRate: 0.2 },
    { symbol: "BBBUSDT", direction: "SHORT", timeframe: "4h", distanceRate: 0.1 }
  ]);
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].symbol, "BBBUSDT");
  assert.equal(ranked[1].timeframe, "15m");
});
