import { jsonSchema, tool, type Tool } from "ai";

import type { RailPayToolkit, ToolResult } from "../toolkit.js";

export type AiSdkTools = Record<string, Tool<Record<string, unknown>, ToolResult>>;

/**
 * The toolkit's tools for the Vercel AI SDK (`ai` v7): pass the result as `tools` to generateText / streamText.
 * Schemas go through `jsonSchema()`, so zod is not needed. The model gets the structured result object.
 */
export function aiSdkTools(toolkit: RailPayToolkit): AiSdkTools {
  const out: AiSdkTools = {};
  for (const t of toolkit.tools) {
    out[t.name] = tool({
      description: t.description,
      inputSchema: jsonSchema<Record<string, unknown>>(t.inputSchema),
      execute: (input: Record<string, unknown>, { abortSignal }): Promise<ToolResult> => t.execute(input, { signal: abortSignal }),
    });
  }
  return out;
}
