# EMA Radar V1 — Development Specification

Status: specification draft; implementation has not started.
Target branch: `rebuild/ema-v1`
Production branch: `main` (must not be changed during development)

## 1. Scope and safety

- Keep the existing mobile web app shell and rebuild the application from a clean implementation.
- Remove the old big model and MA model from the rebuilt app. V1 contains only the EMA model.
- Use Binance USDⓈ-M USDT perpetual public market data only.
- Do not connect a wallet, read account balances, access private account APIs, or place real orders.
- Do not modify `main` or publish to GitHub Pages until the rebuilt version has passed testing and the user approves publication.
- Keep the backup branch `backup/pre-ema-rebuild-20261106` unchanged.

## 2. EMA signal eligibility

Indicators: EMA25, EMA50, EMA100.

Long signal:
- The signal candle is bullish.
- EMA25, EMA50, and EMA100 are all strictly inside the candle body: open < each EMA < close.
- EMA100 is the lowest of the three EMA values.
- EMA25 and EMA50 have no required relative order.

Short signal:
- The signal candle is bearish.
- EMA25, EMA50, and EMA100 are all strictly inside the candle body: close < each EMA < open.
- EMA100 is the highest of the three EMA values.
- EMA25 and EMA50 have no required relative order.

Additional rules:
- All three EMA values must be inside the same candle body; a wick touch does not qualify.
- The previous candle's position is irrelevant.
- A signal is confirmed only after its candle closes.
- Unclosed candles must never confirm a signal.
- Only the just-closed signal candle is eligible. If a later candle has already begun/closed before the scan can act, the old signal expires and must not be chased or re-triggered.
- Long and short results are shown separately.
- Long arrows use red; short arrows use green.

## 3. Ranking

For each eligible signal calculate:

`distance_rate = (max(EMA25, EMA50, EMA100) - min(EMA25, EMA50, EMA100)) / close_price * 100%`

Smaller distance_rate ranks ahead of larger distance_rate. This is a ranking rule only, not an additional eligibility filter. Do not rank primarily by trading volume.

## 4. Market universe and filters

- Universe: Binance USDⓈ-M USDT perpetual contracts.
- Select the top 100 contracts by 24-hour quote turnover (成交额), dynamically recalculated.
- For historical backtests, use the top-100 universe applicable to each historical trading day; do not apply today's top 100 retrospectively to the whole period.
- Exclude contracts whose 24-hour price change is strictly greater than +30% or strictly less than -30%. Exactly +30% or -30% is allowed.
- Exclude Binance Monitoring/观察 labels, delisted or soon-to-be-delisted contracts, and contracts not currently trading.
- Skip missing or invalid market-data intervals; never fabricate prices.

## 5. Timeframes and scanning

Supported timeframes:
- 10m, 15m, 30m, 1h, 2h, 4h, 6h, 8h, 12h, 1d.

- Each timeframe is independently selectable; users may select one, several, or all.
- No timeframe resonance is required.
- Manual scan button.
- Auto scan can be started and stopped.
- Auto-scan interval is configurable; initial suggested interval is 30 minutes.
- Each timeframe has its own configurable maximum signal-candle body percentage threshold:
  `abs(close - open) / open * 100`.
  Exclude a signal candle when its body percentage reaches or exceeds the configured threshold.
- If the same symbol qualifies on multiple selected timeframes at the same time, only the shortest timeframe may open a position; longer-timeframe signals are ignored for that simultaneous opportunity.
- A maximum of five open trades across the account at once. When more than five fresh eligible signals exist, prioritize by EMA distance_rate, smallest first. Do not keep expired signals waiting for a free slot.
- Same symbol may have multiple independent positions in the same direction.
- Same symbol may not hold long and short simultaneously. If a symbol has one or more open long positions, an opposite short signal must wait until all long positions on that symbol have closed. Then only a newly formed, fresh short signal may open; never reuse the signal that appeared while the long positions were open if it has expired. Apply the inverse rule when short positions are open and a long signal appears.

## 6. Entry options

User-selectable entry methods:
1. Signal candle close.
2. Next candle open.
3. Custom limit entry based on a retracement of the signal candle body.

Custom retracement:
- User-selectable 1%–50%, integer steps only.
- Long: `entry = close - (close - open) * retracement / 100`.
- Short: `entry = close + (open - close) * retracement / 100`.
- Limit order is valid only for the user-configured duration for that timeframe. If not filled in time, cancel it; do not chase or replace it.
- Each timeframe has its own configurable limit-order validity duration.

Backtest must avoid look-ahead bias. Signal-close entry must be modeled as executable only after the signal candle closes, with slippage/latency assumptions applied. Next-open entry uses the next candle's open. Custom limit entry fills only if subsequent price data actually reaches the limit within its validity window.

## 7. Stop loss

