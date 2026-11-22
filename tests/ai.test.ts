import { generateText, isStepCount } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { aiSdkTools } from "../src/adapters/ai.js";
import { SELLER, TX, mockWorld } from "./helpers.js";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

const callTool = (toolName: string, input: unknown) => ({
  content: [{ type: "tool-call" as const, toolCallId: "call_1", toolName, input: JSON.stringify(input) }],
  finishReason: { unified: "tool-calls" as const, raw: undefined },
  usage,
  warnings: [],
});

const say = (text: string) => ({
  content: [{ type: "text" as const, text }],
  finishReason: { unified: "stop" as const, raw: undefined },
  usage,
  warnings: [],
});

describe("Vercel AI SDK adapter", () => {
  it("builds one AI SDK tool per RailPay tool, with the JSON Schema and description", () => {
    const tk = mockWorld().toolkit({ allowSend: true });
    const tools = aiSdkTools(tk);
    expect(Object.keys(tools)).toEqual(["railpay_balance", "railpay_quote", "railpay_fetch", "railpay_send"]);
    for (const t of tk.tools) {
      const a = tools[t.name]!;
      expect(a.description).toBe(t.description);
      expect((a.inputSchema as { jsonSchema: unknown }).jsonSchema).toEqual(t.inputSchema);
      expect(typeof a.execute).toBe("function");
    }
    expect(Object.keys(aiSdkTools(mockWorld().toolkit()))).not.toContain("railpay_send");
  });

  it("lets generateText pay for a resource and feeds the result back to the model", async () => {
    const w = mockWorld();
    const model = new MockLanguageModelV4({ doGenerate: [callTool("railpay_fetch", { url: `${SELLER}/data` }), say("The answer is 42.")] });

    const result = await generateText({
      model,
      tools: aiSdkTools(w.toolkit()),
      prompt: "Get the data",
      stopWhen: isStepCount(3),
    });

    expect(result.text).toBe("The answer is 42.");
    expect(result.steps).toHaveLength(2);
    const output = result.steps[0]!.toolResults[0]!.output as Record<string, any>;
    expect(output).toMatchObject({ ok: true, status: 200, body: '{"answer":42}', paid: { status: "settled", amount_usdg: "0.001", tx_hash: TX } });
    expect(w.state.signed).toBe(1);
    // The second model call sees the tool result, transaction hash included.
    expect(JSON.stringify(model.doGenerateCalls[1]!.prompt)).toContain(TX);
    // The model was offered the JSON Schema as is.
    const offered = model.doGenerateCalls[0]!.tools!.find((t) => t.name === "railpay_fetch") as { inputSchema: unknown };
    expect(offered.inputSchema).toEqual(w.toolkit().tool("railpay_fetch")!.inputSchema);
  });

  it("hands a refusal to the model as a result, without throwing or signing", async () => {
    const w = mockWorld({ price: "500000" });
    const model = new MockLanguageModelV4({ doGenerate: [callTool("railpay_fetch", { url: `${SELLER}/data` }), say("Too expensive.")] });

    const result = await generateText({ model, tools: aiSdkTools(w.toolkit()), prompt: "Get the data", stopWhen: isStepCount(3) });

    const output = result.steps[0]!.toolResults[0]!.output as Record<string, any>;
    expect(output).toMatchObject({ ok: false, error: { code: "over_max_amount", source: "guard", retryable: false } });
    expect(w.state.signed).toBe(0);
    expect(result.text).toBe("Too expensive.");
  });

  it("passes the abort signal through to the request", async () => {
    const w = mockWorld();
    const tools = aiSdkTools(w.toolkit());
    const controller = new AbortController();
    controller.abort();
    const output = (await tools.railpay_quote!.execute!({ url: `${SELLER}/data` }, { toolCallId: "c", messages: [], context: undefined, abortSignal: controller.signal })) as Record<string, any>;
    expect(output).toMatchObject({ ok: false, error: { code: "timeout", message: "The request was aborted", source: "network" } });
    expect(w.state.calls).toHaveLength(0);
  });
});
