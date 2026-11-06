import test from "node:test";
import assert from "node:assert/strict";
import { createBacktestRange, runHistoricalBacktest } from "../js/historical-backtest.js";
import { calculateEMA } from "../js/ema-engine.js";

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
  for (let i = 0; i < 508; i++) {
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
  // Build a fresh signal after 500 complete warm-up bars.
  const signalIndex = 505;
  const closes = candles.map(candle => candle.close);
  const emas = [25, 50, 100].map(period => calculateEMA(closes, period)[signalIndex]);
  const signalOpen = Math.min(...emas) - 1;
  const signalClose = Math.max(...emas) + 1;
  candles[signalIndex] = {
    openTime: signalIndex * 900_000,
    closeTime: (signalIndex + 1) * 900_000 - 1,
    open: signalOpen,
    high: signalClose + 1,
    low: signalOpen - 1,
    close: signalClose
  };
  candles[signalIndex + 1] = {
    openTime: (signalIndex + 1) * 900_000,
    closeTime: (signalIndex + 2) * 900_000 - 1,
    open: signalClose,
    high: signalClose * 1.1,
    low: signalClose - 0.1,
    close: signalClose * 1.05
  };
  return {
    startTime: 0,
    endTime: 508 * 900_000,
    timeframes: ["15m"],
    dailyUniverse: {
      [4 * 86_400_000]: [{ symbol: "TESTUSDT", quoteVolume: 1_000_000 }]
    },
    candlesBySymbolTimeframe: { "TESTUSDT|15m": candles },
    fundingBySymbol: { TESTUSDT: [] },
    limitations: []
  };
}

test("rejects unsupported 10m timeframe at the historical backtest boundary", async () => {
  await assert.rejects(() => runHistoricalBacktest(makeDataset(), {
    timeframes: ["10m"],
    initialCapital: 10_000,
    maxOpenTrades: 5,
    tradeConfig
  }), /Unsupported timeframe: 10m/);
});

test("uses the preceding completed UTC day's top-100 universe, not the signal day's final turnover", async () => {
  const dataset = makeDataset();
  const signalDay = 86_400_000;
  dataset.dailyUniverse = {
    [signalDay]: [{ symbol: "TESTUSDT", quoteVolume: 9_000_000 }]
  };
  const result = await runHistoricalBacktest(dataset, {
    timeframes: ["15m"], initialCapital: 10_000, maxOpenTrades: 5, tradeConfig
  });
  assert.equal(result.scanStats.signalsFound, 0);
  assert.equal(result.report.totalTrades, 0);
});

test("only scans symbols in each historical day's applicable prior-day top-100 universe", async () => {
  const dataset = makeDataset();
  dataset.dailyUniverse = {};
  const result = await runHistoricalBacktest(dataset, {
    timeframes: ["15m"],
    initialCapital: 10_000,
    maxOpenTrades: 5,
    tradeConfig
  });
  assert.equal(result.scanStats.signalsFound, 0);
  assert.equal(result.report.totalTrades, 0);
});

