# EMA Radar V1

Mobile-first Binance USDⓈ-M USDT perpetual scanner using public market data only.

## Current rebuild status

- Rebuild branch: `rebuild/ema-v1`
- Production branch `main` remains untouched.
- Backup branch `backup/pre-ema-rebuild-20261106` remains unchanged.
- V1 currently includes the EMA25 / EMA50 / EMA100 signal engine, public market scanner, timeframe selection, per-timeframe candle-body filters, manual scan, configurable auto-scan interval, and local settings persistence.
- A standalone single-trade execution engine is implemented and tested: three entry modes, mandatory hard stop plus one auxiliary stop, fixed RR take-profit, timeout close, fees, configurable slippage, timestamped funding mark-price handling, and conservative same-candle stop/TP ordering.
- A portfolio scheduler is implemented and tested: same-symbol/same-time shortest-timeframe priority, maximum five simultaneous positions, opposite-direction blocking at signal and fill time, available-balance checks, and consecutive-loss capital reset/replenishment.
- The complete historical backtest runner is still in progress: historical daily top-100 universe, cached Klines/funding data, scanning all historical signal candles, report integration, settings export/import, and iPhone backtest UI are not yet implemented.
- Do not use the production Pages URL as a preview of this branch; no production deployment has been made.

## Safety scope

- Public Binance USDⓈ-M market data only.
- No wallet connection, private account access, or real order placement.
- iPhone browser/PWA scanning runs only while the page is active; it is not a background service.

## Development

Run the unit tests with:

```sh
npm test
```

See [the V1 specification](docs/EMA_V1_SPEC.md) for confirmed signal and backtest rules.
