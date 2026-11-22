// Vercel AI SDK: a Claude agent that checks an x402 price, then pays it from a RailPay agent wallet.
//
// This spends real USDG: 0.001 per fetch of https://dapp.railpay.app/x402/time.
// Run it yourself, with your own keys, after `pnpm build`:
//   RAILPAY_AGENT_KEY=rp_sk_... ANTHROPIC_API_KEY=... node examples/ai-sdk.ts
import { anthropic } from "@ai-sdk/anthropic";
import { generateText, isStepCount } from "ai";
import { createRailPayTools } from "railpay-agent-tools";
import { aiSdkTools } from "railpay-agent-tools/ai";

const railpay = createRailPayTools({
  apiKey: process.env.RAILPAY_AGENT_KEY,
  maxPerCall: "0.001",
  sessionBudget: "0.003",
  allowedHosts: ["dapp.railpay.app"],
});

const result = await generateText({
  model: anthropic("claude-opus-5-5"),
  tools: aiSdkTools(railpay),
  stopWhen: isStepCount(5),
  prompt:
    "What time is it on the RailPay server? https://dapp.railpay.app/x402/time is a paid endpoint. " +
    "Check its price first. If it is 0.001 USDG or less, fetch it, then tell me the time and the transaction link.",
});

console.log(result.text);
console.log("session:", railpay.session());
