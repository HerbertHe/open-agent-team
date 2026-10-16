import { writeFileSync } from "node:fs";
import path from "node:path";
import { IntegratedLongHorizonSimulator } from "../src/program/integrated-long-horizon-simulator";

// All execution state is isolated and removed by the runner; only this report is exported.
const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`Missing value for ${name}`);
  return args[index + 1];
};
const result = await new IntegratedLongHorizonSimulator().run({ seed: option("--seed", "program-ci-v1"),
  days: Number(option("--days", "90")), programs: Number(option("--programs", "2")) });
const output = option("--output", "");
const json = `${JSON.stringify(result, null, 2)}\n`;
if (output) writeFileSync(path.resolve(output), json, { mode: 0o600 });
process.stdout.write(json);
if (!result.passed) process.exitCode = 1;