- A hard stop is mandatory and cannot be disabled.
- Hard-stop percentage is user-configurable from 1% through 20%, in 1% increments; integer values only, no decimals.
- Long hard stop is below actual entry by the configured percentage; short hard stop is above actual entry by the configured percentage.
- User chooses exactly one auxiliary stop combination (not both simultaneously):
  1. Hard stop plus signal-candle low (long) / high (short).
  2. Hard stop plus signal-candle open.
- Whichever active stop level is reached first exits the trade.
- Stop-loss exits are modeled as market exits, including configured slippage.
- If intrabar OHLC data cannot establish which of multiple levels was reached first, use a conservative/worst-case assumption and label the assumption in the report.

## 8. Take profit and timeout exit

- Fixed risk/reward target; no trailing stop.
- Risk/reward ratio selectable from 1:1 through 1:5 in 0.1 increments.
- Take profit is modeled as a limit order and counts as filled only when market price reaches the limit.
- Stop loss is modeled as a market exit.
- Optional timeout close after 1–9 K-lines. The selected number applies to every timeframe as a candle count, not a fixed wall-clock duration.
- Count begins with the first complete candle after actual entry. If neither TP nor SL has triggered, close at the close price of the Nth counted candle, modeled as a market exit with configured slippage.

## 9. Capital and position sizing

- Initial simulated capital: 10,000 USDT.
- Position sizing is a user-configurable fixed amount.
- Maximum five open trades simultaneously.
- Display: total equity, used margin/capital committed, available balance, unrealized P&L, realized P&L, and cumulative replenishment/top-up capital.
- Fixed position amount means total notional position value (仓位总价值), not margin allocated per trade. Example: a 500 USDT setting means 500 USDT notional exposure; do not multiply by leverage. V1 backtest does not simulate leverage or leveraged margin.

## 10. Simulated replenishment after consecutive losses

- After a losing trade, restore simulated account capital to the initial base of 10,000 USDT, then add an amount based on the consecutive-loss count:
  - first consecutive loss: +10% of base = 1,000 USDT;
  - second: +20% = 2,000 USDT;
  - third: +30% = 3,000 USDT;
  - fourth: +40% = 4,000 USDT;
  - fifth and later: +50% = 5,000 USDT.
- A winning trade resets the consecutive-loss counter to zero and does not itself add or deduct capital.
- Unfilled or cancelled orders do not count as losses.
- If one trade loses while other positions remain open, apply the simulated replenishment immediately to account funds/available balance only. Do not alter other open positions or their entry/TP/SL prices.
- Track replenishment separately from trading P&L. This is a backtest simulation only, not a real transfer.

## 11. Backtest data and reporting

Backtest periods: 7, 30, and 60 days only.

- Each historical day uses that day's top-100 turnover universe.
- Append the latest completed day's eligible data to the rolling historical store and remove the oldest day when the retention limit is exceeded.
- Cache historical klines and download only missing data needed for the selected period/timeframes.
- If a contract is delisted, stop treating it as an active eligible contract. Keep completed trade records in reports for auditability, while not continuing to treat the delisted contract as tradable.
- Missing data intervals are skipped and reported; no synthetic candles or prices.

Report exactly:
- total return %
- net profit
- win rate
- risk/reward ratio
- maximum drawdown
- total trades
- take-profit count
- stop-loss count
- timeout-close count
- total capital replenished

Ambiguous/unclassifiable trades must be listed separately and excluded from total trades, win rate, and P&L statistics.

Trading costs:
- Entry and exit fees are calculated separately; both rates are user-editable and persisted.
- Slippage is user-editable and persisted. Apply it to market-style exits (stop loss and timeout close); apply a transparent, configurable execution assumption to entries as appropriate for the selected entry type.
- Retrieve historical funding rates from Binance public market-data endpoints for the symbol and relevant funding timestamps. Apply funding payments/receipts according to position direction and whether the simulated position was open at each funding timestamp.
- Do not silently substitute zero funding when historical funding data is missing. Flag affected trades/data intervals as incomplete and exclude unclassifiable results from headline statistics, or clearly disclose the limitation.
- Fee rates and slippage defaults remain editable; do not invent or silently hard-code user-approved default values.

## 12. Settings and persistence

- Every setting must persist after leaving the page, closing the browser, and reopening.
- Provide an explicit Save Settings action.
- Save scanner settings and backtest settings separately.
- Persist timeframes, per-timeframe candle-body thresholds, entry method, retracement, order validity, hard stop, auxiliary stop mode, TP ratio, timeout bars, fixed position size, fees, slippage, funding assumptions, and replenishment settings.
- Restore defaults requires a second confirmation.
- Provide settings export/import so settings can be backed up or restored on another device.

## 13. iPhone/PWA limitations

- Provide a mobile-first layout and preserve the app-shell behavior.
- Audible alerts may be offered for newly confirmed signals while the app is active and notification/audio permissions are available.
- Do not promise continuous scanning when the page is closed or the iPhone is locked. True background scanning requires a separate server-side service and is outside this V1 scope.

## 14. Items requiring user confirmation before backtest implementation



No implementation should silently invent answers to these unresolved items.
