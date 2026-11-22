import type { ObjectSchema } from "../schema.js";
import { resultText, type RailPayToolkit, type ToolContext } from "../toolkit.js";

// Structural types: nothing is imported from `@anthropic-ai/sdk`, at runtime or for types.
// They are assignable to Anthropic.Tool and Anthropic.ToolResultBlockParam.

export type AnthropicTool = { name: string; description: string; input_schema: ObjectSchema };

export type AnthropicToolResult = { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

/** Tool definitions for the Messages API (`tools` of messages.create). */
export function anthropicTools(toolkit: RailPayToolkit): AnthropicTool[] {
  return toolkit.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
}

/**
 * Run the RailPay `tool_use` blocks of an assistant message (`message.content`) and return the `tool_result`
 * blocks to send back in the next user message. Blocks for other tools, and toolset members such as the
 * browser tools, are skipped: answer those yourself, in the same user message. Refusals are marked
 * `is_error: true`. Calls run one after another, so the session budget sees them in order.
 */
export async function runAnthropicToolUses(
  toolkit: RailPayToolkit,
  content: readonly { type: string }[] | null | undefined,
  context?: ToolContext,
): Promise<AnthropicToolResult[]> {
  const out: AnthropicToolResult[] = [];
  for (const block of content ?? []) {
    if (block.type !== "tool_use") continue;
    const use = block as { id?: unknown; name?: unknown; input?: unknown; toolset_name?: unknown };
    if (typeof use.id !== "string" || typeof use.name !== "string" || use.toolset_name != null || !toolkit.has(use.name)) continue;
    const result = await toolkit.run(use.name, use.input, context);
    out.push({ type: "tool_result", tool_use_id: use.id, content: resultText(result), ...(result.ok ? {} : { is_error: true }) });
  }
  return out;
}
