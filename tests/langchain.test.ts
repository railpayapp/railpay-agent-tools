import { AIMessageChunk, ToolMessage } from "@langchain/core/messages";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import { ToolInputParsingException } from "@langchain/core/tools";
import { FakeStreamingChatModel } from "@langchain/core/utils/testing";
import { describe, expect, it } from "vitest";

import { langchainTools } from "../src/adapters/langchain.js";
import { SELLER, TX, mockWorld } from "./helpers.js";

describe("LangChain adapter", () => {
  it("builds one LangChain tool per RailPay tool, with the JSON Schema", () => {
    const tk = mockWorld().toolkit({ allowSend: true });
    const tools = langchainTools(tk);
    expect(tools.map((t) => t.name)).toEqual(tk.tools.map((t) => t.name));
    for (const [i, t] of tools.entries()) {
      expect(t.description).toBe(tk.tools[i]!.description);
      expect(convertToOpenAITool(t).function.parameters).toEqual(tk.tools[i]!.inputSchema);
    }
  });

  it("runs the tool calls of a chat model message and returns ToolMessages", async () => {
    const w = mockWorld();
    const tools = langchainTools(w.toolkit());
    const model = new FakeStreamingChatModel({
      chunks: [
        new AIMessageChunk({
          content: "",
          tool_call_chunks: [
            { id: "call_1", name: "railpay_quote", args: JSON.stringify({ url: `${SELLER}/data` }), index: 0, type: "tool_call_chunk" },
            { id: "call_2", name: "railpay_fetch", args: JSON.stringify({ url: `${SELLER}/data` }), index: 1, type: "tool_call_chunk" },
          ],
        }),
      ],
    });

    const ai = await model.bindTools(tools).invoke("Get the data");
    const byName = new Map(tools.map((t) => [t.name, t]));
    const results: ToolMessage[] = [];
    for (const call of ai.tool_calls ?? []) results.push(await byName.get(call.name)!.invoke(call));

    expect(results.map((m) => m.tool_call_id)).toEqual(["call_1", "call_2"]);
    expect(results.every((m) => m instanceof ToolMessage)).toBe(true);
    expect(JSON.parse(results[0]!.content as string)).toMatchObject({ ok: true, payable: true, price_usdg: "0.001" });
    expect(JSON.parse(results[1]!.content as string)).toMatchObject({ ok: true, status: 200, paid: { status: "settled", tx_hash: TX } });
    expect(w.state.signed).toBe(1);
  });

  it("returns refusals as text for the model, without throwing or signing", async () => {
    const w = mockWorld({ price: "500000" });
    const fetchTool = langchainTools(w.toolkit()).find((t) => t.name === "railpay_fetch")!;
    const out = await fetchTool.invoke({ url: `${SELLER}/data` });
    expect(JSON.parse(out)).toMatchObject({ ok: false, error: { code: "over_max_amount", source: "guard" } });
    expect(w.state.signed).toBe(0);
  });

  it("leaves schema validation to LangChain, which throws before the tool runs", async () => {
    const w = mockWorld();
    const fetchTool = langchainTools(w.toolkit()).find((t) => t.name === "railpay_fetch")!;
    await expect(fetchTool.invoke({ url: 42 } as never)).rejects.toBeInstanceOf(ToolInputParsingException);
    expect(w.state.calls).toHaveLength(0);
  });

  it("passes the abort signal through", async () => {
    const w = mockWorld();
    const quote = langchainTools(w.toolkit()).find((t) => t.name === "railpay_quote")!;
    const controller = new AbortController();
    const pending = quote.invoke({ url: `${SELLER}/data` }, { signal: controller.signal });
    controller.abort();
    expect(JSON.parse(await pending)).toMatchObject({ ok: false, error: { code: "timeout", message: "The request was aborted", source: "network" } });
    expect(w.state.calls.filter((c) => c.url.startsWith(SELLER))).toHaveLength(0);
  });
});
