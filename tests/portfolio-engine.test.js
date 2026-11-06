import test from "node:test";
import assert from "node:assert/strict";
import { simulatePortfolio } from "../js/portfolio-engine.js";

const config = {
  entryMethod: "next_open",
  hardStopPct: 2,
  auxiliaryStop: "signal_open",
  rr: 1,
  positionNotional: 500,
  entryFeeRate: 0,
  exitFeeRate: 0,
  entrySlippageRate: 0,
  slippageRate: 0,
  timeoutBars: null
};

function longCandles(symbolOffset = 0) {
  return [
    { openTime: 0, closeTime: 9, open: 98 + symbolOffset, high: 101 + symbolOffset, low: 97 + symbolOffset, close: 100 + symbolOffset },
    { openTime: 10, closeTime: 19, open: 100 + symbolOffset, high: 101 + symbolOffset, low: 99 + symbolOffset, close: 100 + symbolOffset },
    { openTime: 20, closeTime: 29, open: 100 + symbolOffset, high: 103 + symbolOffset, low: 99 + symbolOffset, close: 102 + symbolOffset },
    { openTime: 30, closeTime: 39, open: 102 + symbolOffset, high: 103 + symbolOffset, low: 101 + symbolOffset, close: 102 + symbolOffset }
  ];
}

test("same symbol and signal close keeps only shortest timeframe", () => {
  const candles = longCandles();
  const result = simulatePortfolio([
    { symbol: "AAAUSDT", timeframe: "1h", direction: "LONG", distanceRate: 0.01, candles, signalIndex: 0, config },
    { symbol: "AAAUSDT", timeframe: "15m", direction: "LONG", distanceRate: 0.2, candles, signalIndex: 0, config }
  ]);
  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0].timeframe, "15m");
});

test("five open positions maximum; simultaneous candidates rank by EMA distance", () => {
  const candidates = Array.from({ length: 6 }, (_, i) => ({
    symbol: `COIN${i}USDT`,
    timeframe: "1h",
    direction: "LONG",
    distanceRate: 0.01 * (6 - i),
    candles: longCandles(i),
    signalIndex: 0,
    config
  }));
  const result = simulatePortfolio(candidates);
  assert.equal(result.accepted.length, 5);
  assert.equal(result.skipped.filter(x => x.reason === "max_open_trades_reached").length, 1);
  assert.equal(result.accepted[0].symbol, "COIN5USDT");
});

test("capital and position slot are released before an entry at the same timestamp", () => {
  const firstCandles = [
    { openTime: 0, closeTime: 9, open: 98, high: 101, low: 97, close: 100 },
    { openTime: 10, closeTime: 19, open: 100, high: 103, low: 99, close: 102 },
    { openTime: 20, closeTime: 29, open: 102, high: 103, low: 101, close: 102 }
  ];
  const secondCandles = [
    { openTime: 0, closeTime: 9, open: 98, high: 101, low: 97, close: 100 },
    { openTime: 10, closeTime: 19, open: 99, high: 101, low: 98, close: 100 },
    { openTime: 20, closeTime: 29, open: 100, high: 103, low: 100, close: 102 },
    { openTime: 30, closeTime: 39, open: 102, high: 103, low: 101, close: 102 }
  ];
  const signalCloseConfig = { ...config, entryMethod: "signal_close", positionNotional: 700 };
  const result = simulatePortfolio([
    {
      symbol: "FIRSTUSDT", timeframe: "1h", direction: "LONG",
      distanceRate: 0.1, candles: firstCandles, signalIndex: 0,
      config: signalCloseConfig
    },
    {
      symbol: "SECONDUSDT", timeframe: "1h", direction: "LONG",
      distanceRate: 0.1, candles: secondCandles, signalIndex: 1,
      config: signalCloseConfig
    }
  ], { initialCapital: 1_000, maxOpenTrades: 1 });

  assert.equal(result.accepted.length, 2);
  assert.equal(result.accepted[0].exitTime, 19);
  assert.equal(result.accepted[1].entryTime, 19);
  assert.equal(result.skipped.some(item => item.reason === "max_open_trades_reached"), false);
  assert.equal(result.capital.usedCapital, 0);
  assert.equal(result.capital.accountBalance, 1_028);
});

