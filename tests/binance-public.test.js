import test from "node:test";
import assert from "node:assert/strict";
import { getFundingRateMap, getKlines, scanMarket } from "../js/binance-public.js";

test("live market-data requests retry Binance 429 responses", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return {
        ok: false,
        status: 429,
        headers: { get: () => "0" }
      };
    }
    return { ok: true, json: async () => [] };
  };
  try {
    const rows = await getKlines("RETRYUSDT", "15m", 10);
    assert.deepEqual(rows, []);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("live scanner excludes both positive and negative high funding rates before fetching klines", async () => {
  const originalFetch = globalThis.fetch;
  const requestedKlines = [];
  const requestedLimits = [];
  globalThis.fetch = async input => {
    const url = new URL(input);
    if (url.pathname.endsWith("/premiumIndex")) {
      return {
        ok: true,
        json: async () => [
          { symbol: "HIGHUSDT", lastFundingRate: "0.0002" },
          { symbol: "LOWUSDT", lastFundingRate: "-0.00005" },
          { symbol: "MISSINGUSDT", lastFundingRate: null }
        ]
      };
    }
    if (url.pathname.endsWith("/klines")) {
      requestedKlines.push(url.searchParams.get("symbol"));
      requestedLimits.push(url.searchParams.get("limit"));
      return { ok: true, json: async () => [] };
    }
    throw new Error("Unexpected request: " + url);
  };
  try {
    const result = await scanMarket({
      symbols: ["HIGHUSDT", "LOWUSDT", "MISSINGUSDT"],
      timeframes: ["15m"],
      fundingFilterPct: 0.01,
      concurrency: 1
    });
    assert.equal(result.fundingFiltered, 1);
    assert.equal(result.fundingUnavailable, 1);
    assert.deepEqual(requestedKlines, ["LOWUSDT"]);
    assert.deepEqual(requestedLimits, ["499"]);
    assert.equal(result.scanned, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("live EMA scanner seeds once, then fetches only candles since the cached close", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const intervalMs = 15 * 60_000;
  const currentOpenTime = Math.floor(originalNow() / intervalMs) * intervalMs;
  const baseOpenTime = currentOpenTime - 501 * intervalMs;
  let fakeNow = currentOpenTime + 1000;
  const requests = [];
  const candle = openTime => [
    openTime, "100", "101", "99", "100", "0", openTime + intervalMs - 1, "0"
  ];
  const initial = Array.from({ length: 502 }, (_, i) => candle(baseOpenTime + i * intervalMs));
  globalThis.fetch = async input => {
    const url = new URL(input);
    requests.push({
      startTime: url.searchParams.get("startTime"),
      limit: url.searchParams.get("limit")
    });
    if (url.searchParams.get("limit") === "499" && !url.searchParams.has("startTime")) {
      return { ok: true, json: async () => initial.slice(3) };
    }
    if (url.searchParams.get("limit") === "3" && Number(url.searchParams.get("startTime")) === baseOpenTime) {
      return { ok: true, json: async () => initial.slice(0, 3) };
    }
    const start = Number(url.searchParams.get("startTime"));
    if (start === currentOpenTime) {
      return { ok: true, json: async () => [
        candle(currentOpenTime), candle(currentOpenTime + intervalMs)
      ] };
    }
    if (start === currentOpenTime + intervalMs) {
      return { ok: true, json: async () => [candle(currentOpenTime + intervalMs)] };
    }
    throw new Error("Unexpected incremental startTime: " + start);
  };
  Date.now = () => fakeNow;
  try {
    await scanMarket({ symbols: ["CACHEUSDT"], timeframes: ["15m"], concurrency: 1 });
    fakeNow = currentOpenTime + intervalMs + 1000;
    await scanMarket({ symbols: ["CACHEUSDT"], timeframes: ["15m"], concurrency: 1 });
    await scanMarket({ symbols: ["CACHEUSDT"], timeframes: ["15m"], concurrency: 1 });
    assert.equal(requests.length, 4);
    assert.equal(requests[0].limit, "499");
    assert.equal(requests[0].startTime, null);
    assert.equal(requests[1].limit, "3");
    assert.equal(requests[1].startTime, String(baseOpenTime));
    assert.equal(requests[2].startTime, String(currentOpenTime));
    assert.equal(requests[2].limit, "4");
    assert.equal(requests[3].startTime, String(currentOpenTime + intervalMs));
    assert.equal(requests[3].limit, "3");
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});

test("live EMA scanner rebuilds its warm-up when incremental candles contain a gap", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const intervalMs = 15 * 60_000;
  const currentOpenTime = Math.floor(originalNow() / intervalMs) * intervalMs;
  const baseOpenTime = currentOpenTime - 501 * intervalMs;
  let fakeNow = currentOpenTime + 1000;
  const requests = [];
  const candle = openTime => [
    openTime, "100", "101", "99", "100", "0", openTime + intervalMs - 1, "0"
  ];
  const firstWindow = Array.from({ length: 502 }, (_, i) => candle(baseOpenTime + i * intervalMs));
  const refreshedBase = currentOpenTime - 500 * intervalMs;
  const refreshedWindow = Array.from({ length: 502 }, (_, i) => candle(refreshedBase + i * intervalMs));
  globalThis.fetch = async input => {
    const url = new URL(input);
    const startTime = url.searchParams.get("startTime");
    const limit = url.searchParams.get("limit");
    requests.push({ startTime, limit });
    if (limit === "499" && startTime === null && requests.length === 1) {
      return { ok: true, json: async () => firstWindow.slice(3) };
    }
    if (limit === "3" && startTime === String(baseOpenTime)) {
      return { ok: true, json: async () => firstWindow.slice(0, 3) };
    }
    if (startTime === String(currentOpenTime)) {
      return { ok: true, json: async () => [candle(currentOpenTime + intervalMs)] };
    }
    if (limit === "499" && startTime === null && requests.length === 4) {
      return { ok: true, json: async () => refreshedWindow.slice(3) };
    }
    if (limit === "3" && startTime === String(refreshedBase)) {
      return { ok: true, json: async () => refreshedWindow.slice(0, 3) };
    }
    throw new Error("Unexpected kline request");
  };
  Date.now = () => fakeNow;
  try {
    await scanMarket({ symbols: ["GAPCACHEUSDT"], timeframes: ["15m"], concurrency: 1 });
    fakeNow = currentOpenTime + intervalMs + 1000;
    await scanMarket({ symbols: ["GAPCACHEUSDT"], timeframes: ["15m"], concurrency: 1 });
    assert.equal(requests.length, 5);
    assert.equal(requests[0].limit, "499");
    assert.equal(requests[1].limit, "3");
    assert.equal(requests[1].startTime, String(baseOpenTime));
    assert.equal(requests[2].startTime, String(currentOpenTime));
    assert.equal(requests[3].limit, "499");
    assert.equal(requests[3].startTime, null);
    assert.equal(requests[4].limit, "3");
    assert.equal(requests[4].startTime, String(refreshedBase));
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});

test("funding rate map reads Binance last settled rates for selected symbols", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => [
      { symbol: "AAAUSDT", lastFundingRate: "0.0001" },
      { symbol: "BBBUSDT", lastFundingRate: "-0.0002" },
      { symbol: "NULLUSDT", lastFundingRate: null }
    ]
  });
  try {
    const rates = await getFundingRateMap(["AAAUSDT", "NULLUSDT"]);
    assert.equal(rates.get("AAAUSDT"), 0.0001);
    assert.equal(rates.has("BBBUSDT"), false);
    assert.equal(rates.get("NULLUSDT"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
