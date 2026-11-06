import test from "node:test";
import assert from "node:assert/strict";
import { fundingThresholdRate, isFundingRateAllowed, latestKnownFundingRate } from "../js/funding-filter.js";

test("converts user percentage thresholds into Binance decimal rates", () => {
  assert.equal(fundingThresholdRate(0.01), 0.0001);
  assert.equal(fundingThresholdRate(0.1), 0.001);
  assert.equal(fundingThresholdRate(0), 0);
});

test("filters high funding rates by absolute value in both directions", () => {
  assert.equal(isFundingRateAllowed(0.000099, 0.01), true);
  assert.equal(isFundingRateAllowed(0.0001, 0.01), false);
  assert.equal(isFundingRateAllowed(-0.0002, 0.01), false);
  assert.equal(isFundingRateAllowed(null, 0.01), false);
  assert.equal(isFundingRateAllowed(null, 0), true);
});

test("selects only the latest settled funding rate known before the signal close", () => {
  const known = latestKnownFundingRate([
    { fundingTime: 100, rate: 0.0001 },
    { fundingTime: 200, rate: 0.0002 },
    { fundingTime: 300, rate: 0.0003 },
    { fundingTime: 400, rate: null }
  ], 300);
  assert.deepEqual(known, { fundingTime: 200, rate: 0.0002 });
  assert.equal(latestKnownFundingRate([{ fundingTime: 100, rate: null }], 200), null);
});

test("does not fall back to an older rate when the latest settled rate is missing", () => {
  const events = [
    { fundingTime: 100, rate: 0.00001 },
    { fundingTime: 200, rate: null }
  ];
  assert.equal(latestKnownFundingRate(events, 300), null);
});

test("rejects conflicting rates at the latest settled funding timestamp", () => {
  const events = [
    { fundingTime: 100, rate: 0.00001 },
    { fundingTime: 200, rate: 0.00002 },
    { fundingTime: 200, rate: 0.00003 }
  ];
  assert.equal(latestKnownFundingRate(events, 300), null);
  assert.deepEqual(latestKnownFundingRate([
    { fundingTime: 200, rate: "0.00002" },
    { fundingTime: 200, rate: 0.00002 }
  ], 300), { fundingTime: 200, rate: 0.00002 });
});
