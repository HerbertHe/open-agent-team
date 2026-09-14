import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    // agent-runner 作为独立的子进程入口，编译为 dist/sandbox/agent-runner.js
    "src/sandbox/agent-runner.ts",
    // Zvec 同步原生 API 仅在独立 Worker Thread 内运行。
    "src/memory/zvec-memory-index-worker.ts",
  ],
  outDir: "dist",
  format: ["esm"],
  target: "es2023",
  sourcemap: false,
  clean: true,
  splitting: false,
  dts: false,
});
