import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseGlobalModelCatalog } from "../models/global-models";
import { openExecutionDatabase } from "../program/execution-database";
import { migrateExecutionDatabase } from "../program/execution-migrations";
import { ProgramRepository } from "../program/execution-repositories";
import { ProgramSchema } from "../program/program-types";
import { PricingService, pricingSnapshotFromCatalog } from "./pricing-service";

const T0 = "2026-10-10T00:00:00.000Z";

test("BLH-015 immutable pricing snapshots replay estimates and freeze changed prices", () => {
  const root = mkdtempSync(path.join(tmpdir(), "oat-pricing-"));
  const handle = openExecutionDatabase(root);
  try {
    migrateExecutionDatabase(handle);
    new ProgramRepository(handle).create(ProgramSchema.parse({
      id: "program-1", projectId: "project-1", goal: "goal", status: "draft",
      executionEpoch: 0, revision: 0, createdAt: T0, updatedAt: T0,
    }));
    const catalog = parseGlobalModelCatalog({
      pricingRevision: "rev-1",
      pricing: {
        "provider/model": {
          providerId: "provider", modelId: "model",
          inputMicrosPerMillionTokens: 2_000_000,
          outputMicrosPerMillionTokens: 4_000_000,
          fixedRequestMicros: 7,
        },
      },
    });
    const service = PricingService.from(handle);
    const snapshot = service.createSnapshot(pricingSnapshotFromCatalog("price-1", "program-1", catalog, T0));
    assert.equal(snapshot.digest.length, 64);
    assert.deepEqual(service.estimate(snapshot.id, "provider/model", { inputTokens: 10, outputTokens: 5 }), {
      moneyMicros: 47, inputTokens: 10, outputTokens: 5, modelCalls: 1,
    });
    assert.deepEqual(service.verifyCurrentPrice(snapshot.id, "provider/model", catalog), { allowed: true });
    const changed = parseGlobalModelCatalog({
      ...catalog, pricingRevision: "rev-2",
      pricing: { "provider/model": { ...catalog.pricing["provider/model"]!, outputMicrosPerMillionTokens: 5_000_000 } },
    });
    assert.deepEqual(service.verifyCurrentPrice(snapshot.id, "provider/model", changed), {
      allowed: false, reason: "PRICING_CHANGED",
    });
    assert.equal(service.estimate(snapshot.id, "provider/model", { inputTokens: 10, outputTokens: 5 }).moneyMicros, 47);
  } finally { handle.close(); rmSync(root, { recursive: true, force: true }); }
});