test("an opposite signal is discarded while an existing position is open", () => {
  const first = [
    { openTime: 0, closeTime: 9, open: 98, high: 101, low: 97, close: 100 },
    { openTime: 10, closeTime: 19, open: 100, high: 101, low: 99, close: 100 },
    { openTime: 20, closeTime: 29, open: 100, high: 103, low: 99, close: 102 },
    { openTime: 30, closeTime: 39, open: 102, high: 103, low: 101, close: 102 }
  ];
  const bearish = [
    { openTime: 0, closeTime: 9, open: 102, high: 103, low: 99, close: 100 },
    { openTime: 10, closeTime: 19, open: 100, high: 101, low: 97, close: 98 },
    { openTime: 20, closeTime: 29, open: 98, high: 99, low: 97, close: 98 },
    { openTime: 30, closeTime: 39, open: 98, high: 99, low: 97, close: 98 }
  ];
  const result = simulatePortfolio([
    { symbol: "AAAUSDT", timeframe: "1h", direction: "LONG", distanceRate: 0.1, candles: first, signalIndex: 0, config },
    { symbol: "AAAUSDT", timeframe: "1h", direction: "SHORT", distanceRate: 0.1, candles: bearish, signalIndex: 1, config }
  ]);
  assert.equal(result.accepted.length, 1);
  assert.equal(result.skipped.some(x => x.reason === "opposite_position_open_at_signal"), true);
});


test("consecutive-loss replenishment resets to base plus the scheduled bonus", () => {
  function losingCandles(start) {
    return [
      { openTime: start, closeTime: start + 9, open: 98, high: 101, low: 97, close: 100 },
      { openTime: start + 10, closeTime: start + 19, open: 100, high: 101, low: 97, close: 99 },
      { openTime: start + 20, closeTime: start + 29, open: 99, high: 100, low: 98, close: 99 }
    ];
  }
  const result = simulatePortfolio([
    { symbol: "LOSS1USDT", timeframe: "1h", direction: "LONG", distanceRate: 0.1, candles: losingCandles(0), signalIndex: 0, config },
    { symbol: "LOSS2USDT", timeframe: "1h", direction: "LONG", distanceRate: 0.1, candles: losingCandles(30), signalIndex: 0, config }
  ]);
  assert.equal(result.capital.events.filter(e => e.type === "loss_replenishment").length, 2);
  assert.equal(result.capital.events[0].targetBalance, 11_000);
  assert.equal(result.capital.events[1].targetBalance, 12_000);
  assert.equal(result.capital.cumulativeTopUps, 3_010);
  assert.equal(result.capital.actualCashInjected, 2_020);
  assert.equal(result.capital.accountBalance, 12_000);
  // The trough before each replenishment must remain visible in drawdown.
  assert.ok(Math.abs(result.summary.maxDrawdownPct - 0.1) < 1e-9);
});

test("portfolio skips a trade when its fixed notional exceeds available funds", () => {
  const result = simulatePortfolio([
    {
      symbol: "TOOBIGUSDT", timeframe: "1h", direction: "LONG", distanceRate: 0.1,
      candles: longCandles(), signalIndex: 0,
      config: { ...config, positionNotional: 10_001 }
    }
  ]);
  assert.equal(result.accepted.length, 0);
  assert.equal(result.skipped[0].reason, "insufficient_available_balance");
});

test("portfolio drawdown follows realized exit order when trades overlap", () => {
  const slowerWin = [
    { openTime: 0, closeTime: 9, open: 98, high: 101, low: 97, close: 100 },
    { openTime: 10, closeTime: 19, open: 100, high: 101, low: 99, close: 100 },
    { openTime: 20, closeTime: 29, open: 100, high: 101, low: 99, close: 100 },
    { openTime: 30, closeTime: 39, open: 100, high: 103, low: 99, close: 102 }
  ];
  const fasterLoss = [
    { openTime: 0, closeTime: 9, open: 99, high: 101, low: 98, close: 100 },
    { openTime: 10, closeTime: 19, open: 98, high: 101, low: 97, close: 100 },
    { openTime: 20, closeTime: 29, open: 100, high: 101, low: 97, close: 99 },
    { openTime: 30, closeTime: 39, open: 99, high: 100, low: 98, close: 99 }
  ];
  const result = simulatePortfolio([
    { symbol: "WINUSDT", timeframe: "1h", direction: "LONG", distanceRate: 0.1, candles: slowerWin, signalIndex: 0, config },
    { symbol: "LOSSUSDT", timeframe: "1h", direction: "LONG", distanceRate: 0.1, candles: fasterLoss, signalIndex: 1, config }
  ]);
  assert.equal(result.accepted.length, 2);
  assert.equal(result.accepted[0].exitTime, 39);
  assert.equal(result.accepted[1].exitTime, 29);
  assert.ok(Math.abs(result.summary.maxDrawdownPct - 0.1) < 1e-9);
});


