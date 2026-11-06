import test from "node:test";
import assert from "node:assert/strict";
import { simulateTrade, summarizeBacktest } from "../js/backtest-engine.js";

const candles = [
  { openTime: 0, closeTime: 59_999, open: 98, high: 101, low: 97, close: 100 },
  { openTime: 60_000, closeTime: 119_999, open: 100, high: 111, low: 99, close: 110 },
  { openTime: 120_000, closeTime: 179_999, open: 110, high: 112, low: 109, close: 111 },
  { openTime: 180_000, closeTime: 239_999, open: 111, high: 112, low: 108, close: 109 },
  { openTime: 240_000, closeTime: 299_999, open: 109, high: 110, low: 107, close: 108 },
  { openTime: 300_000, closeTime: 359_999, open: 108, high: 109, low: 106, close: 107 }
];
const base = {
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

test("next-open entry and take-profit are calculated from actual entry", () => {
  const result = simulateTrade({ candles, signalIndex: 0, direction: "LONG", config: base });
  assert.equal(result.status, "closed");
  assert.equal(result.entryPrice, 100);
  assert.equal(result.exitReason, "take_profit");
  assert.equal(result.exitPrice, 102);
  assert.equal(result.netPnl, 10);
});

test("same-candle stop and target collision offsets gross PnL to zero but charges fees", () => {
  const data = [
    { openTime: 0, closeTime: 9, open: 98, high: 101, low: 97, close: 100 },
    { openTime: 10, closeTime: 19, open: 100, high: 105, low: 97, close: 101 },
    { openTime: 20, closeTime: 29, open: 101, high: 102, low: 100, close: 101 }
  ];
  const result = simulateTrade({
    candles: data, signalIndex: 0, direction: "LONG",
    config: { ...base, entryFeeRate: 0.1, exitFeeRate: 0.1 }
  });
  assert.equal(result.exitReason, "ambiguous_both_touched");
  assert.equal(result.exitPrice, 100);
  assert.equal(result.grossPnl, 0);
  assert.equal(result.entryFee, 0.5);
  assert.equal(result.exitFee, 0.5);
  assert.equal(result.netPnl, -1);
});

test("retracement limit uses the configured body percentage and cancels if unfilled", () => {
  const data = [
    { openTime: 0, closeTime: 9, open: 100, high: 111, low: 99, close: 110 },
    { openTime: 10, closeTime: 19, open: 109, high: 110, low: 107, close: 108 },
    { openTime: 20, closeTime: 29, open: 108, high: 109, low: 107, close: 108 }
  ];
  const result = simulateTrade({
    candles: data, signalIndex: 0, direction: "LONG",
    config: { ...base, entryMethod: "retracement_limit", retracementPct: 20, limitValidityBars: 1 }
  });
  assert.equal(result.entryPrice, 108);
  assert.equal(result.entryIndex, 1);

  const noFill = simulateTrade({
    candles: data.map((c, i) => i === 1 ? { ...c, open: 109, low: 109, close: 109.5 } : c),
    signalIndex: 0, direction: "LONG",
    config: { ...base, entryMethod: "retracement_limit", retracementPct: 20, limitValidityBars: 1 }
  });
  assert.equal(noFill.status, "unfilled");
});

test("market-style exit slippage is adverse and fees are itemized", () => {
  const data = [
    { openTime: 0, closeTime: 9, open: 98, high: 101, low: 97, close: 100 },
    { openTime: 10, closeTime: 19, open: 100, high: 101, low: 97, close: 99 },
    { openTime: 20, closeTime: 29, open: 99, high: 100, low: 98, close: 99 }
  ];
  const result = simulateTrade({
    candles: data, signalIndex: 0, direction: "LONG",
    config: { ...base, entryFeeRate: 0.1, exitFeeRate: 0.1, slippageRate: 0.2 }
  });
  assert.equal(result.exitReason, "stop_loss");
  assert.ok(result.exitPrice < 98);
  assert.ok(result.entryFee > 0);
  assert.ok(result.exitFee > 0);
});

test("timeout counts complete candles after entry", () => {
  const timeoutCandles = candles
    .map((c, i) => i === 1 ? { ...c, high: 105, close: 104 } : c)
    .map((c, i) => i === 2 ? { ...c, open: 104, high: 105, low: 103, close: 104 } : c);
  const result = simulateTrade({
    candles: timeoutCandles, signalIndex: 0, direction: "LONG",
    config: { ...base, timeoutBars: 2, rr: 5 }
  });
  assert.equal(result.exitReason, "timeout");
  assert.equal(result.exitIndex, 2);
});

test("funding is direction-aware and missing funding marks trade incomplete", () => {
  const data = [
    { openTime: 0, closeTime: 9, open: 98, high: 101, low: 97, close: 100 },
    { openTime: 10, closeTime: 19, open: 100, high: 101, low: 99, close: 100 },
    { openTime: 20, closeTime: 29, open: 100, high: 103, low: 99, close: 102 }
  ];
  const long = simulateTrade({
    candles: data, signalIndex: 0, direction: "LONG",
    config: { ...base, rr: 1 },
    fundingEvents: [{ fundingTime: 15, rate: 0.001, markPrice: 100 }]
  });
  assert.equal(long.fundingPnl, -0.5);
  const missing = simulateTrade({
    candles: data, signalIndex: 0, direction: "LONG",
    config: { ...base, rr: 1 },
    fundingEvents: [{ fundingTime: 15, rate: null, markPrice: 100 }]
  });
  assert.equal(missing.status, "incomplete");
  assert.equal(missing.netPnl, null);
});

test("summary excludes incomplete trades from headline statistics", () => {
  const summary = summarizeBacktest([
    { status: "closed", netPnl: 20, exitReason: "take_profit" },
    { status: "closed", netPnl: -10, exitReason: "stop_loss" },
    { status: "incomplete", netPnl: null, exitReason: "stop_loss" }
  ]);
  assert.equal(summary.totalTrades, 2);
  assert.equal(summary.winRatePct, 50);
  assert.equal(summary.netProfit, 10);
  assert.equal(summary.takeProfitCount, 1);
  assert.equal(summary.stopLossCount, 1);
  assert.equal(summary.incompleteTrades, 1);
});

test("invalid risk settings are rejected instead of silently normalized", () => {
  assert.throws(() => simulateTrade({
    candles, signalIndex: 0, direction: "LONG",
    config: { ...base, hardStopPct: 2.5 }
  }), /integer from 1 to 20/);
});


test("ambiguous trades are excluded from win rate denominator but fees remain in net profit", () => {
  const summary = summarizeBacktest([
    { status: "closed", netPnl: 20, exitReason: "take_profit" },
    { status: "closed", netPnl: -10, exitReason: "stop_loss" },
    { status: "closed", netPnl: -1, exitReason: "ambiguous_both_touched" }
  ]);
  assert.equal(summary.totalTrades, 3);
  assert.equal(summary.resolvedTrades, 2);
  assert.equal(summary.ambiguousTradeCount, 1);
  assert.equal(summary.winRatePct, 50);
  assert.equal(summary.netProfit, 9);
  assert.equal(summary.takeProfitCount, 1);
  assert.equal(summary.stopLossCount, 1);
});
