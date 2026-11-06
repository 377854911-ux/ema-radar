import test from "node:test";
import assert from "node:assert/strict";
import { buildDailyUniverse, normalizeKline, fetchBacktestDataset, EMA_WARMUP_BARS, fetchFundingHistory, fetchKlinesRange, createHistoricalCache } from "../js/historical-data.js";
import { runHistoricalBacktest, createBacktestRange, BACKTEST_PERIOD_DAYS } from "../js/historical-backtest.js";
import { calculateEMA } from "../js/ema-engine.js";

test("historical cache falls back to page memory when IndexedDB is unavailable", async () => {
  const cache = createHistoricalCache(null);
  assert.equal(await cache.get("missing"), null);
  assert.equal(await cache.put("key", [{ close: 123 }]), false);
  assert.deepEqual(await cache.get("key"), [{ close: 123 }]);
});

test("historical cache falls back to page memory when IndexedDB open fails", async () => {
  const brokenIndexedDB = {
    open() {
      const request = {};
      queueMicrotask(() => request.onerror?.());
      request.error = new Error("storage unavailable");
      return request;
    }
  };
  const cache = createHistoricalCache(brokenIndexedDB);
  assert.equal(await cache.put("key", [1, 2, 3]), false);
  assert.deepEqual(await cache.get("key"), [1, 2, 3]);
});

test("normalizes Binance kline fields including quote turnover", () => {
  const candle = normalizeKline([0,"100","110","90","105","12",86399999,"1234"]);
  assert.equal(candle.open, 100);
  assert.equal(candle.close, 105);
  assert.equal(candle.quoteVolume, 1234);
});

test("builds a separate turnover-ranked top list for each UTC day", () => {
  const day = 1_800_000_000_000;
  const input = {
    AAAUSDT: [{ openTime: day, open: 100, close: 110, quoteVolume: 1000 }],
    BBBUSDT: [{ openTime: day, open: 100, close: 101, quoteVolume: 2000 }],
    CCCUSDT: [{ openTime: day, open: 100, close: 140, quoteVolume: 9000 }],
    DDDUSDT: [{ openTime: day + 86_400_000, open: 100, close: 99, quoteVolume: 3000 }]
  };
  const result = buildDailyUniverse(input, { startTime: day, endTime: day + 2 * 86_400_000, limit: 2 });
  assert.deepEqual(result[day].map(x => x.symbol), ["BBBUSDT", "AAAUSDT"]);
  assert.deepEqual(result[day + 86_400_000].map(x => x.symbol), ["DDDUSDT"]);
});

test("excludes daily moves strictly beyond plus or minus 30 percent", () => {
  const day = 1_800_000_000_000;
  const input = {
    UPUSDT: [{ openTime: day, open: 100, close: 130.01, quoteVolume: 1000 }],
    DOWNUSDT: [{ openTime: day, open: 100, close: 69.99, quoteVolume: 900 }],
    EDGEUSDT: [{ openTime: day, open: 100, close: 130, quoteVolume: 800 }]
  };
  const result = buildDailyUniverse(input, { startTime: day, endTime: day + 86_400_000 });
  assert.deepEqual(result[day].map(x => x.symbol), ["EDGEUSDT"]);
});

test("retains a UTC day key when all daily symbols are excluded by the 30 percent filter", () => {
  const day = 1_800_000_000_000;
  const result = buildDailyUniverse({
    UPUSDT: [{ openTime: day, open: 100, close: 140, quoteVolume: 1000 }],
    DOWNUSDT: [{ openTime: day, open: 100, close: 60, quoteVolume: 900 }]
  }, { startTime: day, endTime: day + 86_400_000 });
  assert.deepEqual(result[day], []);
});