test("ambiguous same-candle exit pays fees but does not increase the loss streak", () => {
  const collision = [
    { openTime: 0, closeTime: 9, open: 98, high: 101, low: 97, close: 100 },
    { openTime: 10, closeTime: 19, open: 100, high: 105, low: 97, close: 101 },
    { openTime: 20, closeTime: 29, open: 101, high: 102, low: 100, close: 101 }
  ];
  const result = simulatePortfolio([{
    symbol: "AMBIGUOUSUSDT", timeframe: "1h", direction: "LONG",
    distanceRate: 0.1, candles: collision, signalIndex: 0,
    config: { ...config, entryFeeRate: 0.1, exitFeeRate: 0.1 }
  }]);
  assert.equal(result.accepted[0].exitReason, "ambiguous_both_touched");
  assert.equal(result.accepted[0].grossPnl, 0);
  assert.equal(result.accepted[0].netPnl, -1);
  assert.equal(result.capital.consecutiveLosses, 0);
  assert.equal(result.capital.events.some(event => event.type === "ambiguous_trade"), true);
  assert.equal(result.capital.events.some(event => event.type === "loss_replenishment"), false);
});


test("realized net profit, fee deductions, funding and account balance reconcile", () => {
  const result = simulatePortfolio([{
    symbol: "RECONCILEUSDT",
    timeframe: "1h",
    direction: "LONG",
    distanceRate: 0.1,
    candles: longCandles(),
    signalIndex: 0,
    config: { ...config, entryFeeRate: 0.1, exitFeeRate: 0.1 },
    fundingEvents: [{ fundingTime: 15, rate: 0.001, markPrice: 100 }]
  }]);

  const trade = result.accepted[0];
  assert.equal(trade.status, "closed");
  assert.equal(trade.grossPnl, 10);
  assert.equal(trade.entryFee, 0.5);
  assert.equal(trade.exitFee, 0.51);
  assert.equal(trade.fundingPnl, -0.5);
  assert.ok(Math.abs(trade.netPnl - 8.49) < 1e-9);
  assert.ok(Math.abs(result.summary.totalProfit - 8.49) < 1e-9);
  assert.equal(result.summary.totalLoss, 0);
  assert.ok(Math.abs(result.summary.netProfit - trade.netPnl) < 1e-9);
  assert.ok(Math.abs(result.capital.accountBalance - (result.initialCapital + trade.netPnl)) < 1e-9);
  assert.equal(result.capital.usedCapital, 0);
  assert.ok(Math.abs(result.capital.availableBalance - result.capital.accountBalance) < 1e-9);
  // Entry fee is a real cash outflow at entry, so it contributes to drawdown
  // before the later profitable settlement.
  assert.ok(Math.abs(result.summary.maxDrawdownPct - 0.01) < 1e-9);
  assert.equal(result.capital.events.some(event => event.type === "closed_position_funding" && event.time === 15), true);
});


test("drawdown is unknown when a funding-incomplete trade breaks cash accounting", () => {
  const candles = longCandles();
  const result = simulatePortfolio([{
    symbol: "UNKNOWNFUNDINGUSDT",
    timeframe: "1h",
    direction: "LONG",
    distanceRate: 0.1,
    candles,
    signalIndex: 0,
    config: { ...config, entryFeeRate: 0.1 },
    fundingEvents: [{ fundingTime: 10, rate: 0.001, markPrice: 100 }]
  }]);
  assert.equal(result.accepted[0].status, "incomplete");
  assert.equal(result.capital.capitalAccountingComplete, false);
  assert.equal(result.summary.maxDrawdownPct, null);
});


