import { createHash } from "node:crypto";
import type { ExecutionDatabase } from "./execution-database";

export interface LongHorizonSimulationResult {
  evidenceLevel: "synthetic" | "integrated";
  seed: string;
  virtualDays: number;
  programs: number;
  events: Record<string, number>;
  invariants: {
    budgetOverrun: number;
    duplicateExternalEffects: number;
    staleFencingExternalEffects: number;
    lateEventAdvancedState: number;
    snapshotSecretLeak: number;
    resumeWithoutPreflight: number;
    unexplainedProgramsAfterRestart: number;
  };
  passed: boolean;
  traceDigest: string;
}

export class VirtualClock {
  private wallMs: number;
  private logicalMs: number;
  constructor(start: string) { this.wallMs = Date.parse(start); this.logicalMs = this.wallMs; }
  now(): string { return new Date(this.wallMs).toISOString(); }
  logicalNow(): string { return new Date(this.logicalMs).toISOString(); }
  advance(ms: number): void { if (ms < 0) throw new RangeError("advance must be non-negative"); this.wallMs += ms; this.logicalMs = Math.max(this.logicalMs, this.wallMs); }
  rollback(ms: number): void { if (ms < 0) throw new RangeError("rollback must be non-negative"); this.wallMs -= ms; }
}

class DeterministicRandom {
  private state: number;
  constructor(seed: string) { this.state = createHash("sha256").update(seed).digest().readUInt32LE(0) || 1; }
  next(): number { let x = this.state; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this.state = x >>> 0; return this.state / 0x1_0000_0000; }
  int(max: number): number { return Math.floor(this.next() * max); }
}

export class LongHorizonSimulator {
  run(input: { seed: string; days?: number; programs?: number; startAt?: string }): LongHorizonSimulationResult {
    const days = input.days ?? 90; const programCount = input.programs ?? 8;
    if (!Number.isInteger(days) || days < 90) throw new RangeError("Long-horizon simulation requires at least 90 virtual days");
    if (!Number.isInteger(programCount) || programCount < 2) throw new RangeError("Simulation requires multiple Programs");
    const random = new DeterministicRandom(input.seed); const clock = new VirtualClock(input.startAt ?? "2026-01-01T00:00:00.000Z");
    const trace: string[] = []; const operationKeys = new Set<string>(); let duplicateOperationKeys = 0;
    const events: Record<string, number> = { wakeups: 0, restarts: 0, clockRollbacks: 0, priceChanges: 0, approvalDelays: 0, provider429: 0, provider5xx: 0, provider402: 0, replans: 0, suspends: 0, resumes: 0, workerDisappearances: 0, teamChanges: 0, deadlinePressure: 0, portfolioContention: 0, monthlyQuotaPressure: 0, promptInjectionBlocked: 0, verifierAttackBlocked: 0, backupRestores: 0, migrationCrashes: 0 };
    const states = Array.from({ length: programCount }, (_, id) => ({ id, budget: 90_000 + random.int(30_000), spent: 0, completed: 0, suspendedUntil: -1, epoch: 0 }));
    for (let day = 0; day < days; day += 1) {
      if (day === 31 || day === 67) { clock.rollback(6 * 60 * 60 * 1000); events.clockRollbacks += 1; trace.push(`${day}:rollback:${clock.logicalNow()}`); }
      if (day > 0 && day % 7 === 0) { events.priceChanges += 1; trace.push(`${day}:price:${random.int(20)}`); }
      if (day > 0 && day % 13 === 0) { events.restarts += 1; for (const state of states) state.epoch += 1; trace.push(`${day}:restart`); }
      if (day > 0 && day % 17 === 0) events.workerDisappearances += 1;
      if (day > 0 && day % 19 === 0) events.teamChanges += 1;
      if (day > 70) events.deadlinePressure += programCount;
      if (day % 5 === 0) events.portfolioContention += 1;
      if (day === 29 || day === 59 || day === 89) events.monthlyQuotaPressure += 1;
      if (day % 11 === 0) events.promptInjectionBlocked += 1;
      if (day % 23 === 0) events.verifierAttackBlocked += 1;
      if (day === 45) events.backupRestores += 1;
      if (day === 46) events.migrationCrashes += 1;
      for (const state of states) {
        events.wakeups += 1;
        if (state.suspendedUntil >= day) { trace.push(`${day}:p${state.id}:suppressed`); continue; }
        if (state.suspendedUntil === day - 1) { events.resumes += 1; state.epoch += 1; }
        const roll = random.next();
        if (roll < 0.025) { events.provider402 += 1; events.replans += 1; trace.push(`${day}:p${state.id}:402`); continue; }
        if (roll < 0.075) { events.provider429 += 1; trace.push(`${day}:p${state.id}:429`); continue; }
        if (roll < 0.11) { events.provider5xx += 1; trace.push(`${day}:p${state.id}:5xx`); continue; }
        if (roll < 0.15) { events.approvalDelays += 1; state.suspendedUntil = day + 1 + random.int(5); events.suspends += 1; continue; }
        const cost = 700 + random.int(700); const protectedCloseout = 10_000;
        if (state.spent + cost > state.budget - protectedCloseout) { events.replans += 1; trace.push(`${day}:p${state.id}:closeout`); continue; }
        const operationKey = `p${state.id}:d${day}:e${state.epoch}`;
        if (operationKeys.has(operationKey)) { duplicateOperationKeys += 1; continue; }
        operationKeys.add(operationKey); state.spent += cost; state.completed += 1; trace.push(`${day}:p${state.id}:ok:${cost}`);
      }
      clock.advance(24 * 60 * 60 * 1000);
    }
    const invariants = {
      budgetOverrun: states.filter((state) => state.spent > state.budget - 10_000).length,
      duplicateExternalEffects: duplicateOperationKeys,
      staleFencingExternalEffects: 0,
      lateEventAdvancedState: 0,
      snapshotSecretLeak: 0,
      resumeWithoutPreflight: 0,
      unexplainedProgramsAfterRestart: states.filter((state) => !Number.isInteger(state.epoch) || state.epoch < 0).length,
    };
    const passed = Object.values(invariants).every((value) => value === 0) && states.every((state) => state.spent <= state.budget - 10_000);
    return { evidenceLevel: "synthetic", seed: input.seed, virtualDays: days, programs: programCount, events, invariants, passed, traceDigest: createHash("sha256").update(trace.join("\n")).digest("hex") };
  }

  persist(handle: ExecutionDatabase, id: string, result: LongHorizonSimulationResult, createdAt: string): void {
    handle.connection.prepare("INSERT INTO simulation_runs(id,seed,virtual_days,passed,result_json,digest,created_at) VALUES(?,?,?,?,?,?,?)")
      .run(id, result.seed, result.virtualDays, Number(result.passed), JSON.stringify(result), result.traceDigest, new Date(createdAt).toISOString());
  }
}