test("reports missing daily universe dates instead of silently treating them as no signals", async () => {
  const startTime = Math.floor(1_800_000_000_000 / 86_400_000) * 86_400_000;
  const endTime = startTime + 86_400_000;
  const priorDay = Math.floor(startTime / 86_400_000) * 86_400_000 - 86_400_000;
  const result = await fetchBacktestDataset({
    startTime, endTime, timeframes: ["15m"], concurrency: 1,
    fetchImpl: async input => {
      const url = new URL(input);
      let data = [];
      if (url.pathname.endsWith("/exchangeInfo")) {
        data = { symbols: [{ symbol: "TESTUSDT", status: "TRADING", contractType: "PERPETUAL", quoteAsset: "USDT" }] };
      } else if (url.pathname.endsWith("/klines") && url.searchParams.get("interval") === "1d") {
        data = [[priorDay, "100", "105", "99", "104", "10", startTime - 1, "2000"]];
      }
      return { ok: true, json: async () => data };
    }
  });
  assert.deepEqual(result.missingUniverseDays, [startTime]);
  assert.equal(result.expectedUniverseDays, 2);
  assert.ok(result.limitations.some(item => item.includes("daily-universe data is missing")));
});

test("downloads enough pre-period candles to warm up EMA100", async () => {
  const startTime = 1_800_000_000_000;
  const endTime = startTime + 86_400_000;
  const requests = [];
  const fetchImpl = async input => {
    const url = new URL(input);
    requests.push(url);
    let data = [];
    if (url.pathname.endsWith("/exchangeInfo")) {
      data = { symbols: [{
        symbol: "TESTUSDT", status: "TRADING", contractType: "PERPETUAL",
        quoteAsset: "USDT", contractStatus: "TRADING"
      }] };
    } else if (url.pathname.endsWith("/klines") && url.searchParams.get("interval") === "1d") {
      const dailyStart = Math.floor(startTime / 86_400_000) * 86_400_000 - 86_400_000;
      data = [[dailyStart,"100","110","90","105","10",startTime-1,"1000"]];
    }
    return { ok: true, json: async () => data };
  };
  await fetchBacktestDataset({
    startTime, endTime, timeframes: ["15m"], fetchImpl, concurrency: 1
  });
  const daily = requests.find(url =>
    url.pathname.endsWith("/klines") && url.searchParams.get("interval") === "1d"
  );
  assert.ok(daily);
  assert.equal(Number(daily.searchParams.get("startTime")),
    Math.floor(startTime / 86_400_000) * 86_400_000 - 86_400_000);
  const intraday = requests.find(url =>
    url.pathname.endsWith("/klines") && url.searchParams.get("interval") === "15m"
  );
  assert.ok(intraday);
  assert.equal(Number(intraday.searchParams.get("startTime")),
    startTime - EMA_WARMUP_BARS * 900_000);
  const funding = requests.find(url => url.pathname.endsWith("/fundingRate"));
  assert.ok(funding);
  assert.equal(Number(funding.searchParams.get("startTime")), startTime - 8 * 86_400_000);
  assert.equal(EMA_WARMUP_BARS, 500);
});

test("rejects the unsupported 10-minute Binance futures interval", async () => {
  await assert.rejects(
    fetchBacktestDataset({
      startTime: 1_800_000_000_000,
      endTime: 1_800_086_400_000,
      timeframes: ["10m"],
      fetchImpl: async () => { throw new Error("network should not be called"); }
    }),
    /Unsupported timeframe: 10m/
  );
});

test("retries temporary funding endpoint rate limits", async () => {
  let calls = 0;
  const events = await fetchFundingHistory({
    symbol: "TESTUSDT",
    startTime: 100,
    endTime: 1000,
    fetchImpl: async () => {
      calls++;
      if (calls === 1) return {
        ok: false, status: 429,
        headers: { get: name => name === "Retry-After" ? "0" : null },
        json: async () => ({})
      };
      return {
        ok: true,
        json: async () => [{
          fundingTime: 500, fundingRate: "0.0001", markPrice: "100"
        }]
      };
    }
  });
  assert.equal(calls, 2);
  assert.equal(events.length, 1);
  assert.equal(events[0].rate, 0.0001);
});

