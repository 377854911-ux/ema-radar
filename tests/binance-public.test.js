import test from "node:test";
import assert from "node:assert/strict";
import { getFundingRateMap, scanMarket } from "../js/binance-public.js";

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
    assert.deepEqual(requestedLimits, ["502"]);
    assert.equal(result.scanned, 3);
  } finally {
    globalThis.fetch = originalFetch;
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
