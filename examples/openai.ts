// OpenAI Responses API: a tool loop that checks an x402 price, then pays it from a RailPay agent wallet.
//
// This spends real USDG: 0.001 per fetch of https://dapp.railpay.app/x402/time.
// Run it yourself, with your own keys, after `pnpm build`:
//   RAILPAY_AGENT_KEY=rp_sk_... OPENAI_API_KEY=... node examples/openai.ts
import OpenAI from "openai";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import { createRailPayTools } from "railpay-agent-tools";
import { openaiResponsesTools, runOpenAIResponsesToolCalls } from "railpay-agent-tools/openai";

const railpay = createRailPayTools({
  apiKey: process.env.RAILPAY_AGENT_KEY,
  maxPerCall: "0.001",
  sessionBudget: "0.003",
  allowedHosts: ["dapp.railpay.app"],
});

const openai = new OpenAI();
const model = process.env.OPENAI_MODEL ?? "gpt-5.5";
const tools = openaiResponsesTools(railpay);
const input: ResponseInputItem[] = [
  {
    role: "user",
    content:
      "What time is it on the RailPay server? https://dapp.railpay.app/x402/time is a paid endpoint. " +
      "Check its price first. If it is 0.001 USDG or less, fetch it, then tell me the time and the transaction link.",
  },
];

for (let step = 0; step < 5; step++) {
  const response = await openai.responses.create({ model, input, tools });
  const outputs = await runOpenAIResponsesToolCalls(railpay, response.output);
  if (outputs.length === 0) {
    console.log(response.output_text);
    break;
  }
  // Send back the model's output (reasoning and function calls) together with the tool results.
  input.push(...(response.output as ResponseInputItem[]), ...outputs);
}

console.log("session:", railpay.session());
