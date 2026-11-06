import { simulateTrade, summarizeBacktest, TIMEFRAME_MS } from "./backtest-engine.js";

/**
 * Schedules historical trades and simulated account capital.
 * Candidate shape:
 * { symbol, timeframe, direction, distanceRate, candles, signalIndex, config, fundingEvents? }
 *
 * No signal is queued after capacity/opposite-direction rejection.
 */
export function simulatePortfolio(candidates, options = {}) {
  if (!Array.isArray(candidates)) throw new TypeError("candidates must be an array");
  const maxOpenTrades = options.maxOpenTrades ?? 5;
  const initialCapital = Number(options.initialCapital ?? 10_000);
  if (!Number.isInteger(maxOpenTrades) || maxOpenTrades < 1) throw new RangeError("maxOpenTrades must be a positive integer");
  if (!Number.isFinite(initialCapital) || initialCapital <= 0) throw new RangeError("initialCapital must be positive");

  const normalized = candidates.map((candidate, index) => {
    if (!candidate.symbol || !candidate.timeframe) throw new TypeError("each candidate needs symbol and timeframe");
    const candle = candidate.candles?.[candidate.signalIndex];
    if (!candle) return { ...candidate, _index: index, _signalTime: Infinity, _invalid: true };
    return {
      ...candidate,
      _index: index,
      _signalTime: candle.closeTime ?? candle.openTime,
      _timeframeMs: TIMEFRAME_MS[candidate.timeframe] ?? Number.MAX_SAFE_INTEGER
    };
  });

  // For a same-symbol, same-close opportunity, the shortest timeframe wins.
  const grouped = new Map();
  for (const candidate of normalized.filter(c => !c._invalid)) {
    const key = `${candidate.symbol}:${candidate._signalTime}`;
    const group = grouped.get(key) ?? [];
    group.push(candidate);
    grouped.set(key, group);
  }
  const selected = [];
  const skipped = normalized.filter(c => c._invalid).map(candidate => ({ candidate, reason: "missing_signal_candle" }));
  for (const group of grouped.values()) {
    group.sort((a, b) =>
      a._timeframeMs - b._timeframeMs
      || Number(a.distanceRate ?? Infinity) - Number(b.distanceRate ?? Infinity)
      || a._index - b._index
    );
    selected.push(group[0]);
    for (const ignored of group.slice(1)) {
      skipped.push({ candidate: ignored, reason: "longer_timeframe_same_signal_ignored" });
    }
  }

  const prepared = [];
  for (const candidate of selected) {
    const trade = simulateTrade({
      candles: candidate.candles,
      signalIndex: candidate.signalIndex,
      direction: candidate.direction,
      config: candidate.config,
      fundingEvents: candidate.fundingEvents ?? []
    });
    if (trade.status === "unfilled" || trade.status === "unclassifiable") {
      skipped.push({ candidate, reason: trade.reason, trade });
    } else {
      prepared.push({ candidate, trade, settled: false });
    }
  }

  prepared.sort((a, b) =>
    a.trade.entryTime - b.trade.entryTime
    || Number(a.candidate.distanceRate ?? Infinity) - Number(b.candidate.distanceRate ?? Infinity)
    || a.candidate._index - b.candidate._index
  );

  const accepted = [];
  const settled = new Set();
  let accountBalance = initialCapital;
  let usedCapital = 0;
  let cumulativeTopUps = 0;
  let lossStreak = 0;
  let capitalAccountingComplete = true;
  const capitalEvents = [];

  function settleUntil(timestamp) {
    const due = accepted
      .filter(item => !settled.has(item) && item.trade.exitTime != null && item.trade.exitTime <= timestamp)
      .sort((a, b) => a.trade.exitTime - b.trade.exitTime || a.candidate._index - b.candidate._index);
    for (const item of due) {
      settled.add(item);
      usedCapital = Math.max(0, usedCapital - item.trade.notional);
      if (item.trade.status !== "closed" || !Number.isFinite(item.trade.netPnl)) {
        // Unknown funding means we cannot safely calculate account capital or loss streak.
        capitalAccountingComplete = false;
        capitalEvents.push({
          time: item.trade.exitTime,
          symbol: item.candidate.symbol,
          type: "incomplete_trade",
          reason: item.trade.reason ?? "unclassifiable_trade"
        });
        continue;
      }

      // Entry fee was deducted when the position opened. Settle gross PnL,
      // exit fee and known funding now; the combined lifetime change equals netPnl.
      accountBalance += item.trade.grossPnl - item.trade.exitFee + item.trade.fundingPnl;
      if (item.trade.netPnl < 0) {
        lossStreak += 1;
        const bonusPct = Math.min(lossStreak, 5) * 10;
        const restoreAmount = Math.max(0, initialCapital - accountBalance);
        const bonusAmount = initialCapital * bonusPct / 100;
        const topUp = restoreAmount + bonusAmount;
        accountBalance += topUp;
        cumulativeTopUps += topUp;
        capitalEvents.push({
          time: item.trade.exitTime,
          symbol: item.candidate.symbol,
          type: "loss_replenishment",
          lossStreak,
          restoreAmount,
          bonusAmount,
          topUp,
          accountBalance
        });
      } else {
        lossStreak = 0;
        capitalEvents.push({
          time: item.trade.exitTime,
          symbol: item.candidate.symbol,
          type: "trade_closed",
          netPnl: item.trade.netPnl,
          lossStreak
        });
      }
    }
  }

  for (const item of prepared) {
    const { candidate, trade } = item;
    settleUntil(trade.entryTime);

    if (!capitalAccountingComplete) {
      skipped.push({ candidate, reason: "capital_path_incomplete_due_to_missing_funding" });
      continue;
    }

    // Opposite direction is blocked if a position was open at signal time,
    // even if that position closes before a later limit order could fill.
    const opposite = accepted.find(x =>
      x.candidate.symbol === candidate.symbol
      && x.candidate.direction !== candidate.direction
      && x.trade.entryTime <= candidate._signalTime
      && (x.trade.exitTime == null || x.trade.exitTime > candidate._signalTime)
    );
    if (opposite) {
      skipped.push({ candidate, reason: "opposite_position_open_at_signal" });
      continue;
    }

    const openAtEntry = accepted.filter(x =>
      x.trade.entryTime <= trade.entryTime
      && (x.trade.exitTime == null || x.trade.exitTime > trade.entryTime)
    );
    if (openAtEntry.length >= maxOpenTrades) {
      skipped.push({ candidate, reason: "max_open_trades_reached" });
      continue;
    }

    const entryFee = Number(trade.entryFee ?? 0);
    if (accountBalance - usedCapital - trade.notional - entryFee < 0) {
      skipped.push({ candidate, reason: "insufficient_available_balance" });
      continue;
    }

    accountBalance -= entryFee;
    usedCapital += trade.notional;
    accepted.push(item);
  }

  settleUntil(Infinity);

  const completedTrades = accepted.map(x => ({
    ...x.trade,
    symbol: x.candidate.symbol,
    timeframe: x.candidate.timeframe,
    distanceRate: x.candidate.distanceRate
  }));
  const summary = summarizeBacktest(completedTrades, initialCapital);
  summary.totalCapitalReplenished = cumulativeTopUps;
  summary.capitalAccountingComplete = capitalAccountingComplete;

  return {
    accepted: completedTrades,
    skipped,
    summary,
    capital: {
      accountBalance: capitalAccountingComplete ? accountBalance : null,
      usedCapital,
      availableBalance: capitalAccountingComplete ? accountBalance - usedCapital : null,
      cumulativeTopUps,
      consecutiveLosses: lossStreak,
      capitalAccountingComplete,
      events: capitalEvents
    },
    maxOpenTrades,
    initialCapital
  };
}
