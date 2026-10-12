import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { evaluateRuntimeHookSpike, PI_RUNTIME_HOOK_COVERAGE } from "./runtime-hook-capability";

const sdkEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const distDir = path.dirname(sdkEntry);

function sdkSource(relativePath: string): string {
  return readFileSync(path.join(distDir, relativePath), "utf8");
}

test("BLH-002 injected ModelRuntime is the shared model-call seam", () => {
  const sdk = sdkSource("core/sdk.js");
  assert.match(sdk, /streamFn:\s*async[\s\S]*modelRuntime\.streamSimple\(model, context/);
  assert.match(sdk, /before_provider_request/);
  assert.match(sdk, /after_provider_response/);
});

test("BLH-002 compaction and branch summaries reuse the Agent stream function", () => {
  const session = sdkSource("core/agent-session.js");
  const uses = session.match(/this\.agent\.streamFunction/g) ?? [];
  assert.ok(uses.length >= 3, `expected at least three streamFunction reuse sites, found ${uses.length}`);
  assert.match(session, /_autoCompactionAbortController[\s\S]*this\.agent\.streamFunction/);
  assert.match(session, /branch[\s\S]*streamFn:\s*this\.agent\.streamFunction/i);
});

test("BLH-002 public SDK surface exposes provider hooks and cooperative abort", () => {
  const extensionTypes = sdkSource("core/extensions/types.d.ts");
  const sessionTypes = sdkSource("core/agent-session.d.ts");
  assert.match(extensionTypes, /on\(event:\s*"before_provider_request"/);
  assert.match(extensionTypes, /on\(event:\s*"after_provider_response"/);
  assert.match(sessionTypes, /abort\(\):\s*Promise<void>/);
  assert.match(sessionTypes, /waitForIdle\(\):\s*Promise<void>/);
});

test("BLH-002 coverage decision remains conservative until retry and billing identity are proven", () => {
  assert.equal(new Set(PI_RUNTIME_HOOK_COVERAGE.map((item) => item.path)).size, PI_RUNTIME_HOOK_COVERAGE.length);
  const decision = evaluateRuntimeHookSpike();
  assert.equal(decision.hardModeEligible, false);
  assert.deepEqual(
    decision.blockers.map((item) => item.path),
    ["provider_internal_retry", "usage_and_request_identity"],
  );
});