test("stops immediately on Binance HTTP 418 instead of retrying an IP ban", async () => {
  let calls = 0;
  await assert.rejects(() => fetchFundingHistory({
    symbol: "TESTUSDT", startTime: 100, endTime: 1000,
    fetchImpl: async () => {
      calls++;
      return {
        ok: false, status: 418,
        headers: { get: () => null },
        json: async () => ({})
      };
    }
  }), /Binance API 418/);
  assert.equal(calls, 1);
});

test("builds the daily trading universe with one prior completed UTC day", async () => {
  const startTime = 1_800_000_000_000;
  const endTime = startTime + 86_400_000;
  const dailyStart = Math.floor(startTime / 86_400_000) * 86_400_000 - 86_400_000;
  const result = await fetchBacktestDataset({
    startTime, endTime, timeframes: ["15m"], concurrency: 1,
    fetchImpl: async input => {
      const url = new URL(input);
      let data = [];
      if (url.pathname.endsWith("/exchangeInfo")) {
        data = { symbols: [{
          symbol: "TESTUSDT", status: "TRADING", contractType: "PERPETUAL",
          quoteAsset: "USDT", contractStatus: "TRADING"
        }] };
      } else if (url.pathname.endsWith("/klines") && url.searchParams.get("interval") === "1d") {
        data = [
          [dailyStart,"100","105","99","104","10",startTime-1,"2000"],
          [startTime,"104","110","100","108","10",endTime-1,"9000"]
        ];
      }
      return { ok: true, json: async () => data };
    }
  });
  assert.deepEqual(result.dailyUniverse[dailyStart].map(row => row.symbol), ["TESTUSDT"]);
  assert.deepEqual(result.dailyUniverse[startTime].map(row => row.symbol), ["TESTUSDT"]);
});

test("funding history preserves conflicting same-time records for downstream ambiguity checks", async () => {
  const rows = [
    { fundingTime: 500, fundingRate: "0.0001", markPrice: "100" },
    { fundingTime: 500, fundingRate: "0.0001", markPrice: "101" },
    { fundingTime: 600, fundingRate: "0.0002", markPrice: "100" },
    { fundingTime: 600, fundingRate: "0.0002", markPrice: "100" }
  ];
  let cachedKey = "";
  let cachedValue;
  const cache = {
    async get(key) { cachedKey = key; return null; },
    async put(key, value) { cachedKey = key; cachedValue = value; }
  };
  const events = await fetchFundingHistory({
    symbol: "TESTUSDT", startTime: 100, endTime: 1000, cache,
    fetchImpl: async () => ({ ok: true, json: async () => rows })
  });
  assert.match(cachedKey, /^funding-v2\\|/);
  assert.equal(events.length, 3);
  assert.deepEqual(events.filter(event => event.fundingTime === 500).map(event => event.markPrice), [100, 101]);
  assert.equal(events.filter(event => event.fundingTime === 600).length, 1);
  assert.equal(cachedValue.length, 3);
});

test("rejects malformed non-array kline responses instead of caching empty history", async () => {
  let cacheWrites = 0;
  await assert.rejects(() => fetchKlinesRange({
    symbol: "TESTUSDT", interval: "15m", startTime: 100, endTime: 1000,
    cache: {
      async get() { return null; },
      async put() { cacheWrites++; }
    },
    fetchImpl: async () => ({ ok: true, json: async () => ({ code: -1, msg: "unexpected response" }) })
  }), /invalid kline response/);
  assert.equal(cacheWrites, 0);
});

test("rejects malformed non-array funding responses", async () => {
  await assert.rejects(() => fetchFundingHistory({
    symbol: "TESTUSDT", startTime: 100, endTime: 1000,
    cache: { async get() { return null; }, async put() {} },
    fetchImpl: async () => ({ ok: true, json: async () => ({ code: -1, msg: "unexpected response" }) })
  }), /invalid funding response/);
});

test("rejects conflicting duplicate historical kline rows instead of choosing one", async () => {
  const row = [100, "100", "102", "99", "101", "10", 199, "1000"];
  const conflicting = [...row];
  conflicting[4] = "100.5";
  await assert.rejects(() => fetchKlinesRange({
    symbol: "TESTUSDT", interval: "15m", startTime: 100, endTime: 1000,
    cache: { async get() { return null; }, async put() { throw new Error("must not cache invalid rows"); } },
    fetchImpl: async () => ({ ok: true, json: async () => [row, conflicting] })
  }), /Conflicting Binance kline records/);
});


