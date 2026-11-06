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
  let actualCashInjected = 0;
  let lossStreak = 0;
  let capitalAccountingComplete = true;
  const capitalEvents = [];
  // Cash-balance snapshots follow actual cash-flow timing. Unrealized PnL is
  // excluded, while entry fees are reflected as soon as the position opens.
  const equitySnapshots = [{ time: -Infinity, balance: initialCapital, type: "initial" }];

  function settleUntil(timestamp) {
    const due = accepted
      .filter(item => !settled.has(item) && item.trade.exitTime != null && item.trade.exitTime <= timestamp)
      .sort((a, b) => a.trade.exitTime - b.trade.exitTime || a.candidate._index - b.candidate._index);

    // All trades closing at the same timestamp form one settlement batch.
    // This prevents candidate ordering from changing the loss-streak/top-up logic.
    let cursor = 0;
    while (cursor < due.length) {
      const exitTime = due[cursor].trade.exitTime;
      const batch = [];
      while (cursor < due.length && due[cursor].trade.exitTime === exitTime) {
        const item = due[cursor++];
        settled.add(item);
        batch.push(item);
      }

      let batchNetPnl = 0;
      let batchHasClassifiableOutcome = false;
      let batchHasAmbiguous = false;
      let batchIncomplete = false;

      for (const item of batch) {
        usedCapital = Math.max(0, usedCapital - item.trade.notional);
        if (item.trade.status !== "closed" || !Number.isFinite(item.trade.netPnl)) {
          // Unknown funding means we cannot safely calculate account capital or loss streak.
          capitalAccountingComplete = false;
          batchIncomplete = true;
          capitalEvents.push({
            time: exitTime,
            symbol: item.candidate.symbol,
            type: "incomplete_trade",
            reason: item.trade.reason ?? "unclassifiable_trade"
          });
          continue;
        }

        // Entry fee was deducted when the position opened. Apply each known
        // settlement cash flow, but make the streak decision once per timestamp.
        accountBalance += item.trade.grossPnl - item.trade.exitFee + item.trade.fundingPnl;
        if (item.trade.exitReason === "ambiguous_both_touched") {
          batchHasAmbiguous = true;
          capitalEvents.push({
            time: exitTime,
            symbol: item.candidate.symbol,
            type: "ambiguous_trade",
            netPnl: item.trade.netPnl,
            lossStreak
          });
          continue;
        }
        batchNetPnl += item.trade.netPnl;
        batchHasClassifiableOutcome = true;
      }

      if (batch.some(item => item.trade.status === "closed" && Number.isFinite(item.trade.netPnl))) {
        equitySnapshots.push({
          time: exitTime,
          balance: accountBalance,
          type: "trade_settlement_batch"
        });
      }

      // Do not make a partial streak decision when any trade in this timestamp
      // has unknown cash flows. Ambiguous trades are excluded from the batch PnL.
      if (batchIncomplete || !batchHasClassifiableOutcome) continue;

      if (batchNetPnl < 0) {
        lossStreak += 1;
        const bonusPct = Math.min(lossStreak, 5) * 10;
        const restoreAdjustment = initialCapital - accountBalance;
        const bonusAmount = initialCapital * bonusPct / 100;
        const targetBalance = initialCapital + bonusAmount;
        const netAdjustment = targetBalance - accountBalance;
        const topUp = Math.max(0, netAdjustment);
        const normalizationWithdrawal = Math.max(0, -netAdjustment);
        accountBalance = targetBalance;
        equitySnapshots.push({
          time: exitTime,
          balance: accountBalance,
          type: "capital_replenishment_batch"
        });
        actualCashInjected += topUp;
        cumulativeTopUps += Math.max(0, restoreAdjustment) + bonusAmount;
        capitalEvents.push({
          time: exitTime,
          symbols: batch.filter(item => item.trade.status === "closed" && Number.isFinite(item.trade.netPnl))
            .map(item => item.candidate.symbol),
          type: "loss_replenishment",
          batch: true,
          batchNetPnl,
          lossStreak,
          restoreAdjustment,
          bonusAmount,
          topUp,
          normalizationWithdrawal,
          targetBalance,
          accountBalance
        });
      } else if (batchNetPnl > 0) {
        lossStreak = 0;
        capitalEvents.push({
          time: exitTime,
          symbols: batch.filter(item => item.trade.status === "closed" && Number.isFinite(item.trade.netPnl))
            .map(item => item.candidate.symbol),
          type: "trade_closed",
          batch: true,
          batchNetPnl,
          ambiguousTradesExcluded: batchHasAmbiguous,
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
      && (
        (x.trade.entryTime <= candidate._signalTime
          && (x.trade.exitTime == null || x.trade.exitTime > candidate._signalTime))
        || (x.trade.entryTime <= trade.entryTime
          && (x.trade.exitTime == null || x.trade.exitTime > trade.entryTime))
      )
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
    equitySnapshots.push({
      time: trade.entryTime,
      balance: accountBalance,
      type: "entry_fee"
    });
    usedCapital += trade.notional;
    accepted.push(item);
  }

  settleUntil(Infinity);

  // Positions still open at the end of the downloaded history keep their
  // notional reserved. Apply only known funding cash flows through the final
  // candle; do not mark unrealized price PnL as realized account profit.
  for (const item of accepted.filter(x => x.trade.exitTime == null)) {
    const trade = item.trade;
    if (trade.fundingComplete !== true || !Number.isFinite(trade.fundingPnl)) {
      capitalAccountingComplete = false;
      capitalEvents.push({
        time: trade.asOfTime ?? null,
        symbol: item.candidate.symbol,
        type: "open_position_funding_incomplete"
      });
      continue;
    }
    accountBalance += trade.fundingPnl;
    equitySnapshots.push({
      time: trade.asOfTime ?? Infinity,
      balance: accountBalance,
      type: "open_position_funding"
    });
    capitalEvents.push({
      time: trade.asOfTime ?? null,
      symbol: item.candidate.symbol,
      type: "open_position_funding",
      fundingPnl: trade.fundingPnl
    });
  }

  const completedTrades = accepted.map(x => ({
    ...x.trade,
    symbol: x.candidate.symbol,
    timeframe: x.candidate.timeframe,
    distanceRate: x.candidate.distanceRate
  }));
  // Compute equity drawdown in realized exit chronology, not entry order.
  const realizedInExitOrder = [...completedTrades]
    .filter(trade => trade.exitTime != null)
    .sort((a, b) => a.exitTime - b.exitTime);
  const summary = summarizeBacktest(realizedInExitOrder, initialCapital);
  if (capitalAccountingComplete) {
    let peak = initialCapital;
    let maxDrawdown = 0;
    for (const event of equitySnapshots) {
      peak = Math.max(peak, event.balance);
      if (peak > 0) {
        maxDrawdown = Math.max(maxDrawdown, (peak - event.balance) / peak * 100);
      }
    }
    summary.maxDrawdownPct = maxDrawdown;
  } else {
    // Incomplete funding makes the final cash path unknowable.
    summary.maxDrawdownPct = null;
  }
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
      actualCashInjected,
      consecutiveLosses: lossStreak,
      capitalAccountingComplete,
      events: capitalEvents
    },
    maxOpenTrades,
    initialCapital
  };
}
