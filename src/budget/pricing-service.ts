import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type Database from "better-sqlite3";
import type { ExecutionDatabase } from "../program/execution-database";
import { OpaqueIdSchema, ProgramIdSchema } from "../program/program-types";
import {
  GlobalModelPriceSchema,
  type GlobalModelCatalog,
  type GlobalModelPrice,
} from "../models/global-models";
import { BudgetArithmeticError, BudgetVectorSchema, type BudgetVector } from "./budget-types";

const TimestampSchema = z.string().datetime({ offset: true }).transform((value) => new Date(value).toISOString());
const PricingEntriesSchema = z.record(z.string().trim().min(1), GlobalModelPriceSchema);

export const PricingSnapshotSchema = z.object({
  id: OpaqueIdSchema,
  programId: ProgramIdSchema,
  catalogRevision: OpaqueIdSchema,
  prices: PricingEntriesSchema,
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: TimestampSchema,
}).strict();
export type PricingSnapshot = z.infer<typeof PricingSnapshotSchema>;

export interface ModelUsageEstimate {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

function canonicalPrices(prices: Record<string, GlobalModelPrice>): Record<string, GlobalModelPrice> {
  return Object.fromEntries(Object.entries(PricingEntriesSchema.parse(prices)).sort(([left], [right]) => left.localeCompare(right)));
}

function digestPrices(catalogRevision: string, prices: Record<string, GlobalModelPrice>): string {
  return createHash("sha256").update(JSON.stringify({ catalogRevision, prices: canonicalPrices(prices) })).digest("hex");
}

export function pricingSnapshotFromCatalog(
  id: string,
  programId: string,
  catalog: GlobalModelCatalog,
  createdAt: string,
): PricingSnapshot {
  const prices = canonicalPrices(catalog.pricing);
  return PricingSnapshotSchema.parse({
    id, programId, catalogRevision: catalog.pricingRevision, prices,
    digest: digestPrices(catalog.pricingRevision, prices), createdAt,
  });
}

export function insertPricingSnapshot(database: Database.Database, input: PricingSnapshot): PricingSnapshot {
  const snapshot = PricingSnapshotSchema.parse(input);
  database.prepare(`
    INSERT INTO pricing_snapshots(id, program_id, catalog_revision, prices_json, digest, created_at)
    VALUES(?, ?, ?, ?, ?, ?)
  `).run(snapshot.id, snapshot.programId, snapshot.catalogRevision, JSON.stringify(snapshot.prices), snapshot.digest, snapshot.createdAt);
  return snapshot;
}

function rowToSnapshot(row: {
  id: string; program_id: string; catalog_revision: string; prices_json: string; digest: string; created_at: string;
}): PricingSnapshot {
  const snapshot = PricingSnapshotSchema.parse({
    id: row.id, programId: row.program_id, catalogRevision: row.catalog_revision,
    prices: JSON.parse(row.prices_json) as unknown, digest: row.digest, createdAt: row.created_at,
  });
  if (snapshot.digest !== digestPrices(snapshot.catalogRevision, snapshot.prices)) throw new Error(`Pricing snapshot ${snapshot.id} digest mismatch`);
  return snapshot;
}

function pricedTokens(tokens: number, rate: number, dimension: string): number {
  if (!Number.isSafeInteger(tokens) || tokens < 0) throw new RangeError(`${dimension} must be a non-negative safe integer`);
  const result = (BigInt(tokens) * BigInt(rate) + 999_999n) / 1_000_000n;
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new BudgetArithmeticError("BUDGET_OVERFLOW", "moneyMicros");
  return Number(result);
}

export class PricingService {
  constructor(private readonly database: Database.Database) {}
  static from(handle: ExecutionDatabase): PricingService { return new PricingService(handle.connection); }

  createSnapshot(input: PricingSnapshot): PricingSnapshot {
    return this.database.transaction(() => insertPricingSnapshot(this.database, input)).immediate();
  }

  getSnapshot(id: string): PricingSnapshot | undefined {
    const row = this.database.prepare("SELECT * FROM pricing_snapshots WHERE id = ?").get(id) as Parameters<typeof rowToSnapshot>[0] | undefined;
    return row ? rowToSnapshot(row) : undefined;
  }

  estimate(snapshotId: string, modelRef: string, usage: ModelUsageEstimate): BudgetVector {
    const snapshot = this.getSnapshot(snapshotId);
    if (!snapshot) throw new Error(`Pricing snapshot ${snapshotId} was not found`);
    const price = snapshot.prices[modelRef];
    if (!price) throw new Error(`Model ${modelRef} is absent from pricing snapshot ${snapshotId}`);
    const money = [
      price.fixedRequestMicros,
      pricedTokens(usage.inputTokens, price.inputMicrosPerMillionTokens, "inputTokens"),
      pricedTokens(usage.outputTokens, price.outputMicrosPerMillionTokens, "outputTokens"),
      pricedTokens(usage.cacheReadTokens ?? 0, price.cacheReadMicrosPerMillionTokens, "cacheReadTokens"),
      pricedTokens(usage.cacheWriteTokens ?? 0, price.cacheWriteMicrosPerMillionTokens, "cacheWriteTokens"),
    ].reduce((total, value) => {
      const next = total + value;
      if (!Number.isSafeInteger(next)) throw new BudgetArithmeticError("BUDGET_OVERFLOW", "moneyMicros");
      return next;
    }, 0);
    return BudgetVectorSchema.parse({
      moneyMicros: money, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, modelCalls: 1,
    });
  }

  verifyCurrentPrice(snapshotId: string, modelRef: string, catalog: GlobalModelCatalog): {
    allowed: boolean; reason?: "MODEL_PRICE_MISSING" | "PRICING_CHANGED";
  } {
    const snapshot = this.getSnapshot(snapshotId);
    if (!snapshot) return { allowed: false, reason: "MODEL_PRICE_MISSING" };
    const frozen = snapshot.prices[modelRef];
    const current = catalog.pricing[modelRef];
    if (!frozen || !current) return { allowed: false, reason: "MODEL_PRICE_MISSING" };
    if (snapshot.catalogRevision !== catalog.pricingRevision || !isDeepStrictEqual(frozen, current)) {
      return { allowed: false, reason: "PRICING_CHANGED" };
    }
    return { allowed: true };
  }
}
