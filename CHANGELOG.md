# Changelog

All notable changes to railpay-agent-tools. Versions follow [Semantic Versioning](https://semver.org); before 1.0.0 a minor version may change the API.

## [0.1.0] - 2026-11-22

First release.

### Added

- `createRailPayTools()`: framework-neutral payment tools for an AI agent with a RailPay agent wallet (USDG on Robinhood Chain, chain id 4663). Each tool has a name, a description written for the model, a JSON Schema and `execute()`.
- `railpay_balance`: balance, ETH for gas, spent today, the owner's policy, this session's limits and `max_payment_now_usdg`.
- `railpay_quote`: reads an x402 price without paying. Works without an agent key.
- `railpay_fetch`: pays an x402 v2 `exact` 402 in USDG with an EIP-3009 authorization, through railpay-sdk's `withPayment`, and returns status, a truncated body and the settlement transaction link.
- `railpay_send`: pays another RailPay agent. Not offered, and refused, unless `allowSend: true`.
- Spending guard, checked before RailPay is asked to sign: `maxPerCall` (default 0.1 USDG; the model can lower it per call with `max_amount`), `sessionBudget` (held across parallel calls) and `allowedHosts` (checked before any request).
- Structured results: refusals and failures come back as `{ ok: false, error: { code, message, source, retryable, hint } }` instead of throwing. The agent's RailPay policy codes map to source `policy`.
- railpay-sdk 0.1.0 is bundled into the build, so the package has no runtime dependencies.
- `pnpm smoke`: read-only check against the live dapp.
