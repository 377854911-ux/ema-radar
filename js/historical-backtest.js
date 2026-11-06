import { analyzeLatestClosedSignal } from "./ema-engine.js";
import { simulatePortfolio } from "./portfolio-engine.js";

export const BACKTEST_PERIOD_DAYS = Object.freeze([7, 30, 60]);
const DAY_MS = 86_400_000;

/**
 * Convert a selected rolling period into a UTC-aligned range.
 * endTime is exclusive; callers should normally pass the latest completed UTC day.
 */
export function createBacktestRange(days, endTime = Date.now()) {
  if (!BACKTEST_PERIOD_DAYS.includes(days)) {
    throw new RangeError("Backtest period must be 7, 30, or 60 days");
  }
  if (!Number.isFinite(endTime) || endTime <= 0) {
    throw new RangeError("endTime must be a positive timestamp");
  }
  const end = Math.floor(endTime / DAY_MS) * DAY_MS;
  return { startTime: end - days * DAY_MS, endTime: end };
}

function dayStart(timestamp) {
  return Math.floor(timestamp / DAY_MS) * DAY_MS;
}

function validateDataset(dataset) {
  if (!dataset || typeof dataset !== "object") throw new TypeError("dataset is required");
  if (!Number.isFinite(dataset.startTime) || !Number.isFinite(dataset.endTime)
      || dataset.endTime <= dataset.startTime) {
    throw new RangeError("dataset must include a valid startTime/endTime range");
  }
  if (!dataset.dailyUniverse || !dataset.candlesBySymbolTimeframe) {
    throw new TypeError("dataset is missing historical universe or candle data");
  }
}

function timeframeConfig(config, timeframe) {
  const override = config.timeframeSettings?.[timeframe] ?? {};
  const maxBodyPercent = override.maxBodyPercent
    ?? config.maxBodyPercentByTimeframe?.[timeframe]
    ?? null;
  return { ...config.tradeConfig, ...override.tradeConfig, maxBodyPercent };
}

/**
 * Runs the historical EMA signal scan and hands fresh candidates to the
 * portfolio simulator. The final candle in each scan slice is treated as
 * the next candle after the signal, so only a newly closed signal candle
 * can qualify; old signals are never carried forward.
 *
 * Dataset format is the output of fetchBacktestDataset().
 */
export function runHistoricalBacktest(dataset, config = {}, options = {}) {
  validateDataset(dataset);
  const initialCapital = Number(config.initialCapital ?? 10_000);
  const maxOpenTrades = Number(config.maxOpenTrades ?? 5);
  if (!Number.isFinite(initialCapital) || initialCapital <= 0) {
    throw new RangeError("initialCapital must be positive");
  }
  if (!Number.isInteger(maxOpenTrades) || maxOpenTrades < 1) {
    throw new RangeError("maxOpenTrades must be a positive integer");
  }
  if (!config.tradeConfig || typeof config.tradeConfig !== "object") {
    throw new TypeError("tradeConfig is required");
  }

  const selectedTimeframes = [...new Set(config.timeframes ?? dataset.timeframes ?? [])];
  if (!selectedTimeframes.length) throw new TypeError("Select at least one timeframe");
  const candidates = [];
  const scanStats = {
    symbolTimeframeSeries: 0,
    candlesEvaluated: 0,
    eligibleUniverseCandles: 0,
    signalsFound: 0,
    missingSeries: []
  };
  const seriesEntries = Object.entries(dataset.candlesBySymbolTimeframe);

  for (const timeframe of selectedTimeframes) {
    const settings = timeframeConfig(config, timeframe);
    for (const [key, candles] of seriesEntries) {
      const separator = key.lastIndexOf("|");
      const symbol = key.slice(0, separator);
      const seriesTimeframe = key.slice(separator + 1);
      if (seriesTimeframe !== timeframe) continue;
      scanStats.symbolTimeframeSeries++;
      if (!Array.isArray(candles) || candles.length < 102) continue;

      // Index 0..99 is EMA warm-up. The last item in each slice is the
      // following candle, which prevents an unclosed candle from confirming.
      for (let signalIndex = 100; signalIndex < candles.length - 1; signalIndex++) {
        const signalCandle = candles[signalIndex];
        const timestamp = Number(signalCandle.openTime);
        if (!Number.isFinite(timestamp)
            || timestamp < dataset.startTime || timestamp >= dataset.endTime) continue;

        const day = dayStart(timestamp);
        const dailyRows = dataset.dailyUniverse[String(day)] ?? dataset.dailyUniverse[day] ?? [];
        if (!dailyRows.some(row => row.symbol === symbol)) continue;
        scanStats.eligibleUniverseCandles++;
        scanStats.candlesEvaluated++;

        const result = analyzeLatestClosedSignal(candles.slice(0, signalIndex + 2), {
          timeframe,
          maxBodyPercent: settings.maxBodyPercent
        });
        if (!result.signal) continue;

        const fundingEvents = dataset.fundingBySymbol?.[symbol] ?? [];
        candidates.push({
          symbol,
          timeframe,
          direction: result.signal.direction,
          distanceRate: result.signal.distanceRate,
          candles,
          signalIndex,
          config: { ...config.tradeConfig, ...settings.tradeConfig },
          fundingEvents
        });
        scanStats.signalsFound++;
      }
    }
    options.onProgress?.({
      phase: "signal-scan",
      timeframe,
      completedTimeframes: selectedTimeframes.indexOf(timeframe) + 1,
      totalTimeframes: selectedTimeframes.length,
      ...scanStats
    });
  }

  const portfolio = simulatePortfolio(candidates, {
    initialCapital,
    maxOpenTrades
  });
  const incompleteOrUnclassifiable = [
    ...portfolio.accepted.filter(trade =>
      trade.status === "incomplete" || trade.status === "unclassifiable"
    ),
    ...portfolio.skipped.filter(item => item.trade?.status === "unclassifiable").map(item => item.trade)
  ];

  return {
    period: {
      startTime: dataset.startTime,
      endTime: dataset.endTime,
      days: Math.round((dataset.endTime - dataset.startTime) / DAY_MS)
    },
    selectedTimeframes,
    scanStats,
    ...portfolio,
    report: {
      totalReturnPct: portfolio.summary.totalReturnPct,
      netProfit: portfolio.summary.netProfit,
      winRatePct: portfolio.summary.winRatePct,
      riskRewardRatio: portfolio.summary.riskRewardRatio,
      maxDrawdownPct: portfolio.summary.maxDrawdownPct,
      totalTrades: portfolio.summary.totalTrades,
      takeProfitCount: portfolio.summary.takeProfitCount,
      stopLossCount: portfolio.summary.stopLossCount,
      timeoutCloseCount: portfolio.summary.timeoutCloseCount,
      totalCapitalReplenished: portfolio.summary.totalCapitalReplenished,
      incompleteTrades: incompleteOrUnclassifiable.length
    },
    dataLimitations: dataset.limitations ?? []
  };
}
