# EMA Radar V1

Mobile-first Binance USDⓈ-M USDT perpetual scanner using public market data only.

## Current rebuild status

- Rebuild branch: `rebuild/ema-v1`
- Production branch `main` remains untouched.
- Backup branch `backup/pre-ema-rebuild-20261106` remains unchanged.
- V1 currently includes the EMA25 / EMA50 / EMA100 signal engine, public market scanner, timeframe selection, per-timeframe candle-body filters, manual scan, configurable auto-scan interval, and local settings persistence.
- Backtesting, historical data storage, trade simulation, capital accounting, and full settings export/import are not implemented yet.
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
