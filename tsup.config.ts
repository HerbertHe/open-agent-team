import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "dist",
  format: ["esm"],
  target: "es2023",
  sourcemap: true,
  clean: true,
  splitting: false,
  dts: false,
});

