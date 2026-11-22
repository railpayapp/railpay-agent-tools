// Anthropic Messages API: a Claude tool loop that checks an x402 price, then pays it from a RailPay agent wallet.
//
// This spends real USDG: 0.001 per fetch of https://dapp.railpay.app/x402/time.
// Run it yourself, with your own keys, after `pnpm build`:
//   RAILPAY_AGENT_KEY=rp_sk_... ANTHROPIC_API_KEY=... node examples/anthropic.ts
import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages";
import { createRailPayTools } from "railpay-agent-tools";
import { anthropicTools, runAnthropicToolUses } from "railpay-agent-tools/anthropic";

const railpay = createRailPayTools({
  apiKey: process.env.RAILPAY_AGENT_KEY,
  maxPerCall: "0.001",
  sessionBudget: "0.003",
  allowedHosts: ["dapp.railpay.app"],
});

const client = new Anthropic();
const tools = anthropicTools(railpay);
const messages: BetaMessageParam[] = [
  {
    role: "user",
    content:
      "What time is it on the RailPay server? https://dapp.railpay.app/x402/time is a paid endpoint. " +
      "Check its price first. If it is 0.001 USDG or less, fetch it, then tell me the time and the transaction link.",
  },
];

for (let step = 0; step < 8; step++) {
  // Server-side fallbacks: if a safety classifier declines the request, the API re-runs it on a fallback model.
  const response = await client.beta.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    tools,
    messages,
  });
  messages.push({ role: "assistant", content: response.content });

  if (response.stop_reason === "pause_turn") continue;
  if (response.stop_reason !== "tool_use") {
    if (response.stop_reason === "refusal") console.log("The request was declined.");
    for (const block of response.content) if (block.type === "text") console.log(block.text);
    break;
  }
  // All tool results go back in one user message.
  messages.push({ role: "user", content: await runAnthropicToolUses(railpay, response.content) });
}

console.log("session:", railpay.session());
