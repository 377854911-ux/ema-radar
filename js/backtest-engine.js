/**
 * Deterministic, single-position backtest execution engine.
 * Input candles must be chronological closed OHLC objects:
 * { openTime, closeTime, open, high, low, close }.
 *
 * This module never fetches data and never supplies fee/slippage defaults.
 */
const TIMEFRAME_MS = {
  "15m": 900_000, "30m": 1_800_000,
  "1h": 3_600_000, "2h": 7_200_000, "4h": 14_400_000,
  "6h": 21_600_000, "8h": 28_800_000, "12h": 43_200_000,
  "1d": 86_400_000
};

function num(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new TypeError(`${name} must be a finite number`);
  return n;
}
function positive(value, name) {
  const n = num(value, name);
  if (n <= 0) throw new RangeError(`${name} must be greater than zero`);
  return n;
}
function validateCandles(candles) {
  if (!Array.isArray(candles) || candles.length === 0) throw new TypeError("candles must be a non-empty array");
  let previous = -Infinity;
  for (const [i, c] of candles.entries()) {
    for (const k of ["open", "high", "low", "close"]) positive(c[k], `candles[${i}].${k}`);
    if (c.high < Math.max(c.open, c.close, c.low) || c.low > Math.min(c.open, c.close, c.high)) {
      throw new RangeError(`candles[${i}] has invalid OHLC values`);
    }
    const t = num(c.openTime, `candles[${i}].openTime`);
    if (t <= previous) throw new RangeError("candles must be strictly chronological");
    previous = t;
  }
}
function adversePrice(price, direction, rate, isEntry) {
  const r = num(rate, "slippageRate") / 100;
  if (r < 0) throw new RangeError("slippageRate cannot be negative");
  if (direction === "LONG") return price * (isEntry ? 1 + r : 1 - r);
  return price * (isEntry ? 1 - r : 1 + r);
}
function fee(notional, rate) {
  const r = num(rate, "feeRate") / 100;
  if (r < 0) throw new RangeError("feeRate cannot be negative");
  return notional * r;
}

/**
 * Simulates one candidate signal. The caller/portfolio layer is responsible
 * for selecting historical top-100 symbols, signal freshness and concurrency.
 *
 * Required config:
 * entryMethod: "signal_close" | "next_open" | "retracement_limit"
 * retracementPct (1..50 integer) for limit entry
 * limitValidityBars (positive integer) for limit entry
 * hardStopPct (1..20 integer)
 * auxiliaryStop: "signal_extreme" | "signal_open"
 * rr (1..5, one decimal increment)
 * positionNotional, entryFeeRate, exitFeeRate, entrySlippageRate, slippageRate
 * timeoutBars: null or integer 1..9
 */
