import { toolError } from "../errors.js";
import type { ObjectSchema } from "../schema.js";
import { resultText, type RailPayToolkit, type ToolContext } from "../toolkit.js";

// Structural types: nothing is imported from `openai`, at runtime or for types. They are assignable to
// ChatCompletionFunctionTool, FunctionTool, ChatCompletionToolMessageParam and the function_call_output input item.

export type OpenAIChatTool = {
  type: "function";
  function: { name: string; description: string; parameters: ObjectSchema; strict: false };
};

export type OpenAIResponsesTool = { type: "function"; name: string; description: string; parameters: ObjectSchema; strict: false };

export type OpenAIToolMessage = { role: "tool"; tool_call_id: string; content: string };

export type OpenAIFunctionCallOutput = { type: "function_call_output"; call_id: string; output: string };

/** Tools for Chat Completions (`tools` of chat.completions.create). Not strict: some inputs are optional. */
export function openaiChatTools(toolkit: RailPayToolkit): OpenAIChatTool[] {
  return toolkit.tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.inputSchema, strict: false },
  }));
}

/** Tools for the Responses API (`tools` of responses.create). Not strict: some inputs are optional. */
export function openaiResponsesTools(toolkit: RailPayToolkit): OpenAIResponsesTool[] {
  return toolkit.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.inputSchema, strict: false }));
}

async function runCall(toolkit: RailPayToolkit, name: string, args: string, context?: ToolContext): Promise<string> {
  let input: unknown;
  try {
    input = args.trim() ? JSON.parse(args) : {};
  } catch {
    return resultText({ ok: false, error: toolError("invalid_input", "The tool arguments are not valid JSON", "input") });
  }
  return resultText(await toolkit.run(name, input, context));
}

/**
 * Run the RailPay calls of an assistant message (`message.tool_calls`) and return the `role: "tool"` messages to append.
 * Calls to tools that are not RailPay's are skipped: answer those yourself. Calls run one after another,
 * so the session budget sees them in order.
 */
export async function runOpenAIChatToolCalls(
  toolkit: RailPayToolkit,
  toolCalls: readonly { id: string; type: string }[] | null | undefined,
  context?: ToolContext,
): Promise<OpenAIToolMessage[]> {
  const out: OpenAIToolMessage[] = [];
  for (const call of toolCalls ?? []) {
    if (call.type !== "function") continue;
    const fn = (call as { function?: { name?: unknown; arguments?: unknown } }).function;
    if (!fn || typeof fn.name !== "string" || !toolkit.has(fn.name)) continue;
    out.push({ role: "tool", tool_call_id: call.id, content: await runCall(toolkit, fn.name, typeof fn.arguments === "string" ? fn.arguments : "", context) });
  }
  return out;
}

/**
 * Run the RailPay `function_call` items of a Responses API output (`response.output`) and return the
 * `function_call_output` items to send back. Other items and other tools are skipped.
 */
export async function runOpenAIResponsesToolCalls(
  toolkit: RailPayToolkit,
  output: readonly { type: string }[] | null | undefined,
  context?: ToolContext,
): Promise<OpenAIFunctionCallOutput[]> {
  const out: OpenAIFunctionCallOutput[] = [];
  for (const item of output ?? []) {
    if (item.type !== "function_call") continue;
    const call = item as { name?: unknown; call_id?: unknown; arguments?: unknown };
    if (typeof call.name !== "string" || typeof call.call_id !== "string" || !toolkit.has(call.name)) continue;
    out.push({
      type: "function_call_output",
      call_id: call.call_id,
      output: await runCall(toolkit, call.name, typeof call.arguments === "string" ? call.arguments : "", context),
    });
  }
  return out;
}
