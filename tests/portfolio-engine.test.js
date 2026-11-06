import test from "node:test";
import assert from "node:assert/strict";
import { simulatePortfolio } from "../js/portfolio-engine.js";

const config = {
  entryMethod: "next_open",
  hardStopPct: 2,
  auxiliaryStop: "signal_open",
  rr: 1,
  positionNotional: 500,
  entryFeeRate: 0,
  exitFeeRate: 0,
  entrySlippageRate: 0,
  slippageRate: 0,
  timeoutBars: null
};

function longCandles(symbolOffset = 0) {
  return [
    { openTime: 0, closeTime: 9, open: 98 + symbolOffset, high: 101 + symbolOffset, low: 97 + symbolOffset, close: 100 + symbolOffset },
    { openTime: 10, closeTime: 19, open: 100 + symbolOffset, high: 101 + symbolOffset, low: 99 + symbolOffset, close: 100 + symbolOffset },
    { openTime: 20, closeTime: 29, open: 100 + symbolOffset, high: 103 + symbolOffset, low: 99 + symbolOffset, close: 102 + symbolOffset },
    { openTime: 30, closeTime: 39, open: 102 + symbolOffset, high: 103 + symbolOffset, low: 101 + symbolOffset, close: 102 + symbolOffset }
  ];
}

test("same symbol and signal close keeps only shortest timeframe", () => {
  const candles = longCandles();
  const result = simulatePortfolio([
    { symbol: "AAAUSDT", timeframe: "1h", direction: "LONG", distanceRate: 0.01, candles, signalIndex: 0, config },
    { symbol: "AAAUSDT", timeframe: "15m", direction: "LONG", distanceRate: 0.2, candles, signalIndex: 0, config }
  ]);
  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0].timeframe, "15m");
});

test("five open positions maximum; simultaneous candidates rank by EMA distance", () => {
  const candidates = Array.from({ length: 6 }, (_, i) => ({
    symbol: `COIN${i}USDT`,
    timeframe: "1h",
    direction: "LONG",
    distanceRate: 0.01 * (6 - i),
    candles: longCandles(i),
    signalIndex: 0,
    config
  }));
  const result = simulatePortfolio(candidates);
  assert.equal(result.accepted.length, 5);
  assert.equal(result.skipped.filter(x => x.reason === "max_open_trades_reached").length, 1);
  assert.equal(result.accepted[0].symbol, "COIN5USDT");
});

test("an opposite signal is discarded while an existing position is open", () => {
  const first = [
    { openTime: 0, closeTime: 9, open: 98, high: 101, low: 97, close: 100 },
    { openTime: 10, closeTime: 19, open: 100, high: 101, low: 99, close: 100 },
    { openTime: 20, closeTime: 29, open: 100, high: 103, low: 99, close: 102 },
    { openTime: 30, closeTime: 39, open: 102, high: 103, low: 101, close: 102 }
  ];
  const bearish = [
    { openTime: 0, closeTime: 9, open: 102, high: 103, low: 99, close: 100 },
    { openTime: 10, closeTime: 19, open: 100, high: 101, low: 97, close: 98 },
    { openTime: 20, closeTime: 29, open: 98, high: 99, low: 97, close: 98 },
    { openTime: 30, closeTime: 39, open: 98, high: 99, low: 97, close: 98 }
  ];
  const result = simulatePortfolio([
    { symbol: "AAAUSDT", timeframe: "1h", direction: "LONG", distanceRate: 0.1, candles: first, signalIndex: 0, config },
    { symbol: "AAAUSDT", timeframe: "1h", direction: "SHORT", distanceRate: 0.1, candles: bearish, signalIndex: 1, config }
  ]);
  assert.equal(result.accepted.length, 1);
  assert.equal(result.skipped.some(x => x.reason === "opposite_position_open_at_signal"), true);
});
