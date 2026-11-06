import { analyzeLatestClosedSignal, rankAndDeduplicateSignals, TIMEFRAME_MINUTES } from "./ema-engine.js";

const API_BASE = "https://fapi.binance.com";
export const SUPPORTED_TIMEFRAMES = Object.freeze(Object.keys(TIMEFRAME_MINUTES));

async function getJSON(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    const error = new Error(`Binance API ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
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

export async function getKlines(symbol, interval, limit = 120) {
  if (!SUPPORTED_TIMEFRAMES.includes(interval)) {
    throw new RangeError(`Unsupported Binance timeframe: ${interval}`);
  }
  const query = new URLSearchParams({ symbol, interval, limit: String(limit) });
  return getJSON(`${API_BASE}/fapi/v1/klines?${query.toString()}`);
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
  concurrency = 6,
  onProgress = () => {}
}) {
  const validTimeframes = [...new Set(timeframes)].filter(tf => SUPPORTED_TIMEFRAMES.includes(tf));
  const tasks = symbols.flatMap(symbol =>
    validTimeframes.map(timeframe => ({ symbol, timeframe }))
  );
  let completed = 0;
  let failures = 0;
  const results = await mapWithConcurrency(tasks, concurrency, async task => {
    try {
      const candles = await getKlines(task.symbol.symbol ?? task.symbol, task.timeframe, 120);
      const { signal } = analyzeLatestClosedSignal(candles, {
        timeframe: task.timeframe,
        maxBodyPercent: bodyThresholds[task.timeframe]
      });
      return signal ? {
        ...signal,
        symbol: task.symbol.symbol ?? task.symbol,
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

  const signals = results.filter(item => item && !item.error);
  return {
    long: rankAndDeduplicateSignals(signals.filter(item => item.direction === "LONG")),
    short: rankAndDeduplicateSignals(signals.filter(item => item.direction === "SHORT")),
    scanned: completed,
    total: tasks.length,
    failures
  };
}