test("simultaneous losing exits count as one order-independent settlement batch", () => {
  function losingCandles() {
    return [
      { openTime: 0, closeTime: 9, open: 98, high: 101, low: 97, close: 100 },
      { openTime: 10, closeTime: 19, open: 100, high: 101, low: 97, close: 99 },
      { openTime: 20, closeTime: 29, open: 99, high: 100, low: 98, close: 99 }
    ];
  }
  const candidates = ["LOSS_AUSDT", "LOSS_BUSDT"].map(symbol => ({
    symbol, timeframe: "1h", direction: "LONG", distanceRate: 0.1,
    candles: losingCandles(), signalIndex: 0, config
  }));
  const forward = simulatePortfolio(candidates);
  const reversed = simulatePortfolio([...candidates].reverse());

  for (const result of [forward, reversed]) {
    assert.equal(result.accepted.length, 2);
    assert.deepEqual(result.accepted.map(trade => trade.exitTime), [19, 19]);
    assert.equal(result.capital.consecutiveLosses, 1);
    const replenishments = result.capital.events.filter(event => event.type === "loss_replenishment" && event.batch === true);
    assert.equal(replenishments.length, 1);
    assert.equal(replenishments[0].batchNetPnl, -20);
    assert.equal(replenishments[0].lossStreak, 1);
    assert.equal(replenishments[0].targetBalance, 11_000);
    assert.equal(result.capital.accountBalance, 11_000);
    assert.equal(result.capital.cumulativeTopUps, 1_020);
  }
  assert.equal(forward.capital.accountBalance, reversed.capital.accountBalance);
  assert.equal(forward.capital.consecutiveLosses, reversed.capital.consecutiveLosses);
  assert.equal(forward.capital.cumulativeTopUps, reversed.capital.cumulativeTopUps);
});

test("simultaneous mixed exits use their combined net result for the loss streak", () => {
  const winner = [
    { openTime: 0, closeTime: 9, open: 98, high: 101, low: 97, close: 100 },
    { openTime: 10, closeTime: 19, open: 100, high: 103, low: 99, close: 102 },
    { openTime: 20, closeTime: 29, open: 102, high: 103, low: 101, close: 102 }
  ];
  const loser = [
    { openTime: 0, closeTime: 9, open: 98, high: 101, low: 97, close: 100 },
    { openTime: 10, closeTime: 19, open: 100, high: 101, low: 97, close: 99 },
    { openTime: 20, closeTime: 29, open: 99, high: 100, low: 98, close: 99 }
  ];
  const result = simulatePortfolio([
    { symbol: "WIN_BATCHUSDT", timeframe: "1h", direction: "LONG", distanceRate: 0.1, candles: winner, signalIndex: 0, config },
    { symbol: "LOSS_BATCHUSDT", timeframe: "1h", direction: "LONG", distanceRate: 0.1, candles: loser, signalIndex: 0, config }
  ]);
  assert.equal(result.accepted.length, 2);
  assert.equal(result.accepted[0].exitTime, result.accepted[1].exitTime);
  assert.equal(result.capital.consecutiveLosses, 0);
  assert.equal(result.capital.events.some(event => event.type === "loss_replenishment" && event.batch === true), false);
  assert.equal(result.capital.accountBalance, 10_000);
});


test("open positions apply known funding through the final candle without realizing price PnL", () => {
  const candles = [
    { openTime: 0, closeTime: 9, open: 98, high: 101, low: 97, close: 100 },
    { openTime: 10, closeTime: 19, open: 100, high: 101, low: 99, close: 100 },
    { openTime: 20, closeTime: 29, open: 100, high: 101, low: 99, close: 100 }
  ];
  const result = simulatePortfolio([{
    symbol: "OPENFUNDINGUSDT",
    timeframe: "1h",
    direction: "LONG",
    distanceRate: 0.1,
    candles,
    signalIndex: 0,
    config: { ...config, entryFeeRate: 0.1 },
    fundingEvents: [{ fundingTime: 15, rate: 0.001, markPrice: 100 }]
  }]);

  const trade = result.accepted[0];
  assert.equal(trade.status, "open");
  assert.equal(trade.exitTime, null);
  assert.equal(trade.fundingPnl, -0.5);
  assert.equal(trade.fundingComplete, true);
  assert.equal(result.capital.accountBalance, 9_999);
  assert.equal(result.capital.usedCapital, 500);
  assert.equal(result.capital.availableBalance, 9_499);
  assert.equal(result.summary.totalTrades, 0);
  assert.equal(result.summary.netProfit, 0);
  assert.equal(result.capital.events.some(event => event.type === "open_position_funding" && event.fundingPnl === -0.5), true);
});

