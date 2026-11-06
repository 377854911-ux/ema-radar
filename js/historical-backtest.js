import { calculateEMA, TIMEFRAME_MINUTES } from "./ema-engine.js";
import { simulatePortfolio } from "./portfolio-engine.js";
import { isFundingRateAllowed, latestKnownFundingRate } from "./funding-filter.js";

export const BACKTEST_PERIOD_DAYS = Object.freeze([7, 30, 60]);
const DAY_MS = 86_400_000;

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

function readCandle(raw) {
  if (Array.isArray(raw)) {
    return {
      openTime: Number(raw[0]), open: Number(raw[1]), high: Number(raw[2]),
      low: Number(raw[3]), close: Number(raw[4]), closeTime: Number(raw[6])
    };
  }
  return {
    openTime: Number(raw?.openTime), open: Number(raw?.open),
    high: Number(raw?.high), low: Number(raw?.low),
    close: Number(raw?.close), closeTime: Number(raw?.closeTime)
  };
}

function validCandle(c) {
  return [c.open, c.high, c.low, c.close].every(Number.isFinite)
    && c.open > 0 && c.low > 0
    && c.high >= Math.max(c.open, c.close)
    && c.low <= Math.min(c.open, c.close);
}

function splitContiguousCandles(rawCandles, timeframe) {
  const intervalMs = TIMEFRAME_MINUTES[timeframe] * 60_000;
  const segments = [];
  let start = 0;
  let missingIntervals = 0;
  for (let i = 1; i < rawCandles.length; i++) {
    const previous = readCandle(rawCandles[i - 1]);
    const current = readCandle(rawCandles[i]);
    if (current.openTime - previous.openTime !== intervalMs) {
      segments.push(rawCandles.slice(start, i));
      start = i;
      missingIntervals++;
    }
  }
  if (rawCandles.length) segments.push(rawCandles.slice(start));
  return { segments, missingIntervals };
}

/**
 * Calculate each EMA series once, then inspect candles in linear time.
 * Values at index i only depend on closes up to i, so no future data leaks in.
 */
function findSignalsForSeries({
  symbol, timeframe, rawCandles, dataset, settings, tradeConfig, onSignal,
  fundingFilterPct = 0, onFundingFilter = () => {}
}) {
  const candles = rawCandles.map(readCandle);
  if (candles.length < 102) return [];
  const closes = candles.map(c => c.close);
  const ema25 = calculateEMA(closes, 25);
  const ema50 = calculateEMA(closes, 50);
  const ema100 = calculateEMA(closes, 100);
  const signals = [];
  const maxBodyPercent = settings.maxBodyPercent;

  for (let i = 100; i < candles.length - 1; i++) {
    const signalCandle = candles[i];
    const nextCandle = candles[i + 1];
    const timestamp = signalCandle.openTime;
    if (!Number.isFinite(timestamp)
        || timestamp < dataset.startTime || timestamp >= dataset.endTime) continue;

    // A day's eligible universe is known only after the preceding UTC day closes.
    const universeDay = dayStart(timestamp) - DAY_MS;
    const dailyRows = dataset.dailyUniverse[String(universeDay)] ?? dataset.dailyUniverse[universeDay] ?? [];
    if (!dailyRows.some(row => row.symbol === symbol)) continue;
    if (!validCandle(signalCandle) || !validCandle(nextCandle)) continue;

    const values = [ema25[i], ema50[i], ema100[i]];
    if (!values.every(Number.isFinite)) continue;
    const bodyPercent = Math.abs(signalCandle.close - signalCandle.open)
      / signalCandle.open * 100;
    if (maxBodyPercent !== null && maxBodyPercent !== undefined) {
      const threshold = Number(maxBodyPercent);
      if (!Number.isFinite(threshold) || threshold <= 0 || bodyPercent >= threshold) continue;
    }

    const bullish = signalCandle.close > signalCandle.open;
    const bearish = signalCandle.close < signalCandle.open;
    const allInsideBullBody = bullish
      && values.every(value => value > signalCandle.open && value < signalCandle.close);
    const allInsideBearBody = bearish
      && values.every(value => value < signalCandle.open && value > signalCandle.close);
    let direction = null;
    if (allInsideBullBody && ema100[i] < ema25[i] && ema100[i] < ema50[i]) {
      direction = "LONG";
    } else if (allInsideBearBody && ema100[i] > ema25[i] && ema100[i] > ema50[i]) {
      direction = "SHORT";
    }
    if (!direction) continue;

    let fundingRateAtSignal = null;
    if (fundingFilterPct > 0) {
      const knownFunding = latestKnownFundingRate(
        dataset.fundingBySymbol?.[symbol] ?? [],
        Number(signalCandle.closeTime ?? (signalCandle.openTime + TIMEFRAME_MINUTES[timeframe] * 60_000 - 1))
      );
      if (!knownFunding) {
        onFundingFilter("unavailable");
        continue;
      }
      fundingRateAtSignal = knownFunding.rate;
      if (!isFundingRateAllowed(fundingRateAtSignal, fundingFilterPct)) {
        onFundingFilter("filtered");
        continue;
      }
    }

    const distanceRate = (Math.max(...values) - Math.min(...values))
      / signalCandle.close * 100;
    const signal = {
      symbol,
      timeframe,
      direction,
      distanceRate,
      fundingRateAtSignal,
      candles: rawCandles,
      signalIndex: i,
      config: tradeConfig
    };
    signals.push(signal);
    onSignal?.({ symbol, timeframe, direction, signalTime: timestamp, signalIndex: i });
  }
  return signals;
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
  return {
    ...config.tradeConfig,
    ...override.tradeConfig,
    maxBodyPercent
  };
}

