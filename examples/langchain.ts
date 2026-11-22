// LangChain.js: a Claude tool loop (ChatAnthropic + bindTools) that checks an x402 price, then pays it
// from a RailPay agent wallet.
//
// This spends real USDG: 0.001 per fetch of https://dapp.railpay.app/x402/time.
// Run it yourself, with your own keys, after `pnpm build`:
//   RAILPAY_AGENT_KEY=rp_sk_... ANTHROPIC_API_KEY=... node examples/langchain.ts
import { ChatAnthropic } from "@langchain/anthropic";
import { HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { createRailPayTools } from "railpay-agent-tools";
import { langchainTools } from "railpay-agent-tools/langchain";

const railpay = createRailPayTools({
  apiKey: process.env.RAILPAY_AGENT_KEY,
  maxPerCall: "0.001",
  sessionBudget: "0.003",
  allowedHosts: ["dapp.railpay.app"],
});

const tools = langchainTools(railpay);
const byName = new Map(tools.map((t) => [t.name, t]));
const model = new ChatAnthropic({ model: "claude-opus-5-5", maxTokens: 16000 }).bindTools(tools);

const messages: BaseMessage[] = [
  new HumanMessage(
    "What time is it on the RailPay server? https://dapp.railpay.app/x402/time is a paid endpoint. " +
      "Check its price first. If it is 0.001 USDG or less, fetch it, then tell me the time and the transaction link.",
  ),
];

for (let step = 0; step < 8; step++) {
  const ai = await model.invoke(messages);
  messages.push(ai);
  if (!ai.tool_calls?.length) {
    console.log(ai.text);
    break;
  }
  for (const call of ai.tool_calls) {
    const tool = byName.get(call.name);
    // LangChain throws when the arguments do not match the schema: hand that back to the model as an error.
    const result: ToolMessage = tool
      ? await tool.invoke(call).catch((e: Error) => new ToolMessage({ tool_call_id: call.id!, content: e.message, status: "error" }))
      : new ToolMessage({ tool_call_id: call.id!, content: `Unknown tool ${call.name}`, status: "error" });
    messages.push(result);
  }
}

console.log("session:", railpay.session());
console.log("payments:", railpay.payments());
