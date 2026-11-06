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
  let latest = null;
  for (const event of events) {
    const time = Number(event?.fundingTime);
    const rawRate = event?.rate;
    const rate = Number(rawRate);
    if (rawRate !== null && rawRate !== undefined && rawRate !== ""
        && Number.isFinite(time) && time < knownAt && Number.isFinite(rate)
        && (!latest || time > latest.fundingTime)) {
      latest = { fundingTime: time, rate };
    }
  }
  return latest;
}
