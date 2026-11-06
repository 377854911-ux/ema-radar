import { simulateTrade, summarizeBacktest, TIMEFRAME_MS } from "./backtest-engine.js";

/**
 * Schedules independent simulated trades across symbols/timeframes.
 * Each candidate:
 * { symbol, timeframe, direction, distanceRate, candles, signalIndex, config, fundingEvents? }
 *
 * This scheduler enforces fresh-signal timeframe priority, five-position capacity,
 * and the rule that an opposite signal is discarded if an opposing position is
 * open when the signal appears. It does not wait for a slot or reuse stale signals.
 */
export function simulatePortfolio(candidates, options = {}) {
  if (!Array.isArray(candidates)) throw new TypeError("candidates must be an array");
  const maxOpenTrades = options.maxOpenTrades ?? 5;
  const initialCapital = options.initialCapital ?? 10_000;
  if (!Number.isInteger(maxOpenTrades) || maxOpenTrades < 1) throw new RangeError("maxOpenTrades must be a positive integer");
  if (!(Number(initialCapital) > 0)) throw new RangeError("initialCapital must be positive");

  const normalized = candidates.map((candidate, index) => {
    if (!candidate.symbol || !candidate.timeframe) throw new TypeError("each candidate needs symbol and timeframe");
    const signalCandle = candidate.candles?.[candidate.signalIndex];
    if (!signalCandle) return { ...candidate, _index: index, _signalTime: Infinity, _invalid: true };
    return {
      ...candidate,
      _index: index,
      _signalTime: signalCandle.closeTime ?? signalCandle.openTime,
      _timeframeMs: TIMEFRAME_MS[candidate.timeframe] ?? Number.MAX_SAFE_INTEGER
    };
  });

  // If the same symbol signals on multiple timeframes at the same close,
  // keep only the shortest timeframe before any ranking/capacity decision.
  const bySymbolAndSignalTime = new Map();
  for (const candidate of normalized) {
    const key = `${candidate.symbol}:${candidate._signalTime}`;
    const current = bySymbolAndSignalTime.get(key);
    if (!current
      || candidate._timeframeMs < current._timeframeMs
      || (candidate._timeframeMs === current._timeframeMs
        && Number(candidate.distanceRate ?? Infinity) < Number(current.distanceRate ?? Infinity))) {
      bySymbolAndSignalTime.set(key, candidate);
    }
  }

  const prepared = [];
  const skipped = normalized.filter(c => c._invalid).map(c => ({ candidate: c, reason: "missing_signal_candle" }));
  for (const candidate of bySymbolAndSignalTime.values()) {
    if (candidate._invalid) continue;
    const trade = simulateTrade({
      candles: candidate.candles,
      signalIndex: candidate.signalIndex,
      direction: candidate.direction,
      config: candidate.config,
      fundingEvents: candidate.fundingEvents ?? []
    });
    if (trade.status === "unfilled") {
      skipped.push({ candidate, reason: trade.reason, trade });
      continue;
    }
    if (trade.status === "unclassifiable") {
      skipped.push({ candidate, reason: trade.reason, trade });
      continue;
    }
    prepared.push({ candidate, trade });
  }

  prepared.sort((a, b) =>
    a.trade.entryTime - b.trade.entryTime
    || Number(a.candidate.distanceRate ?? Infinity) - Number(b.candidate.distanceRate ?? Infinity)
    || a.candidate._index - b.candidate._index
  );

  const accepted = [];
  for (const item of prepared) {
    const { candidate, trade } = item;
    const openAtSignal = accepted.filter(x =>
      x.trade.entryTime <= candidate._signalTime
      && (x.trade.exitTime == null || x.trade.exitTime > candidate._signalTime)
    );
    const opposite = openAtSignal.find(x =>
      x.candidate.symbol === candidate.symbol
      && x.candidate.direction !== candidate.direction
    );
    if (opposite) {
      skipped.push({ candidate, reason: "opposite_position_open_at_signal", blockedBy: opposite.candidate.symbol });
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
    accepted.push(item);
  }

  const completedTrades = accepted.map(x => ({ ...x.trade, symbol: x.candidate.symbol, timeframe: x.candidate.timeframe, distanceRate: x.candidate.distanceRate }));
  const summary = summarizeBacktest(completedTrades, initialCapital);
  return {
    accepted: completedTrades,
    skipped,
    summary,
    maxOpenTrades,
    initialCapital
  };
}
