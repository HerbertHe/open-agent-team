import assert from "node:assert/strict";
import test from "node:test";
import { IntegratedLongHorizonSimulator } from "./integrated-long-horizon-simulator";
import { LongHorizonSimulator, VirtualClock } from "./long-horizon-simulator";
import { hasIntegratedSimulationEvidence } from "./simulation-evidence";

test("90-day real-component simulation completes, survives faults, and reproduces semantic evidence", async () => {
  const runner = new IntegratedLongHorizonSimulator();
  const first = await runner.run({ seed: "integrated-regression" });
  const second = await runner.run({ seed: "integrated-regression" });
  assert.deepEqual(first, second); assert.equal(first.passed, true); assert.equal(hasIntegratedSimulationEvidence(first), true);
  assert.equal(first.integration!.faults.length, 6); assert.equal(first.integration!.measurements.completedPrograms, 2);
  assert.ok(first.integration!.measurements.evidence >= 8); assert.ok(first.integration!.measurements.replans > 0);
  assert.ok(first.events.provider429 > 0); assert.ok(first.events.provider500 > 0); assert.ok(first.events.provider402 > 0);
  assert.ok(first.events.backupRestores > 0); assert.ok(first.events.resumes > 0);
  const changed = structuredClone(first); changed.events.restarts++;
  assert.equal(hasIntegratedSimulationEvidence(changed), false);
  assert.equal(hasIntegratedSimulationEvidence({ ...new LongHorizonSimulator().run({ seed: "forged" }), evidenceLevel: "integrated" }), false);
});

test("integrated runner supports multiple Programs and rejects unsafe or unbounded input", async () => {
  const runner = new IntegratedLongHorizonSimulator();
  const result = await runner.run({ seed: "portfolio", programs: 3 });
  assert.equal(result.passed, true); assert.equal(result.integration!.measurements.completedPrograms, 3);
  for (const input of [{ seed: "x", days: 89 }, { seed: "x", programs: 1 }, { seed: "x", days: Infinity }, { seed: "x", programs: 100 }, { seed: "" }, { seed: "x", startAt: "invalid" }]) {
    await assert.rejects(runner.run(input), RangeError);
  }
  assert.throws(() => new VirtualClock("invalid"), RangeError);
  assert.throws(() => new VirtualClock("2026-01-01").advance(NaN), RangeError);
});
