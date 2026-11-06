import { analyzeLatestClosedSignal, analyzeSignalCandle, updateEMAValue, rankAndDeduplicateSignals, TIMEFRAME_MINUTES, EMA_PERIODS, EMA_WARMUP_BARS } from "./ema-engine.js";
import { isFundingRateAllowed } from "./funding-filter.js";

const API_BASE = "https://fapi.binance.com";
export const SUPPORTED_TIMEFRAMES = Object.freeze(Object.keys(TIMEFRAME_MINUTES));

async function getJSON(url, retries = 3) {
  let lastError;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await fetch(url, { headers: { Accept: "application/json" } });
      if (response.ok) return await response.json();
      const error = new Error(`Binance API ${response.status}`);
      error.status = response.status;
      if (response.status !== 429 && response.status < 500) throw error;
      lastError = error;
      if (attempt === retries - 1) throw error;
      const retryAfterSeconds = Number(response.headers?.get?.("Retry-After"));
      const retryDelay = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? retryAfterSeconds * 1000 : 500 * (attempt + 1);
      await new Promise(resolve => setTimeout(resolve, retryDelay));
    } catch (error) {
      if (error.status && error.status !== 429 && error.status < 500) throw error;
      lastError = error;
      if (attempt === retries - 1) throw lastError;
      await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw lastError;
}

/**
 * Public market-data only: active USDⓈ-M USDT perpetual contracts,
 * filtered by 24h change, then ranked by quote turnover.
 */
export async function getTop100UsdtPerpetual() {
  const [exchangeInfo, tickers] = await Promise.all([
    getJSON(`${API_BASE}/fapi/v1/exchangeInfo`),
    getJSON(`${API_BASE}/fapi/v1/ticker/24hr`)
  ]);

  const tickerBySymbol = new Map(tickers.map(item => [item.symbol, item]));
  return exchangeInfo.symbols
    .filter(item =>
      item.status === "TRADING"
      && item.contractType === "PERPETUAL"
      && item.quoteAsset === "USDT"
      && item.symbol.endsWith("USDT")
      && (!item.contractStatus || item.contractStatus === "TRADING")
    )
    .map(item => {
      const ticker = tickerBySymbol.get(item.symbol);
      if (!ticker) return null;
      const change = Number(ticker.priceChangePercent);
      const quoteVolume = Number(ticker.quoteVolume);
      if (!Number.isFinite(change) || !Number.isFinite(quoteVolume)) return null;
      if (change > 30 || change < -30) return null;
      return {
        symbol: item.symbol,
        quoteVolume,
        priceChangePercent: change
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.quoteVolume - a.quoteVolume)
    .slice(0, 100);
}

export async function getFundingRateMap(symbols) {
  const rows = await getJSON(`${API_BASE}/fapi/v1/premiumIndex`);
  const wanted = new Set(symbols.map(item => item.symbol ?? item));
  return new Map((Array.isArray(rows) ? rows : [rows])
    .filter(row => wanted.has(row.symbol))
    .map(row => [row.symbol,
      row.lastFundingRate === null || row.lastFundingRate === undefined || row.lastFundingRate === ""
        ? null
        : (Number.isFinite(Number(row.lastFundingRate)) ? Number(row.lastFundingRate) : null)
    ]));
}

export async function getKlines(symbol, interval, limit = EMA_WARMUP_BARS + 2, startTime = null) {
  if (!SUPPORTED_TIMEFRAMES.includes(interval)) {
    throw new RangeError(`Unsupported Binance timeframe: ${interval}`);
  }
  const query = new URLSearchParams({ symbol, interval, limit: String(limit) });
  if (Number.isFinite(startTime)) query.set("startTime", String(startTime));
  return getJSON(`${API_BASE}/fapi/v1/klines?${query.toString()}`);
}

const liveEmaCache = new Map();

function normalizeLiveCandle(raw) {
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

function validLiveCandle(candle, intervalMs) {
  return [candle.openTime, candle.closeTime, candle.open, candle.high, candle.low, candle.close].every(Number.isFinite)
    && candle.closeTime === candle.openTime + intervalMs - 1
    && candle.open > 0 && candle.low > 0
    && candle.high >= Math.max(candle.open, candle.close)
    && candle.low <= Math.min(candle.open, candle.close);
}

async function fetchWarmupKlines(symbol, timeframe) {
  const intervalMs = TIMEFRAME_MINUTES[timeframe] * 60_000;
  // Binance charges lower request weight below a LIMIT of 500.
  // Fetch 499 recent bars plus the 3 immediately preceding bars.
  const recent = await getKlines(symbol, timeframe, EMA_WARMUP_BARS - 1);
  if (!Array.isArray(recent) || recent.length === 0) return recent;
  const firstOpenTime = normalizeLiveCandle(recent[0]).openTime;
  if (!Number.isFinite(firstOpenTime)) return recent;
  const earlier = await getKlines(
    symbol, timeframe, 3, firstOpenTime - 3 * intervalMs
  );
  return Array.isArray(earlier) ? [...earlier, ...recent] : recent;
}

async function getLatestLiveSignal(symbol, timeframe, maxBodyPercent) {
  const key = symbol + "|" + timeframe;
  const intervalMs = TIMEFRAME_MINUTES[timeframe] * 60_000;
  const currentOpenTime = Math.floor(Date.now() / intervalMs) * intervalMs;
  const cached = liveEmaCache.get(key);

  if (cached && Number.isFinite(cached.lastClosedOpenTime)
      && cached.lastClosedCandle
      && EMA_PERIODS.every(period => Number.isFinite(cached.emaValues?.[period]))) {
    const nextOpenTime = cached.lastClosedOpenTime + intervalMs;
    const elapsedBars = Math.max(2, Math.ceil((Date.now() - cached.lastClosedOpenTime) / intervalMs) + 1);
    const requestLimit = Math.min(1500, elapsedBars);
    const rows = await getKlines(symbol, timeframe, requestLimit, nextOpenTime);
    if (Array.isArray(rows) && rows.length > 0 && rows.length < 1500) {
      const normalized = rows.map(normalizeLiveCandle);
      let previousOpenTime = cached.lastClosedOpenTime;
      const contiguous = normalized.every(candle => {
        const valid = validLiveCandle(candle, intervalMs)
          && candle.openTime - previousOpenTime === intervalMs;
        previousOpenTime = candle.openTime;
        return valid;
      });
      if (contiguous && normalized[0].openTime === nextOpenTime
          && normalized[normalized.length - 1].openTime === currentOpenTime) {
        const newClosedCandles = normalized.slice(0, -1);
        const emaValues = { ...cached.emaValues };
        for (const candle of newClosedCandles) {
          for (const period of EMA_PERIODS) {
            emaValues[period] = updateEMAValue(emaValues[period], candle.close, period);
          }
        }
        const signalCandle = newClosedCandles.at(-1) ?? cached.lastClosedCandle;
        const formingCandle = normalized.at(-1);
        const analysis = analyzeSignalCandle(signalCandle, emaValues, {
          timeframe, maxBodyPercent, expiresAt: formingCandle.closeTime
        });
        if (newClosedCandles.length) {
          liveEmaCache.set(key, {
            lastClosedOpenTime: signalCandle.openTime,
            lastClosedCandle: signalCandle,
            emaValues
          });
        }
        return analysis.signal;
      }
    }
  }

  // First scan, stale cache, or a detected gap: rebuild from a clean 500-bar window.
  const candles = await fetchWarmupKlines(symbol, timeframe);
  const analysis = analyzeLatestClosedSignal(candles, { timeframe, maxBodyPercent });
  if (analysis.emaValues && Array.isArray(candles) && candles.length >= EMA_WARMUP_BARS + 2) {
    const normalized = candles.slice(-(EMA_WARMUP_BARS + 2)).map(normalizeLiveCandle);
    const lastClosedCandle = normalized.at(-2);
    const formingCandle = normalized.at(-1);
    if (validLiveCandle(lastClosedCandle, intervalMs)
        && validLiveCandle(formingCandle, intervalMs)
        && formingCandle.openTime === currentOpenTime) {
      liveEmaCache.set(key, {
        lastClosedOpenTime: lastClosedCandle.openTime,
        lastClosedCandle,
        emaValues: analysis.emaValues
      });
      return analysis.signal;
    }
  }
  liveEmaCache.delete(key);
  return null;
}

async function mapWithConcurrency(items, concurrency, worker) {
  const output = new Array(items.length);
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      try {
        output[index] = await worker(items[index], index);
      } catch (error) {
        output[index] = { error };
      }
    }
  });
  await Promise.all(runners);
  return output;
}

