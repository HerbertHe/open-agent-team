import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    // agent-runner 作为独立的子进程入口，编译为 dist/sandbox/agent-runner.js
    "src/sandbox/agent-runner.ts",
  ],
  outDir: "dist",
  format: ["esm"],
  target: "es2023",
  sourcemap: false,
  clean: true,
  splitting: false,
  dts: false,
});