test("open position with funding at the uncertain entry timestamp makes cash accounting incomplete", () => {
  const candles = [
    { openTime: 0, closeTime: 9, open: 98, high: 101, low: 97, close: 100 },
    { openTime: 10, closeTime: 19, open: 100, high: 101, low: 99, close: 100 },
    { openTime: 20, closeTime: 29, open: 100, high: 101, low: 99, close: 100 }
  ];
  const result = simulatePortfolio([{
    symbol: "OPENUNKNOWNFUNDINGUSDT",
    timeframe: "1h",
    direction: "LONG",
    distanceRate: 0.1,
    candles,
    signalIndex: 0,
    config,
    fundingEvents: [{ fundingTime: 10, rate: 0.001, markPrice: 100 }]
  }]);

  assert.equal(result.accepted[0].status, "open");
  assert.equal(result.accepted[0].fundingComplete, false);
  assert.equal(result.capital.capitalAccountingComplete, false);
  assert.equal(result.capital.accountBalance, null);
  assert.equal(result.capital.availableBalance, null);
  assert.equal(result.capital.usedCapital, 500);
  assert.equal(result.summary.maxDrawdownPct, null);
});


test("same symbol and signal time with conflicting long and short directions rejects both regardless of input order", () => {
  const bullish = longCandles();
  const bearish = [
    { openTime: 0, closeTime: 9, open: 102, high: 103, low: 99, close: 100 },
    { openTime: 10, closeTime: 19, open: 100, high: 101, low: 97, close: 98 },
    { openTime: 20, closeTime: 29, open: 98, high: 99, low: 97, close: 98 }
  ];
  const candidates = [
    { symbol: "CONFLICTUSDT", timeframe: "1h", direction: "LONG", distanceRate: 0.01, candles: bullish, signalIndex: 0, config },
    { symbol: "CONFLICTUSDT", timeframe: "15m", direction: "SHORT", distanceRate: 0.2, candles: bearish, signalIndex: 0, config }
  ];
  for (const ordered of [candidates, [...candidates].reverse()]) {
    const result = simulatePortfolio(ordered);
    assert.equal(result.accepted.length, 0);
    assert.equal(result.skipped.length, 2);
    assert.equal(result.skipped.every(item => item.reason === "conflicting_directions_same_signal_time"), true);
  }
});


test("funding paid by an existing open position reduces cash before a later entry is approved", () => {
  const firstCandles = [
    { openTime: 0, closeTime: 9, open: 98, high: 101, low: 97, close: 100 },
    { openTime: 10, closeTime: 19, open: 100, high: 101, low: 99, close: 100 },
    { openTime: 20, closeTime: 29, open: 100, high: 101, low: 99, close: 100 },
    { openTime: 30, closeTime: 39, open: 100, high: 101, low: 99, close: 100 }
  ];
  const secondCandles = [
    { openTime: 0, closeTime: 9, open: 98, high: 101, low: 97, close: 100 },
    { openTime: 10, closeTime: 19, open: 98, high: 101, low: 97, close: 100 },
    { openTime: 20, closeTime: 29, open: 100, high: 101, low: 99, close: 100 },
    { openTime: 30, closeTime: 39, open: 100, high: 101, low: 99, close: 100 }
  ];
  const result = simulatePortfolio([
    {
      symbol: "FIRST_OPENUSDT", timeframe: "1h", direction: "LONG",
      distanceRate: 0.1, candles: firstCandles, signalIndex: 0,
      config: { ...config, positionNotional: 700 },
      fundingEvents: [{ fundingTime: 15, rate: 0.02, markPrice: 100 }]
    },
    {
      symbol: "SECOND_ENTRYUSDT", timeframe: "1h", direction: "LONG",
      distanceRate: 0.1, candles: secondCandles, signalIndex: 1,
      config: { ...config, positionNotional: 300 }
    }
  ], { initialCapital: 1_000 });

  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0].symbol, "FIRST_OPENUSDT");
  assert.equal(result.accepted[0].fundingPnl, -14);
  assert.equal(result.skipped.some(item =>
    item.candidate.symbol === "SECOND_ENTRYUSDT"
      && item.reason === "insufficient_available_balance"
  ), true);
  assert.equal(result.capital.accountBalance, 986);
  assert.equal(result.capital.usedCapital, 700);
  assert.equal(result.capital.availableBalance, 286);
  assert.equal(result.capital.events.filter(event =>
    event.type === "open_position_funding"
  ).length, 1);
});