test("public historical download feeds a complete EMA backtest end to end", async () => {
  const dayMs = 86_400_000;
  const intervalMs = 900_000;
  const startTime = 20 * dayMs;
  const endTime = startTime + dayMs;
  const warmupStart = startTime - EMA_WARMUP_BARS * intervalMs;
  const candles = Array.from({ length: EMA_WARMUP_BARS + 96 }, (_, i) => {
    const close = 100 + i * 0.01;
    const openTime = warmupStart + i * intervalMs;
    return [
      openTime, String(close - 0.02), String(close + 0.1),
      String(close - 0.1), String(close), "10",
      openTime + intervalMs - 1, "1000"
    ];
  });
  const signalIndex = EMA_WARMUP_BARS + 5;
  const emaValues = [25, 50, 100].map(period =>
    calculateEMA(candles.map(row => Number(row[4])), period)[signalIndex]
  );
  const signalOpen = Math.min(...emaValues) - 1;
  const signalClose = Math.max(...emaValues) + 1;
  const signalTime = warmupStart + signalIndex * intervalMs;
  candles[signalIndex] = [
    signalTime, String(signalOpen), String(signalClose + 1),
    String(signalOpen - 1), String(signalClose), "10",
    signalTime + intervalMs - 1, "1000"
  ];
  const nextTime = signalTime + intervalMs;
  candles[signalIndex + 1] = [
    nextTime, String(signalClose), String(signalClose * 1.1),
    String(signalClose - 0.1), String(signalClose * 1.05), "10",
    nextTime + intervalMs - 1, "1000"
  ];
  const dailyRows = [startTime - dayMs, startTime].map(openTime => [
    openTime, "100", "101", "99", "100", "100",
    openTime + dayMs - 1, "100000"
  ]);
  const dataset = await fetchBacktestDataset({
    startTime, endTime, timeframes: ["15m"], concurrency: 1,
    fetchImpl: async input => {
      const url = new URL(input);
      let data = [];
      if (url.pathname.endsWith("/exchangeInfo")) {
        data = { symbols: [{
          symbol: "TESTUSDT", status: "TRADING",
          contractType: "PERPETUAL", quoteAsset: "USDT"
        }] };
      } else if (url.pathname.endsWith("/klines")) {
        data = url.searchParams.get("interval") === "1d" ? dailyRows : candles;
      } else if (url.pathname.endsWith("/fundingRate")) {
        data = [];
      }
      return { ok: true, json: async () => data };
    }
  });
  const result = await runHistoricalBacktest(dataset, {
    initialCapital: 10_000,
    maxOpenTrades: 5,
    timeframes: ["15m"],
    tradeConfig: {
      entryMethod: "next_open",
      hardStopPct: 2,
      auxiliaryStop: "signal_open",
      rr: 1.1,
      positionNotional: 500,
      entryFeeRate: 0,
      exitFeeRate: 0,
      entrySlippageRate: 0,
      slippageRate: 0,
      timeoutBars: null
    }
  });
  assert.equal(dataset.missingUniverseDays.length, 0);
  assert.equal(result.datasetStats.candleSeries, 1);
  assert.equal(result.scanStats.signalsFound, 1);
  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0].status, "closed");
  assert.equal(result.accepted[0].exitReason, "take_profit");
  assert.ok(result.report.netProfit > 0);
});


test("supports the 90-day range exposed by the backtest page", () => {
  const endTime = 1_800_000_000_000;
  assert.deepEqual(BACKTEST_PERIOD_DAYS, [7, 30, 60, 90]);
  const range = createBacktestRange(90, endTime);
  assert.equal(range.endTime, Math.floor(endTime / 86_400_000) * 86_400_000);
  assert.equal(range.endTime - range.startTime, 90 * 86_400_000);
  assert.throws(() => createBacktestRange(120, endTime), /7, 30, 60, or 90/);
});
