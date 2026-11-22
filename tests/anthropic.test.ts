import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam, Tool, ToolResultBlockParam } from "@anthropic-ai/sdk/resources/messages";
import { describe, expect, it } from "vitest";

import { anthropicTools, runAnthropicToolUses } from "../src/adapters/anthropic.js";
import { SELLER, TX, mockWorld } from "./helpers.js";

/** A fake Anthropic API that answers each request with the next canned message, and records what it was sent. */
function fakeAnthropic(answers: unknown[]) {
  const sent: any[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    sent.push({ url: req.url, body: JSON.parse(await req.text()) });
    return Response.json(answers.shift());
  };
  return { client: new Anthropic({ apiKey: "test", baseURL: "https://anthropic.test", fetch: fetch as typeof globalThis.fetch, maxRetries: 0 }), sent };
}

const message = (content: unknown[], stop_reason: string) => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  content,
  stop_reason,
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5 },
});

const toolUse = (id: string, name: string, input: unknown, extra: Record<string, unknown> = {}) => ({ type: "tool_use", id, name, input, caller: { type: "direct" }, ...extra });

describe("Anthropic adapter", () => {
  it("builds tools that type-check as Messages API tools", () => {
    const tk = mockWorld().toolkit({ allowSend: true });
    const tools: Tool[] = anthropicTools(tk);
    expect(tools.map((t) => t.name)).toEqual(tk.tools.map((t) => t.name));
    expect(tools[2]).toEqual({ name: "railpay_fetch", description: tk.tools[2]!.description, input_schema: tk.tools[2]!.inputSchema });
  });

  it("runs a tool_use loop end to end through the Anthropic client", async () => {
    const w = mockWorld();
    const tk = w.toolkit();
    const { client, sent } = fakeAnthropic([
      message(
        [
          { type: "thinking", thinking: "", signature: "sig" },
          { type: "text", text: "Checking the price, then fetching." },
          toolUse("toolu_1", "railpay_quote", { url: `${SELLER}/data` }),
          toolUse("toolu_2", "railpay_fetch", { url: `${SELLER}/data` }),
        ],
        "tool_use",
      ),
      message([{ type: "text", text: "The answer is 42." }], "end_turn"),
    ]);

    const messages: MessageParam[] = [{ role: "user", content: "Get the data" }];
    const first = await client.messages.create({ model: "claude-opus-5-5", max_tokens: 1024, messages, tools: anthropicTools(tk) });
    const results = await runAnthropicToolUses(tk, first.content);
    // The tool_result blocks type-check as Messages API content blocks.
    const content: ToolResultBlockParam[] = results;
    messages.push({ role: "assistant", content: first.content }, { role: "user", content });
    const second = await client.messages.create({ model: "claude-opus-5-5", max_tokens: 1024, messages, tools: anthropicTools(tk) });

    expect(second.content[0]).toMatchObject({ type: "text", text: "The answer is 42." });
    expect(results.map((r) => r.tool_use_id)).toEqual(["toolu_1", "toolu_2"]);
    expect(results.every((r) => r.is_error === undefined)).toBe(true);
    expect(JSON.parse(results[0]!.content)).toMatchObject({ ok: true, payable: true, price_usdg: "0.001" });
    expect(JSON.parse(results[1]!.content)).toMatchObject({ ok: true, status: 200, paid: { status: "settled", tx_hash: TX } });
    expect(w.state.signed).toBe(1);
    expect(sent[0].body.tools[2]).toMatchObject({ name: "railpay_fetch", input_schema: { type: "object" } });
    expect(sent[1].body.messages.at(-1).content[1]).toMatchObject({ type: "tool_result", tool_use_id: "toolu_2" });
  });

  it("marks refusals as is_error and skips other tools, toolset members and server tools", async () => {
    const w = mockWorld({ price: "500000" });
    const tk = w.toolkit();
    const blocks = [
      toolUse("toolu_a", "get_weather", { city: "Jakarta" }),
      toolUse("toolu_b", "railpay_fetch", { url: `${SELLER}/data` }, { toolset_name: "browser" }),
      { type: "server_tool_use", id: "srvtoolu_c", name: "web_search", input: { query: "x402" } },
      toolUse("toolu_d", "railpay_fetch", { url: `${SELLER}/data` }),
      toolUse("toolu_e", "railpay_fetch", { url: 42 }),
    ];
    const results = await runAnthropicToolUses(tk, blocks);

    expect(results.map((r) => r.tool_use_id)).toEqual(["toolu_d", "toolu_e"]);
    expect(results[0]!.is_error).toBe(true);
    expect(JSON.parse(results[0]!.content)).toMatchObject({ ok: false, error: { code: "over_max_amount", source: "guard" } });
    expect(JSON.parse(results[1]!.content)).toMatchObject({ ok: false, error: { code: "invalid_input", source: "input" } });
    expect(w.state.signed).toBe(0);
  });

  it("handles a message with no tool_use blocks", async () => {
    const tk = mockWorld().toolkit();
    expect(await runAnthropicToolUses(tk, [{ type: "text" }])).toEqual([]);
    expect(await runAnthropicToolUses(tk, undefined)).toEqual([]);
  });
});
