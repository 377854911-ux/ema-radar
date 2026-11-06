/**
 * Shared funding-rate threshold rules.
 * UI values are expressed in percent (0.01 means 0.01%); Binance rates are decimals.
 */
export function fundingThresholdRate(thresholdPct) {
  const pct = Number(thresholdPct ?? 0);
  if (!Number.isFinite(pct) || pct < 0) throw new RangeError("Funding threshold must be a non-negative percentage");
  return pct === 0 ? 0 : pct / 100;
}

export function isFundingRateAllowed(rate, thresholdPct) {
  const threshold = fundingThresholdRate(thresholdPct);
  if (threshold === 0) return true;
  if (rate === null || rate === undefined || !Number.isFinite(Number(rate))) return false;
  return Math.abs(Number(rate)) < threshold;
}

/**
 * Return the latest settled funding rate already knowable at knownAt.
 * Strictly excludes events at the exact timestamp to avoid ambiguous ordering.
 */
export function latestKnownFundingRate(events, knownAt) {
  if (!Array.isArray(events) || !Number.isFinite(knownAt)) return null;
  let latestTime = -Infinity;
  let latestRate;
  let hasLatest = false;
  let conflict = false;
  const sameRate = (a, b) => a === b
    || (a !== null && a !== undefined && a !== "" && b !== null && b !== undefined && b !== ""
      && Number.isFinite(Number(a)) && Number.isFinite(Number(b))
      && Number(a) === Number(b));

  for (const event of events) {
    const time = Number(event?.fundingTime);
    if (!Number.isFinite(time) || time >= knownAt) continue;
    if (time > latestTime) {
      latestTime = time;
      latestRate = event?.rate;
      hasLatest = true;
      conflict = false;
    } else if (time === latestTime && !sameRate(latestRate, event?.rate)) {
      conflict = true;
    }
  }

  if (!hasLatest || conflict || latestRate === null || latestRate === undefined
      || latestRate === "" || !Number.isFinite(Number(latestRate))) return null;
  return { fundingTime: latestTime, rate: Number(latestRate) };
}
