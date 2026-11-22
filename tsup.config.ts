import { defineConfig } from "tsup";

export default defineConfig({
  // One entry per subpath export. The frameworks are optional peer dependencies and stay external.
  entry: {
    index: "src/index.ts",
    ai: "src/adapters/ai.ts",
    openai: "src/adapters/openai.ts",
  },
  format: ["esm"],
  // railpay-sdk is bundled: it is not on npm, and pnpm refuses URL or git dependencies of a dependency.
  // Only the agent side of the SDK is used. Its seller code, and so viem, is left out of the bundle:
  // the SDK's module-level viem calls are marked pure so tree-shaking can drop them.
  noExternal: ["railpay-sdk"],
  external: ["viem"],
  treeshake: {
    preset: "recommended",
    manualPureFunctions: ["parseAbi", "toEventSelector"],
    moduleSideEffects: (id: string, external: boolean) => !external,
  },
  dts: { resolve: ["railpay-sdk"] },
  sourcemap: true,
  clean: true,
  // Shared chunks, so every entry point uses the same toolkit code.
  splitting: true,
  target: "es2022",
  platform: "neutral",
});
