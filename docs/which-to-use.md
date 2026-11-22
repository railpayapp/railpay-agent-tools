# Which should I use: MCP server, agent tools or the SDK?

RailPay has three open-source ways to pay from an agent wallet. They all talk to the same RailPay API with the same agent key, and the agent's policy on RailPay (pause switch, per-request max, daily cap, allowed hosts, allowed recipients) applies to all of them. What differs is who decides to pay and where your own limits live.

## Short answer

| You are | Use |
|---|---|
| Giving an MCP client you already use (Claude Code, Claude Desktop, another MCP client) a wallet, without writing code | [railpay-mcp](https://github.com/railpayapp/railpay-mcp) |
| Writing your own agent in TypeScript: Vercel AI SDK, OpenAI, Anthropic, LangChain, or your own tool loop | [railpay-agent-tools](https://github.com/railpayapp/railpay-agent-tools) (this library) |
| Writing code that pays with no model deciding when (a script, a backend job, a crawler), or charging for your own API | [railpay-sdk](https://github.com/railpayapp/railpay-sdk) |

## Side by side

| | railpay-mcp | railpay-agent-tools | railpay-sdk |
|---|---|---|---|
| Who decides to pay | The model, through the MCP client | The model, inside your agent | Your code |
| Runs as | A separate process the client starts over stdio | A library in your agent's process | A library in your process |
| Setup | Build from source, add to the client config with the key in env | Install, pass the key and limits in code | Install, pass the key in code |
| Tools | `railpay_agent`, `railpay_fetch`, `railpay_pay_requirement`, `railpay_send`, `railpay_network` | `railpay_balance`, `railpay_quote`, `railpay_fetch`, `railpay_send` | none: `RailPay` client, `withPayment(fetch)`, `createPaywall()` |
| Your limits | `RAILPAY_MAX_PER_CALL` per call | `maxPerCall`, `sessionBudget`, `allowedHosts`, `allowSend` (off by default) | `maxAmount` per `withPayment` |
| Human approval | Your MCP client's tool-approval prompts | `confirm(payment)` callback | Your code |
| Check a price without paying | no | `railpay_quote` | `readPaymentRequired(response)` |
| Failures | MCP tool errors (`code: message`) | Structured results with `code`, `source` and a `hint` for the model; never throws | `RailPayError` exceptions |
| After a pending or lost payment | The result says the seller did not confirm; no built-in retry | `retry_payment_id` resends the same signed payment, no second charge | Your code can resend the same `PAYMENT-SIGNATURE` |
| Payment log | Agent page in the dapp | `payments()` and `onPayment` for this session, plus the dapp | `onPayment` on `withPayment`, plus the dapp |
| Charge for your own API | no | no | `createPaywall()` |

## railpay-mcp

Use it when the agent is someone else's program that speaks MCP and you only want to plug a wallet in. There is no code to write: add the server to the client config with `RAILPAY_AGENT_KEY` and `RAILPAY_MAX_PER_CALL`. The client shows the tools to the model, and most clients ask you before each tool call.

Its own limit is per call. There is no session budget, so the daily cap in the agent's RailPay policy is what bounds a long session. Keep the client's approval prompts on for the tools that spend.

## railpay-agent-tools

Use it when you write the agent. You get the tools as plain objects (name, description written for the model, JSON Schema, `execute()`), plus adapters for the Vercel AI SDK, OpenAI, Anthropic and LangChain.js.

What it adds over calling the SDK from your own tool:

- A spending guard that runs before anything is signed: per-call cap, a session budget that holds money for payments in flight (safe with parallel tool calls), a host allowlist, and an optional `confirm()` callback for a human.
- Results instead of exceptions, with a `source` that tells a local limit from the RailPay policy, bad input or the network, and a `hint` that tells the model what to do next.
- Only x402 `exact` payments in USDG on `eip155:4663`, at most one per call, no redirects followed, and the model cannot set payment headers.
- `railpay_quote` to read a price first, and `retry_payment_id` to collect a pending payment without paying twice.
- A session payment log with ids.

## railpay-sdk

Use it when a model is not choosing what to pay for. `withPayment(railpay, { maxAmount })` gives you a `fetch` that answers a 402 once; the rest is your code. It is also the seller side: `createPaywall()` returns the 402, verifies and settles the payment, then serves your response.

railpay-agent-tools and railpay-mcp are both built on it.

## Using more than one

They can share an agent, since they all use the same key and policy, but each keeps its own limits and session state, so a session budget in one does not see payments made by another. To keep spend separate, create one agent per integration in the dapp, each with its own key, policy and daily cap.

A common pairing is railpay-sdk's `createPaywall()` on your API and railpay-agent-tools or railpay-mcp on the agents that call it.