export function simulateTrade({ candles, signalIndex, direction, config, fundingEvents = [] }) {
  validateCandles(candles);
  if (!config || typeof config !== "object") throw new TypeError("config is required");
  if (!["LONG", "SHORT"].includes(direction)) throw new RangeError("direction must be LONG or SHORT");
  if (!Number.isInteger(signalIndex) || signalIndex < 0 || signalIndex >= candles.length - 1) {
    return { status: "unfilled", reason: "signal_or_next_candle_missing" };
  }

  const hardStopPct = num(config.hardStopPct, "hardStopPct");
  if (!Number.isInteger(hardStopPct) || hardStopPct < 1 || hardStopPct > 20) throw new RangeError("hardStopPct must be an integer from 1 to 20");
  const rr = num(config.rr, "rr");
  if (rr < 1 || rr > 5 || Math.abs(rr * 10 - Math.round(rr * 10)) > 1e-8) throw new RangeError("rr must be 1.0 to 5.0 in 0.1 steps");
  const notional = positive(config.positionNotional, "positionNotional");
  const timeoutBars = config.timeoutBars ?? null;
  if (timeoutBars !== null && (!Number.isInteger(timeoutBars) || timeoutBars < 1 || timeoutBars > 9)) throw new RangeError("timeoutBars must be null or an integer from 1 to 9");
  if (!["signal_close", "next_open", "retracement_limit"].includes(config.entryMethod)) throw new RangeError("invalid entryMethod");
  if (!["signal_extreme", "signal_open"].includes(config.auxiliaryStop)) throw new RangeError("invalid auxiliaryStop");
  const signal = candles[signalIndex];
  const bullish = signal.close > signal.open;
  const bearish = signal.close < signal.open;
  if ((direction === "LONG" && !bullish) || (direction === "SHORT" && !bearish)) {
    return { status: "unclassifiable", reason: "signal_candle_direction_mismatch" };
  }

  let entryIndex = -1;
  let rawEntry = null;
  if (config.entryMethod === "signal_close") {
    entryIndex = signalIndex;
    rawEntry = signal.close;
  } else if (config.entryMethod === "next_open") {
    entryIndex = signalIndex + 1;
    rawEntry = candles[entryIndex].open;
  } else {
    const pct = num(config.retracementPct, "retracementPct");
    const validBars = num(config.limitValidityBars, "limitValidityBars");
    if (!Number.isInteger(pct) || pct < 1 || pct > 50) throw new RangeError("retracementPct must be an integer from 1 to 50");
    if (!Number.isInteger(validBars) || validBars < 1) throw new RangeError("limitValidityBars must be a positive integer");
    rawEntry = direction === "LONG"
      ? signal.close - (signal.close - signal.open) * pct / 100
      : signal.close + (signal.open - signal.close) * pct / 100;
    const last = Math.min(candles.length - 1, signalIndex + validBars);
    for (let i = signalIndex + 1; i <= last; i++) {
      const c = candles[i];
      if (c.low <= rawEntry && c.high >= rawEntry) { entryIndex = i; break; }
    }
    if (entryIndex < 0) return { status: "unfilled", reason: "limit_not_filled_within_validity" };
  }

  const entrySlippageRate = num(config.entrySlippageRate, "entrySlippageRate");
  const slippageRate = num(config.slippageRate, "slippageRate");
  // A resting limit order receives price improvement when the market opens
  // through the limit: buy at the lower open, sell at the higher open.
  const limitFillPrice = config.entryMethod === "retracement_limit"
    ? (direction === "LONG"
        ? Math.min(rawEntry, candles[entryIndex].open)
        : Math.max(rawEntry, candles[entryIndex].open))
    : rawEntry;
  const entryPrice = config.entryMethod === "retracement_limit"
    ? limitFillPrice
    : adversePrice(rawEntry, direction, entrySlippageRate, true);
  if (entryPrice <= 0) throw new RangeError("calculated entry price must be positive");

  const hardStop = direction === "LONG"
    ? entryPrice * (1 - hardStopPct / 100)
    : entryPrice * (1 + hardStopPct / 100);
  const auxiliaryStop = config.auxiliaryStop === "signal_extreme"
    ? (direction === "LONG" ? signal.low : signal.high)
    : signal.open;
  if (!(auxiliaryStop > 0)) throw new RangeError("auxiliary stop must be positive");
  const stopLevels = [hardStop, auxiliaryStop];
  // The furthest active stop defines risk for the RR target; either stop can exit first.
  const riskDistance = direction === "LONG"
    ? entryPrice - Math.min(...stopLevels)
    : Math.max(...stopLevels) - entryPrice;
  if (!(riskDistance > 0) || (direction === "LONG" && auxiliaryStop >= entryPrice) || (direction === "SHORT" && auxiliaryStop <= entryPrice)) {
    return { status: "unclassifiable", reason: "auxiliary_stop_not_beyond_entry" };
  }
  const takeProfit = direction === "LONG" ? entryPrice + riskDistance * rr : entryPrice - riskDistance * rr;
  if (takeProfit <= 0) return { status: "unclassifiable", reason: "invalid_take_profit" };

  const entryTime = config.entryMethod === "signal_close"
    ? (signal.closeTime ?? signal.openTime)
    : candles[entryIndex].openTime;
  const entryFee = fee(notional, config.entryFeeRate);
  let exit = null;
  let countedBars = 0;
  const firstEvaluation = config.entryMethod === "signal_close" ? entryIndex + 1 : entryIndex;

  for (let i = firstEvaluation; i < candles.length; i++) {
    const c = candles[i];
    const stopTouched = direction === "LONG"
      ? stopLevels.some(level => c.low <= level)
      : stopLevels.some(level => c.high >= level);
    const tpTouched = direction === "LONG" ? c.high >= takeProfit : c.low <= takeProfit;
    // A stop crossed by the candle open is already triggered at the open;
    // later movement through the target cannot make the order ambiguous.
    const stopGappedAtOpen = stopLevels.some(level =>
      direction === "LONG" ? c.open <= level : c.open >= level
    );
    // A take-profit crossed by the candle open is reached before any later
    // intrabar movement. A limit TP receives the favorable opening price.
    const takeProfitGappedAtOpen = direction === "LONG"
      ? c.open >= takeProfit
      : c.open <= takeProfit;

    const targetCanBeEvaluated = !(config.entryMethod === "retracement_limit" && i === entryIndex);
    if (stopTouched && tpTouched && targetCanBeEvaluated
        && !stopGappedAtOpen && !takeProfitGappedAtOpen) {
      // OHLC data cannot reveal which level was reached first. Per user rule,
      // offset the gross outcome to zero; entry/exit fees and funding still apply.
      exit = {
        index: i,
        reason: "ambiguous_both_touched",
        rawPrice: entryPrice,
        price: entryPrice,
        time: c.closeTime ?? c.openTime
      };
      break;
    }
    if (stopTouched && !takeProfitGappedAtOpen) {
      const touchedStops = stopLevels.filter(level =>
        direction === "LONG" ? c.low <= level : c.high >= level
      );
      const stopLevel = direction === "LONG" ? Math.min(...touchedStops) : Math.max(...touchedStops);
      // If the candle opens beyond an active stop, the stop cannot fill at
      // its trigger level. Use the worse opening price before applying slippage.
      const rawStop = direction === "LONG"
        ? Math.min(stopLevel, c.open)
        : Math.max(stopLevel, c.open);
      exit = { index: i, reason: "stop_loss", rawPrice: rawStop, price: adversePrice(rawStop, direction, slippageRate, false), time: c.closeTime ?? c.openTime };
      break;
    }
    if (tpTouched && targetCanBeEvaluated) {
      const takeProfitFill = takeProfitGappedAtOpen ? c.open : takeProfit;
      exit = {
        index: i, reason: "take_profit",
        rawPrice: takeProfitFill, price: takeProfitFill,
        time: c.closeTime ?? c.openTime
      };
      break;
    }

    if (timeoutBars !== null) {
      countedBars += 1;
      if (countedBars >= timeoutBars) {
        exit = { index: i, reason: "timeout", rawPrice: c.close, price: adversePrice(c.close, direction, slippageRate, false), time: c.closeTime ?? c.openTime };
        break;
      }
    }
  }

  if (!exit) return {
    status: "open", reason: "insufficient_future_candles", direction, entryIndex, entryTime, entryPrice, notional, entryFee, hardStop, auxiliaryStop, takeProfit, exitTime: null
  };

  const exitNotional = notional * exit.price / entryPrice;
  const exitFee = fee(exitNotional, config.exitFeeRate);
  const grossPnl = direction === "LONG"
    ? notional * (exit.price - entryPrice) / entryPrice
    : notional * (entryPrice - exit.price) / entryPrice;
  const relevantFunding = [];
  let fundingComplete = true;
  let fundingPnl = 0;
  for (const event of fundingEvents) {
    const time = num(event.fundingTime, "fundingTime");
    if (time >= entryTime && time <= exit.time) {
      const entryBar = candles[entryIndex];
      const exitBar = candles[exit.index];
      const uncertainEntryTimestamp = time === entryTime;
      const uncertainLimitEntry = config.entryMethod === "retracement_limit"
        && time > entryBar.openTime && time <= (entryBar.closeTime ?? entryBar.openTime);
      const uncertainExitTimestamp = time === exit.time;
      const uncertainIntrabarExit = exit.reason !== "timeout"
        && time > exitBar.openTime && time <= (exitBar.closeTime ?? exitBar.openTime);
      if (uncertainEntryTimestamp || uncertainLimitEntry
          || uncertainExitTimestamp || uncertainIntrabarExit) {
        fundingComplete = false;
        continue;
      }
      if (event.rate === null || event.rate === undefined || !Number.isFinite(Number(event.rate))
          || event.markPrice === null || event.markPrice === undefined || !(Number(event.markPrice) > 0)) {
        fundingComplete = false;
      } else {
        const rate = Number(event.rate);
        const markPrice = Number(event.markPrice);
        const positionValueAtFunding = notional * markPrice / entryPrice;
        // Positive funding: longs pay shorts; negative funding: shorts pay longs.
        const payment = direction === "LONG" ? -positionValueAtFunding * rate : positionValueAtFunding * rate;
        fundingPnl += payment;
        relevantFunding.push({ fundingTime: time, rate, markPrice, amount: payment });
      }
    }
  }
  const netPnl = grossPnl - entryFee - exitFee + fundingPnl;
  return {
    status: fundingComplete ? "closed" : "incomplete",
    reason: fundingComplete ? null : "missing_or_ambiguous_funding_data",
    direction, entryMethod: config.entryMethod,
    entryIndex, entryTime, entryPrice, notional,
    hardStop, auxiliaryStop, takeProfit, rr,
    exitIndex: exit.index, exitTime: exit.time,
    exitReason: exit.reason, exitPrice: exit.price,
    grossPnl, entryFee, exitFee, fundingPnl, fundingEvents: relevantFunding,
    netPnl: fundingComplete ? netPnl : null,
    fundingComplete,
    conservativeIntrabarRule: exit.reason === "ambiguous_both_touched" ? "gross_pnl_zero_when_both_touch_same_candle" : null
  };
}

