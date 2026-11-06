import test from "node:test";
import assert from "node:assert/strict";
import { createBacktestRange, runHistoricalBacktest } from "../js/historical-backtest.js";

const tradeConfig = {
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

function makeDataset() {
  const candles = [];
  for (let i = 0; i < 108; i++) {
    const close = 90 + i * 0.1;
    candles.push({
      openTime: i * 900_000,
      closeTime: (i + 1) * 900_000 - 1,
      open: close - 0.02,
      high: close + 0.1,
      low: close - 0.1,
      close
    });
  }
  // One newly closed bullish candle containing all three EMA values.
  candles[105] = {
    openTime: 105 * 900_000,
    closeTime: 106 * 900_000 - 1,
    open: 95,
    high: 112,
    low: 94,
    close: 110
  };
  // The next candle reaches the 1R target after next-open entry.
  candles[106] = {
    openTime: 106 * 900_000,
    closeTime: 107 * 900_000 - 1,
    open: 110,
    high: 130,
    low: 109,
    close: 128
  };
  return {
    startTime: 0,
    endTime: 3 * 86_400_000,
    timeframes: ["15m"],
    dailyUniverse: {
      [86_400_000]: [{ symbol: "TESTUSDT", quoteVolume: 1_000_000 }]
    },
    candlesBySymbolTimeframe: { "TESTUSDT|15m": candles },
    fundingBySymbol: { TESTUSDT: [] },
    limitations: []
  };
}

test("only scans symbols in each historical day's top-100 universe", () => {
  const dataset = makeDataset();
  dataset.dailyUniverse = {};
  const result = runHistoricalBacktest(dataset, {
    timeframes: ["15m"],
    initialCapital: 10_000,
    maxOpenTrades: 5,
    tradeConfig
  });
  assert.equal(result.scanStats.signalsFound, 0);
  assert.equal(result.report.totalTrades, 0);
});

test("connects fresh EMA signals to trade execution and portfolio reporting", () => {
  const result = runHistoricalBacktest(makeDataset(), {
    timeframes: ["15m"],
    initialCapital: 10_000,
    maxOpenTrades: 5,
    tradeConfig
  });
  assert.equal(result.scanStats.signalsFound, 1);
  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0].direction, "LONG");
  assert.equal(result.accepted[0].exitReason, "take_profit");
  assert.equal(result.report.totalTrades, 1);
  assert.equal(result.report.takeProfitCount, 1);
  assert.ok(result.report.netProfit > 0);
});

test("per-timeframe body threshold can reject an otherwise valid signal", () => {
  const result = runHistoricalBacktest(makeDataset(), {
    timeframes: ["15m"],
    timeframeSettings: { "15m": { maxBodyPercent: 5 } },
    initialCapital: 10_000,
    maxOpenTrades: 5,
    tradeConfig
  });
  assert.equal(result.scanStats.signalsFound, 0);
});

test("rolling period helper only accepts the supported 7/30/60 day periods", () => {
  const range = createBacktestRange(7, 10 * 86_400_000 + 1234);
  assert.deepEqual(range, {
    startTime: 3 * 86_400_000,
    endTime: 10 * 86_400_000
  });
  assert.throws(() => createBacktestRange(14), /7, 30, or 60/);
});

test("does not carry EMA signals or trades across missing candle intervals", () => {
  const dataset = makeDataset();
  for (let i = 106; i < dataset.candlesBySymbolTimeframe["TESTUSDT|15m"].length; i++) {
    dataset.candlesBySymbolTimeframe["TESTUSDT|15m"][i].openTime += 900_000;
    dataset.candlesBySymbolTimeframe["TESTUSDT|15m"][i].closeTime += 900_000;
  }
  const result = runHistoricalBacktest(dataset, {
    timeframes: ["15m"],
    initialCapital: 10_000,
    maxOpenTrades: 5,
    tradeConfig
  });
  assert.equal(result.scanStats.missingIntervals, 1);
  assert.equal(result.scanStats.signalsFound, 0);
});

test("reports positions that remain open at the end of the backtest window", () => {
  const dataset = makeDataset();
  dataset.candlesBySymbolTimeframe["TESTUSDT|15m"][106] = {
    openTime: 106 * 900_000, closeTime: 107 * 900_000 - 1,
    open: 110, high: 111, low: 109, close: 110.5
  };
  dataset.candlesBySymbolTimeframe["TESTUSDT|15m"][107] = {
    openTime: 107 * 900_000, closeTime: 108 * 900_000 - 1,
    open: 110.5, high: 112, low: 109, close: 111
  };
  const result = runHistoricalBacktest(dataset, {
    timeframes: ["15m"], initialCapital: 10_000, maxOpenTrades: 5, tradeConfig
  });
  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0].status, "open");
  assert.equal(result.report.openTrades, 1);
});