/**
 * Scan selected timeframes using only public klines.
 * Each symbol is later reduced to its shortest qualifying timeframe.
 */
export async function scanMarket({
  symbols,
  timeframes,
  bodyThresholds = {},
  fundingFilterPct = 0,
  concurrency = 6,
  onProgress = () => {}
}) {
  const validTimeframes = [...new Set(timeframes)].filter(tf => SUPPORTED_TIMEFRAMES.includes(tf));
  const thresholdPct = Number(fundingFilterPct ?? 0);
  if (!Number.isFinite(thresholdPct) || thresholdPct < 0) {
    throw new RangeError("fundingFilterPct must be a non-negative percentage");
  }
  const fundingRates = thresholdPct > 0 ? await getFundingRateMap(symbols) : new Map();
  const tasks = symbols.flatMap(symbol =>
    validTimeframes.map(timeframe => ({ symbol, timeframe }))
  );
  let completed = 0;
  let failures = 0;
  let fundingFiltered = 0;
  let fundingUnavailable = 0;
  const effectiveConcurrency = validTimeframes.length >= 8 ? Math.min(concurrency, 2) : concurrency;
  const results = await mapWithConcurrency(tasks, effectiveConcurrency, async task => {
    try {
      const symbol = task.symbol.symbol ?? task.symbol;
      if (thresholdPct > 0) {
        const rate = fundingRates.get(symbol);
        if (rate === undefined || rate === null || !Number.isFinite(rate)) {
          fundingUnavailable++;
          return null;
        }
        if (!isFundingRateAllowed(rate, thresholdPct)) {
          fundingFiltered++;
          return null;
        }
      }
      const signal = await getLatestLiveSignal(
        symbol, task.timeframe, bodyThresholds[task.timeframe]
      );
      return signal ? {
        ...signal,
        symbol,
        fundingRate: thresholdPct > 0 ? fundingRates.get(symbol) : null,
        fundingRatePct: thresholdPct > 0 ? fundingRates.get(symbol) * 100 : null,
        quoteVolume: task.symbol.quoteVolume ?? null,
        priceChangePercent: task.symbol.priceChangePercent ?? null
      } : null;
    } catch (error) {
      failures += 1;
      return { error };
    } finally {
      completed += 1;
      onProgress({ completed, total: tasks.length, failures });
    }
  });

  const signals = rankAndDeduplicateSignals(results.filter(item => item && !item.error));
  return {
    long: signals.filter(item => item.direction === "LONG"),
    short: signals.filter(item => item.direction === "SHORT"),
    scanned: completed,
    total: tasks.length,
    failures,
    fundingFiltered,
    fundingUnavailable
  };
}