/** Summarizes only classifiable, funding-complete closed trades. */
export function summarizeBacktest(trades, initialCapital = 10_000) {
  positive(initialCapital, "initialCapital");
  const complete = trades.filter(t => t.status === "closed" && Number.isFinite(t.netPnl));
  const incomplete = trades.filter(t => t.status === "incomplete" || t.status === "unclassifiable");
  const decisive = complete.filter(t => t.exitReason !== "ambiguous_both_touched");
  const wins = decisive.filter(t => t.netPnl > 0).length;
  const losses = decisive.filter(t => t.netPnl < 0).length;
  // Split realized net PnL after fees and funding. Include ambiguous exits:
  // their gross PnL is zero, but their fees can still create a real loss.
  const totalProfit = complete.filter(t => t.netPnl > 0).reduce((sum, t) => sum + t.netPnl, 0);
  const totalLoss = Math.abs(complete.filter(t => t.netPnl < 0).reduce((sum, t) => sum + t.netPnl, 0));
  const netProfit = totalProfit - totalLoss;
  // The risk/reward ratio remains based only on decisive wins/losses.
  const grossWins = decisive.filter(t => t.netPnl > 0).reduce((sum, t) => sum + t.netPnl, 0);
  const grossLosses = Math.abs(decisive.filter(t => t.netPnl < 0).reduce((sum, t) => sum + t.netPnl, 0));
  let equity = initialCapital;
  let peak = initialCapital;
  let maxDrawdown = 0;
  for (const t of complete) {
    equity += t.netPnl;
    peak = Math.max(peak, equity);
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak * 100);
  }
  return {
    totalReturnPct: netProfit / initialCapital * 100,
    totalProfit,
    totalLoss,
    netProfit,
    winRatePct: wins + losses ? wins / (wins + losses) * 100 : 0,
    riskRewardRatio: grossLosses > 0 ? grossWins / grossLosses : null,
    maxDrawdownPct: maxDrawdown,
    totalTrades: complete.length,
    resolvedTrades: decisive.length,
    ambiguousTradeCount: complete.filter(t => t.exitReason === "ambiguous_both_touched").length,
    takeProfitCount: complete.filter(t => t.exitReason === "take_profit").length,
    stopLossCount: complete.filter(t => t.exitReason === "stop_loss").length,
    timeoutCloseCount: complete.filter(t => t.exitReason === "timeout").length,
    incompleteTrades: incomplete.length
  };
}

export { TIMEFRAME_MS };
