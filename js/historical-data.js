/**
 * Historical Binance USDⓈ-M public-data loader.
 *
 * Daily universe reconstruction uses UTC 1d klines:
 * - quote asset volume (kline field 7) as daily turnover
 * - daily open-to-close return as a documented proxy for the historical
 *   24-hour price-change filter
 *
 * Binance's public 24hr ticker endpoint is not historical. The current
 * exchangeInfo endpoint also cannot recover delisted contracts or historical
 * Monitoring labels. Callers must surface these limitations in reports.
 */

const API = "https://fapi.binance.com";
const DAY = 86_400_000;
const MAX_KLINES = 1500;
export const EMA_WARMUP_BARS = 500;

async function requestJSON(url, fetchImpl = fetch) {
  const response = await fetchImpl(url, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    const error = new Error(`Binance API ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

export function normalizeKline(row) {
  if (!Array.isArray(row) || row.length < 8) throw new TypeError("Invalid Binance kline row");
  const candle = {
    openTime: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
    closeTime: Number(row[6]),
    quoteVolume: Number(row[7])
  };
  if (![candle.openTime, candle.closeTime, candle.open, candle.high, candle.low,
    candle.close, candle.volume, candle.quoteVolume].every(Number.isFinite)
    || candle.open <= 0 || candle.close <= 0 || candle.quoteVolume < 0) {
    throw new RangeError("Invalid numeric values in Binance kline");
  }
  return candle;
}

export function buildDailyUniverse(dailyCandlesBySymbol, { startTime, endTime, limit = 100 } = {}) {
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) {
    throw new RangeError("A valid startTime/endTime range is required");
  }
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("limit must be a positive integer");
  const byDay = new Map();
  for (const [symbol, candles] of Object.entries(dailyCandlesBySymbol || {})) {
    for (const candle of candles || []) {
      const day = candle.openTime;
      if (day < startTime || day >= endTime) continue;
      if (!(candle.quoteVolume >= 0) || !(candle.open > 0) || !(candle.close > 0)) continue;
      const changePct = (candle.close - candle.open) / candle.open * 100;
      if (changePct > 30 || changePct < -30) continue;
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push({
        symbol,
        dayOpenTime: day,
        quoteVolume: candle.quoteVolume,
        dailyChangePercentProxy: changePct
      });
    }
  }
  const result = {};
  for (const [day, rows] of byDay) {
    result[day] = rows.sort((a, b) => b.quoteVolume - a.quoteVolume || a.symbol.localeCompare(b.symbol)).slice(0, limit);
  }
  return result;
}

export function createHistoricalCache(indexedDBImpl = globalThis.indexedDB) {
  const DB_NAME = "ema-radar-historical-v1";
  const STORE = "candles";
  let dbPromise;
  async function db() {
    if (!indexedDBImpl) return null;
    if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
      const open = indexedDBImpl.open(DB_NAME, 1);
      open.onupgradeneeded = () => {
        const database = open.result;
        if (!database.objectStoreNames.contains(STORE)) {
          const store = database.createObjectStore(STORE, { keyPath: "key" });
          store.createIndex("symbolInterval", "symbolInterval", { unique: false });
        }
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    return dbPromise;
  }
  return {
    async get(key) {
      const database = await db();
      if (!database) return null;
      return new Promise((resolve, reject) => {
        const request = database.transaction(STORE, "readonly").objectStore(STORE).get(key);
        request.onsuccess = () => resolve(request.result?.value ?? null);
        request.onerror = () => reject(request.error);
      });
    },
    async put(key, value, symbolInterval = "") {
      const database = await db();
      if (!database) return false;
      return new Promise((resolve, reject) => {
        const request = database.transaction(STORE, "readwrite").objectStore(STORE)
          .put({ key, value, symbolInterval, savedAt: Date.now() });
        request.onsuccess = () => resolve(true);
        request.onerror = () => reject(request.error);
      });
    }
  };
}

async function requestJSONWithRetry(url, fetchImpl = fetch, retries = 3) {
  let lastError;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await requestJSON(url, fetchImpl);
    } catch (error) {
      lastError = error;
      if (error.status && error.status !== 429 && error.status < 500) throw error;
      if (attempt === retries - 1) throw lastError;
      await new Promise(resolve => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function mapLimit(items, concurrency, worker) {
  const output = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await worker(items[index], index);
    }
  }));
  return output;
}

export async function fetchKlinesRange({
  symbol, interval, startTime, endTime, cache = createHistoricalCache(),
  fetchImpl = fetch, concurrencyRetries = 3
}) {
  if (!symbol || !interval) throw new TypeError("symbol and interval are required");
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) {
    throw new RangeError("Invalid kline time range");
  }
  const cacheKey = `${symbol}|${interval}|${startTime}|${endTime}`;
  const cached = await cache.get(cacheKey);
  if (cached) return cached;

  const all = [];
  let cursor = startTime;
  while (cursor < endTime) {
    const query = new URLSearchParams({
      symbol, interval, startTime: String(cursor), endTime: String(endTime - 1),
      limit: String(MAX_KLINES)
    });
    let rows;
    let lastError;
    for (let attempt = 0; attempt < concurrencyRetries; attempt++) {
      try {
        rows = await requestJSON(`${API}/fapi/v1/klines?${query}`, fetchImpl);
        break;
      } catch (error) {
        lastError = error;
        if (error.status && error.status !== 429 && error.status < 500) throw error;
        if (attempt === concurrencyRetries - 1) throw lastError;
        await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
      }
    }
    if (!Array.isArray(rows) || rows.length === 0) break;
    const normalized = rows.map(normalizeKline);
    all.push(...normalized);
    const next = normalized[normalized.length - 1].openTime + 1;
    if (next <= cursor) throw new Error("Binance pagination did not advance");
    cursor = next;
    if (rows.length < MAX_KLINES) break;
  }
  const unique = [...new Map(all.filter(c => c.openTime >= startTime && c.openTime < endTime)
    .map(c => [c.openTime, c])).values()].sort((a, b) => a.openTime - b.openTime);
  await cache.put(cacheKey, unique, `${symbol}|${interval}`);
  return unique;
}

export async function fetchCurrentUsdtPerpetualSymbols(fetchImpl = fetch) {
  const info = await requestJSON(`${API}/fapi/v1/exchangeInfo`, fetchImpl);
  return (info.symbols || []).filter(s =>
    s.status === "TRADING" && s.contractType === "PERPETUAL"
    && s.quoteAsset === "USDT" && s.symbol.endsWith("USDT")
    && (!s.contractStatus || s.contractStatus === "TRADING")
  ).map(s => s.symbol);
}

export async function buildHistoricalTop100({
  startTime, endTime, symbols, concurrency = 4, cache = createHistoricalCache(),
  fetchImpl = fetch, onProgress = () => {}
}) {
  const list = symbols || await fetchCurrentUsdtPerpetualSymbols(fetchImpl);
  let completed = 0;
  const entries = await mapLimit(list, concurrency, async symbol => {
    const candles = await fetchKlinesRange({
      symbol, interval: "1d", startTime, endTime, cache, fetchImpl
    });
    completed++;
    onProgress({ completed, total: list.length, symbol });
    return [symbol, candles];
  });
  const dailyCandlesBySymbol = Object.fromEntries(entries);
  return {
    dailyUniverse: buildDailyUniverse(dailyCandlesBySymbol, { startTime, endTime, limit: 100 }),
    symbolsChecked: list.length,
    limitations: [
      "Universe starts from contracts that are currently active; delisted historical contracts are not reconstructed.",
      "Historical 24-hour price-change filter is approximated by each UTC daily candle open-to-close return.",
      "Historical Monitoring labels are not available from the public endpoint used."
    ]
  };
}

export async function fetchFundingHistory({
  symbol, startTime, endTime, fetchImpl = fetch, cache = createHistoricalCache()
}) {
  const cacheKey = `funding|${symbol}|${startTime}|${endTime}`;
  const cached = await cache.get(cacheKey);
  if (cached) return cached;
  const all = [];
  let cursor = startTime;
  while (cursor < endTime) {
    const query = new URLSearchParams({
      symbol, startTime: String(cursor), endTime: String(endTime - 1), limit: "1000"
    });
    const rows = await requestJSONWithRetry(`${API}/fapi/v1/fundingRate?${query}`, fetchImpl);
    if (!rows.length) break;
    for (const row of rows) {
      all.push({
        fundingTime: Number(row.fundingTime),
        rate: row.fundingRate === null ? null : Number(row.fundingRate),
        markPrice: row.markPrice === null || row.markPrice === "" ? null : Number(row.markPrice)
      });
    }
    const next = Number(rows[rows.length - 1].fundingTime) + 1;
    if (next <= cursor) throw new Error("Funding pagination did not advance");
    cursor = next;
    if (rows.length < 1000) break;
  }
  const unique = [...new Map(all.map(item => [item.fundingTime, item])).values()]
    .sort((a, b) => a.fundingTime - b.fundingTime);
  await cache.put(cacheKey, unique, `${symbol}|funding`);
  return unique;
}

export const HISTORICAL_DAY_MS = DAY;


const INTERVAL_MS = Object.freeze({
  "15m": 900_000, "30m": 1_800_000,
  "1h": 3_600_000, "2h": 7_200_000, "4h": 14_400_000,
  "6h": 21_600_000, "8h": 28_800_000, "12h": 43_200_000,
  "1d": DAY
});

/**
 * Downloads/caches the candle and funding inputs needed by the backtest.
 * The daily universe is reconstructed first; intraday data is then fetched
 * only for symbols that appear in at least one historical daily top-100 list.
 */
export async function fetchBacktestDataset({
  startTime, endTime, timeframes, concurrency = 4, cache = createHistoricalCache(),
  fetchImpl = fetch, onProgress = () => {}
}) {
  if (!Array.isArray(timeframes) || timeframes.length === 0) {
    throw new TypeError("Select at least one backtest timeframe");
  }
  const selected = [...new Set(timeframes)];
  for (const timeframe of selected) {
    if (!INTERVAL_MS[timeframe]) throw new RangeError(`Unsupported timeframe: ${timeframe}`);
  }

  const universe = await buildHistoricalTop100({
    startTime, endTime, concurrency, cache, fetchImpl,
    onProgress: p => onProgress({ phase: "daily-universe", ...p })
  });
  const symbols = [...new Set(Object.values(universe.dailyUniverse).flat().map(row => row.symbol))];
  const tasks = symbols.flatMap(symbol => selected.map(timeframe => ({ symbol, timeframe })));
  const total = tasks.length + symbols.length;
  let completed = 0;
  const candleResults = await mapLimit(tasks, concurrency, async task => {
    const warmupStart = Math.max(0, startTime - INTERVAL_MS[task.timeframe] * EMA_WARMUP_BARS);
    const candles = await fetchKlinesRange({
      symbol: task.symbol, interval: task.timeframe, startTime: warmupStart,
      endTime, cache, fetchImpl
    });
    completed++;
    onProgress({ phase: "klines", completed, total, symbol: task.symbol, timeframe: task.timeframe });
    return [`${task.symbol}|${task.timeframe}`, candles];
  });
  const fundingResults = await mapLimit(symbols, concurrency, async symbol => {
    const events = await fetchFundingHistory({ symbol, startTime, endTime, fetchImpl, cache });
    completed++;
    onProgress({ phase: "funding", completed, total, symbol });
    return [symbol, events];
  });
  return {
    startTime, endTime, timeframes: selected,
    dailyUniverse: universe.dailyUniverse,
    candlesBySymbolTimeframe: Object.fromEntries(candleResults),
    fundingBySymbol: Object.fromEntries(fundingResults),
    symbolsIncluded: symbols,
    symbolsCheckedForDailyUniverse: universe.symbolsChecked,
    limitations: universe.limitations
  };
}
