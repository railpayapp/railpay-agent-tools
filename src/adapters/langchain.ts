import { DynamicStructuredTool } from "@langchain/core/tools";

import { resultText, type RailPayToolkit } from "../toolkit.js";

/**
 * The toolkit's tools as LangChain.js tools (DynamicStructuredTool from @langchain/core, with the JSON Schema, no zod).
 * Each returns the result as JSON text, refusals included. Use with `model.bindTools(tools)`, ToolNode or createAgent.
 */
export function langchainTools(toolkit: RailPayToolkit): DynamicStructuredTool[] {
  return toolkit.tools.map(
    (t) =>
      new DynamicStructuredTool({
        name: t.name,
        description: t.description,
        schema: t.inputSchema,
        func: async (input: Record<string, unknown>, _runManager, config) => resultText(await t.execute(input, { signal: config?.signal })),
      }),
  );
}
