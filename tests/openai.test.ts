import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionMessageToolCall, ChatCompletionTool } from "openai/resources/chat/completions";
import type { ResponseInputItem, Tool as ResponsesTool } from "openai/resources/responses/responses";
import { describe, expect, it } from "vitest";

import { openaiChatTools, openaiResponsesTools, runOpenAIChatToolCalls, runOpenAIResponsesToolCalls } from "../src/adapters/openai.js";
import { SELLER, TX, mockWorld } from "./helpers.js";

const OPENAI = "https://openai.test/v1";

/** A fake OpenAI API that answers each request with the next canned body, and records what it was sent. */
function fakeOpenAI(answers: unknown[]) {
  const sent: any[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    sent.push({ url: req.url, body: JSON.parse(await req.text()) });
    return Response.json(answers.shift());
  };
  return { client: new OpenAI({ apiKey: "test", baseURL: OPENAI, fetch: fetch as typeof globalThis.fetch, maxRetries: 0 }), sent };
}

const completion = (message: Record<string, unknown>, finish: string) => ({
  id: "chatcmpl_1",
  object: "chat.completion",
  created: 0,
  model: "test-model",
  choices: [{ index: 0, message: { role: "assistant", content: null, refusal: null, ...message }, finish_reason: finish, logprobs: null }],
});

const response = (output: unknown[]) => ({ id: "resp_1", object: "response", created_at: 0, model: "test-model", status: "completed", output });

describe("OpenAI adapter", () => {
  it("builds tools that type-check as OpenAI Chat Completions and Responses tools", () => {
    const tk = mockWorld().toolkit({ allowSend: true });
    const chat: ChatCompletionTool[] = openaiChatTools(tk);
    const responses: ResponsesTool[] = openaiResponsesTools(tk);
    expect(chat.map((t) => (t.type === "function" ? t.function.name : ""))).toEqual(tk.tools.map((t) => t.name));
    expect(chat[2]).toEqual({ type: "function", function: { name: "railpay_fetch", description: tk.tools[2]!.description, parameters: tk.tools[2]!.inputSchema, strict: false } });
    expect(responses[2]).toEqual({ type: "function", name: "railpay_fetch", description: tk.tools[2]!.description, parameters: tk.tools[2]!.inputSchema, strict: false });
  });

  it("runs a Chat Completions tool call end to end through the openai client", async () => {
    const w = mockWorld();
    const tk = w.toolkit();
    const { client, sent } = fakeOpenAI([
      completion({ tool_calls: [{ id: "call_1", type: "function", function: { name: "railpay_fetch", arguments: JSON.stringify({ url: `${SELLER}/data` }) } }] }, "tool_calls"),
      completion({ content: "The answer is 42." }, "stop"),
    ]);

    const messages: ChatCompletionMessageParam[] = [{ role: "user", content: "Get the data" }];
    const first = await client.chat.completions.create({ model: "test-model", messages, tools: openaiChatTools(tk) });
    const message = first.choices[0]!.message;
    messages.push(message);
    const toolMessages = await runOpenAIChatToolCalls(tk, message.tool_calls);
    messages.push(...toolMessages);
    const second = await client.chat.completions.create({ model: "test-model", messages, tools: openaiChatTools(tk) });

    expect(second.choices[0]!.message.content).toBe("The answer is 42.");
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]!.tool_call_id).toBe("call_1");
    expect(JSON.parse(toolMessages[0]!.content)).toMatchObject({ ok: true, status: 200, paid: { status: "settled", tx_hash: TX } });
    expect(w.state.signed).toBe(1);
    expect(sent[0].body.tools[2].function.name).toBe("railpay_fetch");
    expect(sent[1].body.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call_1" });
  });

  it("runs a Responses API function call end to end through the openai client", async () => {
    const w = mockWorld();
    const tk = w.toolkit();
    const { client, sent } = fakeOpenAI([
      response([
        { type: "reasoning", id: "rs_1", summary: [] },
        { type: "function_call", id: "fc_1", call_id: "call_1", name: "railpay_quote", arguments: JSON.stringify({ url: `${SELLER}/data` }), status: "completed" },
      ]),
      response([{ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "It costs 0.001 USDG.", annotations: [] }] }]),
    ]);

    const first = await client.responses.create({ model: "test-model", input: "What does the data cost?", tools: openaiResponsesTools(tk) });
    const outputs = await runOpenAIResponsesToolCalls(tk, first.output);
    // The function_call_output items type-check as Responses API input items.
    const returned: ResponseInputItem[] = outputs;
    const input = [...(first.output as ResponseInputItem[]), ...returned];
    const second = await client.responses.create({ model: "test-model", input, tools: openaiResponsesTools(tk) });

    expect(second.output_text).toBe("It costs 0.001 USDG.");
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toMatchObject({ type: "function_call_output", call_id: "call_1" });
    expect(JSON.parse(outputs[0]!.output)).toMatchObject({ ok: true, payable: true, price_usdg: "0.001", within_limits: true });
    expect(w.state.signed).toBe(0);
    expect(sent[0].body.tools[1]).toMatchObject({ type: "function", name: "railpay_quote" });
    expect(sent[1].body.input.at(-1)).toMatchObject({ type: "function_call_output", call_id: "call_1" });
  });

  it("skips calls to other tools and answers invalid JSON arguments with a structured error", async () => {
    const w = mockWorld();
    const tk = w.toolkit();
    const calls: ChatCompletionMessageToolCall[] = [
      { id: "a", type: "function", function: { name: "get_weather", arguments: "{}" } },
      { id: "b", type: "custom", custom: { name: "railpay_fetch", input: "x" } },
      { id: "c", type: "function", function: { name: "railpay_fetch", arguments: "{not json" } },
      { id: "d", type: "function", function: { name: "railpay_balance", arguments: "" } },
    ];
    const out = await runOpenAIChatToolCalls(tk, calls);

    expect(out.map((m) => m.tool_call_id)).toEqual(["c", "d"]);
    expect(JSON.parse(out[0]!.content)).toMatchObject({ ok: false, error: { code: "invalid_input", source: "input", retryable: false } });
    expect(JSON.parse(out[1]!.content)).toMatchObject({ ok: true, balance_usdg: "2.5" });
    expect(w.state.signed).toBe(0);

    const items = await runOpenAIResponsesToolCalls(tk, [
      { type: "message" },
      { type: "function_call", call_id: "x", name: "lookup", arguments: "{}" },
      { type: "function_call", call_id: "y", name: "railpay_send", arguments: JSON.stringify({ to: "agt_2", amount: "0.01" }) },
    ] as { type: string }[]);
    // railpay_send is a RailPay tool, so it is answered, with a refusal: send is off by default.
    expect(items.map((i) => i.call_id)).toEqual(["y"]);
    expect(JSON.parse(items[0]!.output)).toMatchObject({ ok: false, error: { code: "send_disabled" } });
  });

  it("handles a message with no tool calls", async () => {
    const tk = mockWorld().toolkit();
    expect(await runOpenAIChatToolCalls(tk, undefined)).toEqual([]);
    expect(await runOpenAIChatToolCalls(tk, null)).toEqual([]);
    expect(await runOpenAIResponsesToolCalls(tk, [])).toEqual([]);
  });
});