test("later open-position funding cannot alter an earlier losing-exit replenishment", () => {
  const openShortCandles = [
    { openTime: 0, closeTime: 9, open: 102, high: 103, low: 99, close: 100 },
    { openTime: 10, closeTime: 19, open: 100, high: 101, low: 99, close: 100 },
    { openTime: 20, closeTime: 29, open: 100, high: 101, low: 99, close: 100 },
    { openTime: 30, closeTime: 39, open: 100, high: 101, low: 99, close: 100 },
    { openTime: 40, closeTime: 49, open: 100, high: 101, low: 99, close: 100 }
  ];
  const losingLongCandles = [
    { openTime: 0, closeTime: 9, open: 98, high: 101, low: 97, close: 100 },
    { openTime: 10, closeTime: 19, open: 100, high: 101, low: 97, close: 99 },
    { openTime: 20, closeTime: 29, open: 99, high: 100, low: 98, close: 99 }
  ];
  const result = simulatePortfolio([
    {
      symbol: "OPEN_SHORTUSDT", timeframe: "1h", direction: "SHORT",
      distanceRate: 0.1, candles: openShortCandles, signalIndex: 0,
      config,
      fundingEvents: [{ fundingTime: 30, rate: 0.02, markPrice: 100 }]
    },
    {
      symbol: "LOSING_LONGUSDT", timeframe: "1h", direction: "LONG",
      distanceRate: 0.1, candles: losingLongCandles, signalIndex: 0, config
    }
  ], { initialCapital: 1_000 });

  assert.equal(result.accepted.length, 2);
  assert.equal(result.accepted.find(trade => trade.symbol === "LOSING_LONGUSDT").exitTime, 19);
  assert.equal(result.accepted.find(trade => trade.symbol === "OPEN_SHORTUSDT").fundingPnl, 10);
  assert.equal(result.capital.events.find(event => event.type === "loss_replenishment").time, 19);
  assert.equal(result.capital.events.find(event => event.type === "open_position_funding").time, 30);
  assert.equal(result.capital.accountBalance, 1_110);
  const snapshotTypes = result.capital.events.map(event => event.type);
  assert.ok(snapshotTypes.indexOf("loss_replenishment") < snapshotTypes.indexOf("open_position_funding"));
});

test("simultaneous equal-ranked entries use stable symbol order, not input order", () => {
  const candidates = ["B_STABLEUSDT", "A_STABLEUSDT"].map(symbol => ({
    symbol, timeframe: "1h", direction: "LONG", distanceRate: 0.1,
    candles: longCandles(), signalIndex: 0, config
  }));
  for (const ordered of [candidates, [...candidates].reverse()]) {
    const result = simulatePortfolio(ordered, { maxOpenTrades: 1 });
    assert.equal(result.accepted.length, 1);
    assert.equal(result.accepted[0].symbol, "A_STABLEUSDT");
    assert.equal(result.skipped.some(item =>
      item.candidate.symbol === "B_STABLEUSDT" && item.reason === "max_open_trades_reached"
    ), true);
  }
});

test("closed-trade funding is booked at its settlement time before an earlier loss batch", () => {
  const winningShort = [
    { openTime: 0, closeTime: 9, open: 102, high: 103, low: 99, close: 100 },
    { openTime: 10, closeTime: 19, open: 100, high: 101, low: 99, close: 100 },
    { openTime: 20, closeTime: 29, open: 100, high: 101, low: 97, close: 98 }
  ];
  const losingLong = [
    { openTime: 0, closeTime: 9, open: 98, high: 101, low: 97, close: 100 },
    { openTime: 10, closeTime: 19, open: 100, high: 101, low: 97, close: 99 },
    { openTime: 20, closeTime: 29, open: 99, high: 100, low: 98, close: 99 }
  ];
  const result = simulatePortfolio([
    {
      symbol: "A_FUNDING_SHORTUSDT", timeframe: "1h", direction: "SHORT",
      distanceRate: 0.1, candles: winningShort, signalIndex: 0, config,
      fundingEvents: [{ fundingTime: 15, rate: 0.02, markPrice: 100 }]
    },
    {
      symbol: "B_LOSING_LONGUSDT", timeframe: "1h", direction: "LONG",
      distanceRate: 0.1, candles: losingLong, signalIndex: 0, config
    }
  ], { initialCapital: 1_000 });

  const funding = result.capital.events.find(event => event.type === "closed_position_funding");
  const replenishment = result.capital.events.find(event => event.type === "loss_replenishment");
  assert.equal(funding.time, 15);
  assert.equal(replenishment.time, 19);
  assert.ok(funding.time < replenishment.time);
  assert.equal(replenishment.topUp, 100);
  assert.equal(result.capital.accountBalance, 1_110);
});
