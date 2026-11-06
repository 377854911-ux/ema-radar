import test from "node:test";
import assert from "node:assert/strict";
import { buildDailyUniverse, normalizeKline, fetchBacktestDataset, EMA_WARMUP_BARS, fetchFundingHistory } from "../js/historical-data.js";

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
      data = [[startTime,"100","110","90","105","10",endTime-1,"1000"]];
    }
    return { ok: true, json: async () => data };
  };
  await fetchBacktestDataset({
    startTime, endTime, timeframes: ["15m"], fetchImpl, concurrency: 1
  });
  const intraday = requests.find(url =>
    url.pathname.endsWith("/klines") && url.searchParams.get("interval") === "15m"
  );
  assert.ok(intraday);
  assert.equal(Number(intraday.searchParams.get("startTime")),
    startTime - EMA_WARMUP_BARS * 900_000);
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
      if (calls === 1) return { ok: false, status: 429, json: async () => ({}) };
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