test("connects fresh EMA signals to trade execution and portfolio reporting", async () => {
  const result = await runHistoricalBacktest(makeDataset(), {
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
  assert.equal(result.datasetStats.symbolsIncluded, 1);
  assert.equal(result.datasetStats.dailyUniverseDays, 1);
  assert.equal(result.datasetStats.candleSeries, 1);
  assert.ok(result.report.netProfit > 0);
});

test("per-timeframe body threshold can reject an otherwise valid signal", async () => {
  const result = await runHistoricalBacktest(makeDataset(), {
    timeframes: ["15m"],
    timeframeSettings: { "15m": { maxBodyPercent: 1 } },
    initialCapital: 10_000,
    maxOpenTrades: 5,
    tradeConfig
  });
  assert.equal(result.scanStats.signalsFound, 0);
});

test("rolling period helper only accepts the supported 7/30/60 day periods", async () => {
  const range = createBacktestRange(7, 10 * 86_400_000 + 1234);
  assert.deepEqual(range, {
    startTime: 3 * 86_400_000,
    endTime: 10 * 86_400_000
  });
  assert.throws(() => createBacktestRange(14), /7, 30, or 60/);
});

test("does not carry EMA signals or trades across missing candle intervals", async () => {
  const dataset = makeDataset();
  dataset.endTime = 509 * 900_000;
  for (let i = 506; i < dataset.candlesBySymbolTimeframe["TESTUSDT|15m"].length; i++) {
    dataset.candlesBySymbolTimeframe["TESTUSDT|15m"][i].openTime += 900_000;
    dataset.candlesBySymbolTimeframe["TESTUSDT|15m"][i].closeTime += 900_000;
  }
  const result = await runHistoricalBacktest(dataset, {
    timeframes: ["15m"],
    initialCapital: 10_000,
    maxOpenTrades: 5,
    tradeConfig
  });
  assert.equal(result.scanStats.missingIntervals, 1);
  assert.equal(result.scanStats.signalsFound, 0);
});

test("a data gap forces a fresh 500-bar EMA warm-up before new signals", async () => {
  const dataset = makeDataset();
  dataset.endTime = 509 * 900_000;
  for (let i = 250; i < dataset.candlesBySymbolTimeframe["TESTUSDT|15m"].length; i++) {
    dataset.candlesBySymbolTimeframe["TESTUSDT|15m"][i].openTime += 900_000;
    dataset.candlesBySymbolTimeframe["TESTUSDT|15m"][i].closeTime += 900_000;
  }
  const result = await runHistoricalBacktest(dataset, {
    timeframes: ["15m"], initialCapital: 10_000, maxOpenTrades: 5, tradeConfig
  });
  assert.equal(result.scanStats.missingIntervals, 1);
  assert.equal(result.scanStats.signalsFound, 0);
  assert.ok(result.scanStats.missingSeries.some(item =>
    item.reason === "contiguous_segment_too_short_after_data_gap"
  ));
});

test("skips a series when its trailing historical candles are missing", async () => {
  const dataset = makeDataset();
  dataset.candlesBySymbolTimeframe["TESTUSDT|15m"].pop();
  const result = await runHistoricalBacktest(dataset, {
    timeframes: ["15m"], initialCapital: 10_000, maxOpenTrades: 5, tradeConfig
  });
  assert.equal(result.scanStats.signalsFound, 0);
  assert.ok(result.scanStats.missingSeries.some(item =>
    item.reason === "trailing_candles_missing"
  ));
});

test("reports positions that remain open at the end of the backtest window", async () => {
  const dataset = makeDataset();
  const entry = dataset.candlesBySymbolTimeframe["TESTUSDT|15m"][505].close;
  dataset.candlesBySymbolTimeframe["TESTUSDT|15m"][506] = {
    openTime: 506 * 900_000, closeTime: 507 * 900_000 - 1,
    open: entry, high: entry * 1.002, low: entry * 0.998, close: entry * 1.001
  };
  dataset.candlesBySymbolTimeframe["TESTUSDT|15m"][507] = {
    openTime: 507 * 900_000, closeTime: 508 * 900_000 - 1,
    open: entry * 1.001, high: entry * 1.003, low: entry * 0.999, close: entry * 1.002
  };
  const result = await runHistoricalBacktest(dataset, {
    timeframes: ["15m"], initialCapital: 10_000, maxOpenTrades: 5, tradeConfig
  });
  assert.equal(result.scanStats.signalsFound, 1, JSON.stringify({ scanStats: result.scanStats, skipped: result.skipped.map(item => item.reason) }));
  assert.equal(result.accepted.length, 1, JSON.stringify({ accepted: result.accepted, skipped: result.skipped.map(item => item.reason) }));
  assert.equal(result.accepted[0].status, "open");
  assert.equal(result.report.openTrades, 1);
});


test("emits provisional closed/open portfolio counts after each scanned timeframe", async () => {
  const progress = [];
  const result = await runHistoricalBacktest(makeDataset(), {
    timeframes: ["15m"],
    initialCapital: 10_000,
    maxOpenTrades: 5,
    tradeConfig
  }, { onProgress: update => progress.push(update) });

  const portfolioUpdate = progress.find(update => update.phase === "portfolio-progress");
  assert.ok(portfolioUpdate);
  assert.equal(portfolioUpdate.closedTrades, 1);
  assert.equal(portfolioUpdate.openTrades, 0);
  assert.equal(portfolioUpdate.acceptedTrades, 1);
  assert.equal(portfolioUpdate.signalsFound, 1);
  assert.equal(result.report.totalTrades, 1);
});

test("reports progress for a series with insufficient candle history", async () => {
  const dataset = makeDataset();
  dataset.candlesBySymbolTimeframe["TESTUSDT|15m"] = dataset.candlesBySymbolTimeframe["TESTUSDT|15m"].slice(0, 50);
  const progress = [];
  const result = await runHistoricalBacktest(dataset, {
    timeframes: ["15m"],
    initialCapital: 10_000,
    maxOpenTrades: 5,
    tradeConfig
  }, { onProgress: update => progress.push(update) });

  assert.equal(result.scanStats.symbolTimeframeSeries, 1);
  assert.equal(progress.filter(update => update.phase === "series-scan").length, 1);
  assert.equal(progress[0].symbolTimeframeSeries, 1);
  assert.equal(progress[0].totalSeriesCount, 1);
  assert.equal(result.scanStats.totalSeriesCount, 1);
});


test("historical funding filter uses the latest rate settled before the signal close", async () => {
  const high = makeDataset();
  high.fundingBySymbol.TESTUSDT = [{ fundingTime: 90_000_000, rate: 0.0002, markPrice: 100 }];
  const rejected = await runHistoricalBacktest(high, {
    timeframes: ["15m"], initialCapital: 10_000, maxOpenTrades: 5,
    fundingFilterPct: 0.01, tradeConfig
  });
  assert.equal(rejected.scanStats.signalsFound, 0);
  assert.equal(rejected.scanStats.fundingFilteredSignals, 1);
  assert.equal(rejected.scanStats.fundingRateUnavailableSignals, 0);

  const low = makeDataset();
  low.fundingBySymbol.TESTUSDT = [{ fundingTime: 90_000_000, rate: -0.00005, markPrice: 100 }];
  const accepted = await runHistoricalBacktest(low, {
    timeframes: ["15m"], initialCapital: 10_000, maxOpenTrades: 5,
    fundingFilterPct: 0.01, tradeConfig
  });
  assert.equal(accepted.scanStats.signalsFound, 1);
  assert.equal(accepted.scanStats.fundingFilteredSignals, 0);
  assert.equal(accepted.accepted.length, 1);
});

test("historical funding filter does not use a rate settled after the signal", async () => {
  const dataset = makeDataset();
  dataset.fundingBySymbol.TESTUSDT = [
    { fundingTime: 90_000_000, rate: 0.00005, markPrice: 100 },
    { fundingTime: 500_000_000, rate: 0.0005, markPrice: 100 }
  ];
  const result = await runHistoricalBacktest(dataset, {
    timeframes: ["15m"], initialCapital: 10_000, maxOpenTrades: 5,
    fundingFilterPct: 0.01, tradeConfig
  });
  assert.equal(result.scanStats.signalsFound, 1);
  assert.equal(result.scanStats.fundingFilteredSignals, 0);
});

test("historical funding filter rejects a signal when no prior settled rate is available", async () => {
  const dataset = makeDataset();
  dataset.fundingBySymbol.TESTUSDT = [];
  const result = await runHistoricalBacktest(dataset, {
    timeframes: ["15m"], initialCapital: 10_000, maxOpenTrades: 5,
    fundingFilterPct: 0.01, tradeConfig
  });
  assert.equal(result.scanStats.signalsFound, 0);
  assert.equal(result.scanStats.fundingRateUnavailableSignals, 1);
});


test("normalizes missing candle close times before signal-close execution", async () => {
  const dataset = makeDataset();
  for (const candle of dataset.candlesBySymbolTimeframe["TESTUSDT|15m"]) {
    delete candle.closeTime;
  }
  const result = await runHistoricalBacktest(dataset, {
    timeframes: ["15m"],
    initialCapital: 10_000,
    maxOpenTrades: 5,
    tradeConfig: { ...tradeConfig, entryMethod: "signal_close" }
  });
  assert.equal(result.scanStats.signalsFound, 1);
  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0].entryTime, 506 * 900_000 - 1);
  assert.equal(result.accepted[0].exitReason, "take_profit");
});

test("breaks the EMA series when a candle close timestamp does not match its timeframe", async () => {
  const dataset = makeDataset();
  dataset.candlesBySymbolTimeframe["TESTUSDT|15m"][504].closeTime += 1;
  const result = await runHistoricalBacktest(dataset, {
    timeframes: ["15m"],
    initialCapital: 10_000,
    maxOpenTrades: 5,
    tradeConfig
  });
  assert.equal(result.scanStats.missingIntervals, 1);
  assert.equal(result.scanStats.signalsFound, 0);
  assert.equal(result.accepted.length, 0);
});
