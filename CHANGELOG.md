# Changelog

All notable changes to railpay-agent-tools. Versions follow [Semantic Versioning](https://semver.org); before 1.0.0 a minor version may change the API.

## [0.5.0] - 2026-11-22

### Added

- `confirm(payment)` option: a human-in-the-loop callback asked before every payment, after the limits pass, with the tool, amount, recipient, URL or memo, the seller's description and the session totals. Anything but `true` refuses with `payment_declined` (source `user`) and nothing is signed. The amount stays held while it waits, so parallel calls cannot spend it.
- Session payment log: every payment gets an id (`pay_1`, `pay_2`, …), returned as `payment_id`. `toolkit.payments()` lists them with tool, status, amount, recipient, URL or memo, transaction and time, and the `onPayment` option is called when one is made or changes status. `session()` also counts payments.
- `retry_payment_id` input on `railpay_fetch`: after a pending, unaccepted or unanswered payment, resends the same signed payment to the same URL, so the seller can serve the resource without a second charge. A settled payment cannot be reused (`payment_already_used`) and an expired one is refused (`payment_expired`).
- `railpay-agent-tools/langchain`: `langchainTools(toolkit)` returns LangChain.js `DynamicStructuredTool`s built from the JSON Schema, for `bindTools`, `ToolNode` and `createAgent`. `@langchain/core` ^1 is an optional peer dependency. Tested with `@langchain/core` 1.5.0 and `@langchain/anthropic` 1.6.6.
- Guide `docs/which-to-use.md`: railpay-mcp vs railpay-agent-tools vs railpay-sdk.
- Example `examples/langchain.ts` and a LangChain quick start in the README.

### Changed

- `SpendingGuard.authorize()` now takes the `tool` the payment is for.
- `PaymentInfo` is now `PaymentRecord`, with `id`, `tool`, `url`, `memo` and `at` added. `PaymentInfo` stays as a deprecated alias.
- When a payment is pending, unaccepted or unanswered, results now point the model to `retry_payment_id` instead of telling it to give up.

## [0.4.0] - 2026-11-22

### Added

- `railpay-agent-tools/anthropic`: `anthropicTools()` for the `tools` of the Messages API, and `runAnthropicToolUses(toolkit, message.content)`, which returns the `tool_result` blocks for RailPay's `tool_use` blocks, with `is_error: true` on refusals.
- The dispatcher skips other tools, server tools and toolset members such as the browser tools, and works with both `client.messages` and `client.beta.messages`.
- Plain objects that type-check as the `@anthropic-ai/sdk` types, so the SDK is not a dependency. Tested with `@anthropic-ai/sdk` 1.12.0.
- Example `examples/anthropic.ts` (Claude tool loop with server-side refusal fallbacks) and an Anthropic quick start in the README.

## [0.3.0] - 2026-11-22

### Added

- `railpay-agent-tools/openai`: `openaiChatTools()` and `openaiResponsesTools()` for the `tools` of Chat Completions and the Responses API, and the dispatchers `runOpenAIChatToolCalls(toolkit, message.tool_calls)` and `runOpenAIResponsesToolCalls(toolkit, response.output)`, which return the `role: "tool"` messages or `function_call_output` items to send back.
- The dispatchers run only RailPay's calls, one after another, and skip other tools. Arguments that are not valid JSON get an `invalid_input` result.
- Plain objects that type-check as the `openai` SDK types, so `openai` is not a dependency. Tested with `openai` 7.62.0.
- Example `examples/openai.ts` (Responses API tool loop) and an OpenAI quick start in the README.

### Fixed

- The generic quick start in the README now type-checks.

## [0.2.0] - 2026-11-22

### Added

- `railpay-agent-tools/ai`: `aiSdkTools(toolkit)` turns the tools into Vercel AI SDK tools for `generateText` and `streamText`, built with `tool()` and `jsonSchema()` (no zod schemas needed). The model gets the structured result, refusals included, and the AI SDK abort signal is passed through to the HTTP requests.
- `ai` ^7 as an optional peer dependency. Tested with `ai` 7.0.179.
- Example `examples/ai-sdk.ts` (Claude through `@ai-sdk/anthropic`) and an AI SDK quick start in the README.

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
