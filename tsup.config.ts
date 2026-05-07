import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
  },
  format: ["esm"],
  dts: { entry: { index: "src/index.ts" } }, // .d.ts only for the SDK entry, not the CLI
  clean: true,
  target: "node20",
  splitting: false,
  sourcemap: true,
  outDir: "dist",
  // Preserve the #!/usr/bin/env node shebang at the top of cli.ts so
  // dist/cli.js is directly executable (referenced by the bin field in
  // package.json).
  shims: false,
});
