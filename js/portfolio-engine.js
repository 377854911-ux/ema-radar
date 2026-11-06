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
    const directions = new Set(group.map(candidate => candidate.direction));
    if (directions.size > 1) {
      // Conflicting long/short signals at the same symbol/time are ambiguous.
      // Reject the whole group instead of letting input order choose a side.
      for (const conflicting of group) {
        skipped.push({ candidate: conflicting, reason: "conflicting_directions_same_signal_time" });
      }
      continue;
    }
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
    // Stable tie-breaks prevent selected timeframe/object order from changing
    // which simultaneous opportunity gets scarce portfolio capacity.
    || a.candidate.symbol.localeCompare(b.candidate.symbol)
    || a.candidate._timeframeMs - b.candidate._timeframeMs
    || String(a.candidate.direction).localeCompare(String(b.candidate.direction))
    || a.candidate._index - b.candidate._index
  );

  const accepted = [];
  const settled = new Set();
  let accountBalance = initialCapital;
  let usedCapital = 0;
  let cumulativeTopUps = 0;
  let actualCashInjected = 0;
  let actualCashWithdrawn = 0;
  let lossStreak = 0;
  let capitalAccountingComplete = true;
  const capitalEvents = [];
  // Cash-balance snapshots follow actual cash-flow timing. Unrealized PnL is
  // excluded, while entry fees are reflected as soon as the position opens.
  const equitySnapshots = [{ time: -Infinity, balance: initialCapital, type: "initial" }];

  function applyFundingUntil(timestamp) {
    const dueEvents = [];
    for (const item of accepted) {
      if (item.trade.fundingComplete !== true) {
        capitalAccountingComplete = false;
        continue;
      }
      const events = item._fundingEvents ?? [];
      while (item._fundingCursor < events.length
          && events[item._fundingCursor].fundingTime <= timestamp) {
        dueEvents.push({ ...events[item._fundingCursor++], item });
      }
    }
    dueEvents.sort((a, b) =>
      a.fundingTime - b.fundingTime
      || a.item.candidate.symbol.localeCompare(b.item.candidate.symbol)
    );

    // All settlements at the same timestamp are one cash-flow batch. This
    // keeps the equity path independent of candidate/input order.
    let cursor = 0;
    while (cursor < dueEvents.length) {
      const fundingTime = dueEvents[cursor].fundingTime;
      const batch = [];
      while (cursor < dueEvents.length && dueEvents[cursor].fundingTime === fundingTime) {
        batch.push(dueEvents[cursor++]);
      }
      accountBalance += batch.reduce((sum, event) => sum + event.amount, 0);
      equitySnapshots.push({
        time: fundingTime,
        balance: accountBalance,
        type: "funding_settlement_batch"
      });
      for (const event of batch) {
        capitalEvents.push({
          time: fundingTime,
          symbol: event.item.candidate.symbol,
          type: event.item.trade.exitTime == null
            ? "open_position_funding" : "closed_position_funding",
          fundingPnl: event.amount
        });
      }
    }
  }

  function settleUntil(timestamp) {
    const due = accepted
      .filter(item => !settled.has(item) && item.trade.exitTime != null && item.trade.exitTime <= timestamp)
      .sort((a, b) => a.trade.exitTime - b.trade.exitTime || a.candidate._index - b.candidate._index);

    // Process funding and exits in timestamp order. Funding at an exit's
    // timestamp is applied before that timestamp's settlement batch.
    let cursor = 0;
    while (cursor < due.length) {
      const exitTime = due[cursor].trade.exitTime;
      applyFundingUntil(exitTime);
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
        accountBalance += item.trade.grossPnl - item.trade.exitFee;
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
      if (batchIncomplete || !batchHasClassifiableOutcome || !capitalAccountingComplete) continue;

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
          type: "capital_replenishment_batch",
          externalFlow: topUp - normalizationWithdrawal
        });
        actualCashInjected += topUp;
        actualCashWithdrawn += normalizationWithdrawal;
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
    // Include later funding cash flows only after all earlier exit batches
    // have been settled, so they cannot distort earlier replenishment logic.
    applyFundingUntil(timestamp);
  }

  for (const item of prepared) {
    const { candidate, trade } = item;
    settleUntil(trade.entryTime);

    if (!capitalAccountingComplete) {
      skipped.push({ candidate, reason: "capital_path_incomplete_due_to_missing_funding" });
      continue;
    }

    // A symbol may have only one open position at a time, regardless of
    // direction or timeframe. A new signal is allowed after the prior trade exits.
    const existingSymbolPosition = accepted.find(x =>
      x.candidate.symbol === candidate.symbol
      && x.trade.entryTime <= trade.entryTime
      && (x.trade.exitTime == null || x.trade.exitTime > trade.entryTime)
    );
    if (existingSymbolPosition) {
      skipped.push({ candidate, reason: "symbol_already_has_open_position" });
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
    item._fundingEvents = trade.fundingComplete === true
      ? [...(trade.fundingEvents ?? [])].sort((a, b) => a.fundingTime - b.fundingTime)
      : [];
    item._fundingCursor = 0;
    if (trade.fundingComplete !== true || !Number.isFinite(trade.fundingPnl)) {
      capitalAccountingComplete = false;
      capitalEvents.push({
        time: trade.asOfTime ?? trade.exitTime ?? null,
        symbol: candidate.symbol,
        type: trade.exitTime == null
          ? "open_position_funding_incomplete"
          : "closed_position_funding_incomplete"
      });
    }
    accepted.push(item);
  }

  settleUntil(Infinity);

  // Flush funding settlements for all remaining open positions at the end
  // of the simulated timeline. Unrealized price PnL remains excluded.
  applyFundingUntil(Infinity);

  const completedTrades = accepted.map(x => ({
    ...x.trade,
    symbol: x.candidate.symbol,
    timeframe: x.candidate.timeframe,
    distanceRate: x.candidate.distanceRate
  }));
  // Calculate flow-adjusted, mark-to-market equity. Deposits and withdrawals
  // change cash but are removed from the performance series, so neither can
  // create or erase a drawdown. Open positions are marked to the latest candle
  // close available at each timestamp, less an estimated liquidation fee.
  const realizedInExitOrder = [...completedTrades]
    .filter(trade => trade.exitTime != null)
    .sort((a, b) => a.exitTime - b.exitTime);
  const summary = summarizeBacktest(realizedInExitOrder, initialCapital);
  let equityCurve = [];
  if (capitalAccountingComplete) {
    const cashEvents = equitySnapshots
      .map((event, index) => ({ ...event, _order: index }))
      .filter(event => Number.isFinite(event.time))
      .sort((a, b) => a.time - b.time || a._order - b._order);
    const timestamps = new Set(cashEvents.map(event => event.time));
    for (const item of accepted) {
      const candles = item.candidate.candles;
      for (let i = item.trade.entryIndex; i < candles.length; i++) {
        const candle = candles[i];
        const closeTime = candle.closeTime ?? candle.openTime;
        if (closeTime >= item.trade.entryTime
            && (item.trade.exitTime == null || closeTime < item.trade.exitTime)) {
          timestamps.add(closeTime);
        }
      }
    }

    let cashBalance = initialCapital;
    let netExternalFlows = 0;
    let cashCursor = 0;
    let peak = initialCapital;
    let maxDrawdown = 0;
    for (const time of [...timestamps].sort((a, b) => a - b)) {
      while (cashCursor < cashEvents.length && cashEvents[cashCursor].time <= time) {
        const event = cashEvents[cashCursor++];
        cashBalance = event.balance;
        netExternalFlows += Number(event.externalFlow ?? 0);
      }

      let unrealizedPnl = 0;
      for (const item of accepted) {
        const trade = item.trade;
        if (trade.entryTime > time || (trade.exitTime != null && trade.exitTime <= time)) continue;
        const candles = item.candidate.candles;
        let markPrice = trade.entryPrice;
        for (let i = trade.entryIndex; i < candles.length; i++) {
          const candle = candles[i];
          const closeTime = candle.closeTime ?? candle.openTime;
          if (closeTime > time || closeTime >= (trade.exitTime ?? Infinity)) break;
          markPrice = candle.close;
        }
        const directionSign = trade.direction === "LONG" ? 1 : -1;
        const grossUnrealized = directionSign
          * (markPrice - trade.entryPrice) * trade.notional / trade.entryPrice;
        const estimatedExitFee = trade.notional * markPrice / trade.entryPrice
          * Number(item.candidate.config?.exitFeeRate ?? 0) / 100;
        unrealizedPnl += grossUnrealized - estimatedExitFee;
      }

      const adjustedEquity = cashBalance + unrealizedPnl - netExternalFlows;
      equityCurve.push({
        time,
        cashBalance,
        unrealizedPnl,
        netExternalFlows,
        adjustedEquity
      });
      peak = Math.max(peak, adjustedEquity);
      if (peak > 0) {
        maxDrawdown = Math.max(maxDrawdown, (peak - adjustedEquity) / peak * 100);
      }
    }
    summary.maxDrawdownPct = maxDrawdown;
    summary.maxDrawdownBasis = "flow_adjusted_bar_close_mark_to_market_equity";
  } else {
    // Incomplete funding makes both cash and mark-to-market equity uncertain.
    summary.maxDrawdownPct = null;
    summary.maxDrawdownBasis = "unavailable_incomplete_funding";
  }
  summary.totalCapitalReplenished = cumulativeTopUps;
  summary.capitalAccountingComplete = capitalAccountingComplete;

  return {
    accepted: completedTrades,
    skipped,
    summary,
    equityCurve,
    capital: {
      accountBalance: capitalAccountingComplete ? accountBalance : null,
      usedCapital,
      availableBalance: capitalAccountingComplete ? accountBalance - usedCapital : null,
      cumulativeTopUps,
      actualCashInjected,
      actualCashWithdrawn,
      consecutiveLosses: lossStreak,
      capitalAccountingComplete,
      events: capitalEvents
    },
    maxOpenTrades,
    initialCapital
  };
}
