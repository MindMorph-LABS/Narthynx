import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli/index.ts"],
  format: ["esm"],
  clean: true,
  dts: true,
  sourcemap: true,
  target: "node20",
  splitting: false,
  banner: {
    js: "#!/usr/bin/env node"
  }
});