/**
 * Runs the historical EMA signal scan and hands fresh candidates to the
 * portfolio simulator. A signal is considered only when its following candle
 * exists; the signal candle itself must already be closed.
 */
export async function runHistoricalBacktest(dataset, config = {}, options = {}) {
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

  const fundingFilterPct = Number(config.fundingFilterPct ?? 0);
  if (!Number.isFinite(fundingFilterPct) || fundingFilterPct < 0) {
    throw new RangeError("fundingFilterPct must be a non-negative percentage");
  }
  const selectedTimeframes = [...new Set(config.timeframes ?? dataset.timeframes ?? [])];
  if (!selectedTimeframes.length) throw new TypeError("Select at least one timeframe");
  for (const timeframe of selectedTimeframes) {
    if (!Object.hasOwn(TIMEFRAME_MINUTES, timeframe)) {
      throw new RangeError(`Unsupported timeframe: ${timeframe}`);
    }
  }
  const candidates = [];
  const scanStats = {
    symbolTimeframeSeries: 0,
    candlesEvaluated: 0,
    signalsFound: 0,
    fundingFilteredSignals: 0,
    fundingRateUnavailableSignals: 0,
    missingIntervals: 0,
    missingSeries: []
  };
  const seriesEntries = Object.entries(dataset.candlesBySymbolTimeframe);
  const totalSeriesCount = seriesEntries.filter(([key]) =>
    selectedTimeframes.includes(key.slice(key.lastIndexOf("|") + 1))
  ).length;
  scanStats.totalSeriesCount = totalSeriesCount;

  for (const timeframe of selectedTimeframes) {
    const settings = timeframeConfig(config, timeframe);
    let timeframeSignals = 0;
    for (const [key, candles] of seriesEntries) {
      const separator = key.lastIndexOf("|");
      const symbol = key.slice(0, separator);
      const seriesTimeframe = key.slice(separator + 1);
      if (seriesTimeframe !== timeframe) continue;
      scanStats.symbolTimeframeSeries++;
      if (!Array.isArray(candles) || candles.length < 102) {
        scanStats.missingSeries.push({ symbol, timeframe, reason: "insufficient_candles" });
        options.onProgress?.({
          phase: "series-scan",
          timeframe,
          ...scanStats,
          totalSeries: seriesEntries.filter(([seriesKey]) => seriesKey.endsWith("|" + timeframe)).length,
          totalSeriesCount
        });
        await new Promise(resolve => setTimeout(resolve, 0));
        continue;
      }
      const { maxBodyPercent: _maxBodyPercent, ...tradeOverrides } = settings;
      const tradeConfig = { ...config.tradeConfig, ...tradeOverrides };
      const split = splitContiguousCandles(candles, timeframe);
      scanStats.missingIntervals += split.missingIntervals;
      for (const segment of split.segments) {
        if (segment.length < 102) {
          if (segment.length) scanStats.missingSeries.push({
            symbol, timeframe, reason: "contiguous_segment_too_short_after_data_gap"
          });
          continue;
        }
        const found = findSignalsForSeries({
          symbol, timeframe, rawCandles: segment, dataset, settings, tradeConfig,
          onSignal: options.onSignal,
          fundingFilterPct,
          onFundingFilter: reason => {
            if (reason === "filtered") scanStats.fundingFilteredSignals++;
            else if (reason === "unavailable") scanStats.fundingRateUnavailableSignals++;
          }
        });
        candidates.push(...found);
        timeframeSignals += found.length;
        scanStats.candlesEvaluated += Math.max(0, segment.length - 101);
      }
      options.onProgress?.({
        phase: "series-scan",
        timeframe,
        ...scanStats,
        totalSeries: seriesEntries.filter(([seriesKey]) => seriesKey.endsWith("|" + timeframe)).length,
        totalSeriesCount
      });
      // Yield between symbol/timeframe series so mobile browsers can paint live counters.
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    scanStats.signalsFound += timeframeSignals;
    // Counts are provisional until all selected timeframes have been scanned.
    const partialPortfolio = simulatePortfolio(candidates, { initialCapital, maxOpenTrades });
    options.onProgress?.({
      phase: "portfolio-progress",
      timeframe,
      completedTimeframes: selectedTimeframes.indexOf(timeframe) + 1,
      totalTimeframes: selectedTimeframes.length,
      closedTrades: partialPortfolio.accepted.filter(item => item.status === "closed").length,
      openTrades: partialPortfolio.accepted.filter(item => item.status === "open").length,
      acceptedTrades: partialPortfolio.accepted.length,
      totalSeriesCount,
      ...scanStats
    });
    options.onProgress?.({
      phase: "signal-scan",
      timeframe,
      completedTimeframes: selectedTimeframes.indexOf(timeframe) + 1,
      totalTimeframes: selectedTimeframes.length,
      totalSeriesCount,
      ...scanStats
    });
  }

  const fundingBySymbol = dataset.fundingBySymbol ?? {};
  for (const candidate of candidates) {
    candidate.fundingEvents = fundingBySymbol[candidate.symbol] ?? [];
  }
  const portfolio = simulatePortfolio(candidates, { initialCapital, maxOpenTrades });
  const incompleteOrUnclassifiable = [
    ...portfolio.accepted.filter(trade =>
      trade.status === "incomplete" || trade.status === "unclassifiable"
    ),
    ...portfolio.skipped.filter(item => item.trade?.status === "unclassifiable")
      .map(item => item.trade)
  ];

  return {
    period: {
      startTime: dataset.startTime,
      endTime: dataset.endTime,
      days: Math.round((dataset.endTime - dataset.startTime) / DAY_MS)
    },
    selectedTimeframes,
    scanStats,
    datasetStats: {
      symbolsChecked: dataset.symbolsCheckedForDailyUniverse ?? null,
      symbolsIncluded: dataset.symbolsIncluded?.length
        ?? new Set(Object.keys(dataset.candlesBySymbolTimeframe).map(key => key.slice(0, key.lastIndexOf("|")))).size,
      dailyUniverseDays: Object.keys(dataset.dailyUniverse).length,
      candleSeries: Object.keys(dataset.candlesBySymbolTimeframe).length
    },
    ...portfolio,
    report: {
      openTrades: portfolio.accepted.filter(trade => trade.status === "open").length,
      totalReturnPct: portfolio.summary.totalReturnPct,
      totalProfit: portfolio.summary.totalProfit,
      totalLoss: portfolio.summary.totalLoss,
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
