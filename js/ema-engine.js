/**
 * EMA Radar V1 signal engine.
 * Pure calculation module: no network, storage, wallet, or order APIs.
 */

export const EMA_PERIODS = Object.freeze([25, 50, 100]);

export const TIMEFRAME_MINUTES = Object.freeze({
  "15m": 15, "30m": 30,
  "1h": 60, "2h": 120, "4h": 240,
  "6h": 360, "8h": 480, "12h": 720, "1d": 1440
});

/**
 * Calculate an EMA using the standard SMA seed, then recursive smoothing.
 * Returns an array aligned with input values; unavailable warm-up slots are null.
 */
export function calculateEMA(values, period) {
  if (!Number.isInteger(period) || period < 1) {
    throw new RangeError("EMA period must be a positive integer.");
  }
  const result = Array(values.length).fill(null);
  if (values.length < period) return result;

  let seedSum = 0;
  for (let i = 0; i < period; i += 1) {
    const value = Number(values[i]);
    if (!Number.isFinite(value)) return result;
    seedSum += value;
  }

  let previous = seedSum / period;
  result[period - 1] = previous;
  const alpha = 2 / (period + 1);

  for (let i = period; i < values.length; i += 1) {
    const value = Number(values[i]);
    if (!Number.isFinite(value)) {
      previous = NaN;
      result[i] = null;
      continue;
    }
    if (!Number.isFinite(previous)) {
      result[i] = null;
      continue;
    }
    previous = value * alpha + previous * (1 - alpha);
    result[i] = previous;
  }
  return result;
}

function normalizeCandle(raw) {
  if (Array.isArray(raw)) {
    return {
      openTime: Number(raw[0]),
      open: Number(raw[1]),
      high: Number(raw[2]),
      low: Number(raw[3]),
      close: Number(raw[4]),
      closeTime: Number(raw[6])
    };
  }
  return {
    openTime: Number(raw?.openTime),
    open: Number(raw?.open),
    high: Number(raw?.high),
    low: Number(raw?.low),
    close: Number(raw?.close),
    closeTime: Number(raw?.closeTime)
  };
}

function isValidCandle(candle) {
  return [candle.open, candle.high, candle.low, candle.close].every(Number.isFinite)
    && candle.open > 0
    && candle.high >= Math.max(candle.open, candle.close)
    && candle.low <= Math.min(candle.open, candle.close)
    && candle.low > 0;
}

/**
 * Evaluate only the latest completed candle.
 * The final candle in the input MUST be the currently forming candle.
 * This makes an old signal expire automatically once its following candle closes.
 */
export function analyzeLatestClosedSignal(rawCandles, options = {}) {
  const { timeframe = null, maxBodyPercent = null } = options;
  if (!Array.isArray(rawCandles) || rawCandles.length < 101) {
    return { signal: null, reason: "not_enough_candles" };
  }

  const candles = rawCandles.map(normalizeCandle);
  const forming = candles[candles.length - 1];
  const signalIndex = candles.length - 2;
  const signalCandle = candles[signalIndex];

  if (!isValidCandle(forming) || !isValidCandle(signalCandle)) {
    return { signal: null, reason: "invalid_latest_candle" };
  }

  const closedCandles = candles.slice(0, -1);
  const closes = closedCandles.map(candle => candle.close);
  const emaValues = Object.fromEntries(
    EMA_PERIODS.map(period => [period, calculateEMA(closes, period)[signalIndex]])
  );

  if (EMA_PERIODS.some(period => !Number.isFinite(emaValues[period]))) {
    return { signal: null, reason: "ema_warmup_incomplete" };
  }

  const bodyPercent = Math.abs(signalCandle.close - signalCandle.open)
    / signalCandle.open * 100;

  if (maxBodyPercent !== null && maxBodyPercent !== undefined) {
    const threshold = Number(maxBodyPercent);
    if (!Number.isFinite(threshold) || threshold <= 0) {
      return { signal: null, reason: "invalid_body_threshold" };
    }
    if (bodyPercent >= threshold) {
      return { signal: null, reason: "body_threshold_exceeded" };
    }
  }

  const values = EMA_PERIODS.map(period => emaValues[period]);
  const allInsideBullBody = signalCandle.close > signalCandle.open
    && values.every(value => value > signalCandle.open && value < signalCandle.close);
  const allInsideBearBody = signalCandle.close < signalCandle.open
    && values.every(value => value < signalCandle.open && value > signalCandle.close);

  let direction = null;
  if (allInsideBullBody && emaValues[100] < emaValues[25] && emaValues[100] < emaValues[50]) {
    direction = "LONG";
  } else if (allInsideBearBody && emaValues[100] > emaValues[25] && emaValues[100] > emaValues[50]) {
    direction = "SHORT";
  }

  if (!direction) return { signal: null, reason: "conditions_not_met" };

  const emaMin = Math.min(...values);
  const emaMax = Math.max(...values);
  const distanceRate = (emaMax - emaMin) / signalCandle.close * 100;

  return {
    signal: {
      direction,
      timeframe,
      candleOpenTime: signalCandle.openTime,
      candleCloseTime: signalCandle.closeTime,
      closePrice: signalCandle.close,
      bodyPercent,
      ema25: emaValues[25],
      ema50: emaValues[50],
      ema100: emaValues[100],
      distanceRate,
      // This is the next candle, during which the just-closed signal may be acted on.
      expiresAt: forming.closeTime
    },
    reason: null
  };
}

/**
 * Sort fresh signals by EMA distance (ascending), then prefer the shorter timeframe.
 * When the same symbol qualifies on multiple timeframes, retain only the shortest.
 */
export function rankAndDeduplicateSignals(signals) {
  // For each symbol, first choose its shortest qualifying timeframe,
  // even when the EMA-distance scores differ. Then rank those candidates.
  const shortestBySymbol = new Map();
  for (const signal of signals.filter(Boolean)) {
    const current = shortestBySymbol.get(signal.symbol);
    const candidateMinutes = TIMEFRAME_MINUTES[signal.timeframe] ?? Infinity;
    const currentMinutes = current ? (TIMEFRAME_MINUTES[current.timeframe] ?? Infinity) : Infinity;
    if (!current || candidateMinutes < currentMinutes) {
      shortestBySymbol.set(signal.symbol, signal);
    } else if (candidateMinutes === currentMinutes
      && signal.distanceRate < current.distanceRate) {
      shortestBySymbol.set(signal.symbol, signal);
    }
  }

  return [...shortestBySymbol.values()].sort((a, b) =>
    a.distanceRate - b.distanceRate
  );
}
