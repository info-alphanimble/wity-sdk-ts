import { defineConfig } from "tsdown";

// Builds dist/ with both `import` (.mjs) and `require` (.cjs) files, plus type files.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  platform: "neutral",
  target: "node20",
  dts: true,
  clean: true,
  fixedExtension: true,
});
