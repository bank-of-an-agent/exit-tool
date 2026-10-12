import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/cli.ts", index: "src/index.ts" },
  format: ["esm"],
  platform: "node",
  target: "node22",
  // tsup's declaration build sets `baseUrl`, which TypeScript 6 deprecates.
  dts: { entry: { index: "src/index.ts" }, compilerOptions: { ignoreDeprecations: "6.0" } },
  sourcemap: true,
  clean: true,
  splitting: true,
  // viem is a pinned runtime dependency; everything else is ours.
  external: ["viem"],
});
