import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ExecutionDatabase } from "./execution-database";
import { ExecutionBarrier } from "./execution-barrier";
import { ExecutionAuditRepository } from "./execution-audit-repository";
import { ExecutionOutboxRepository } from "./execution-outbox";
import { OpaqueIdSchema } from "./program-types";
import { WakeupService } from "./wakeup-service";

const Payload = z.object({ kind: z.literal("scheduler_tick"), executionEpoch: z.number().int().nonnegative(),
  planVersionId: OpaqueIdSchema, wakeupId: OpaqueIdSchema }).strict();
const ACTIVE = ["admitted", "running", "waiting", "closing_out"];
interface ProgramRow { id: string; status: string; execution_epoch: number; active_plan_version_id: string | null }

/** Durable scheduler heartbeat. Delivery is at least once; the coordinator's leases
 * and dispatch intents make replay safe. Production uses a separate durable
 * scheduler owner to filter claims and fence dispatch. */
export class ProgramWakeupRuntime {
  private readonly wakeups: WakeupService;
  private readonly outbox: ExecutionOutboxRepository;
  private readonly barrier: ExecutionBarrier;
  private readonly workerId = `wakeup-worker:${randomUUID()}`;
  private inFlight?: Promise<void>;
  private stopped = false;

  constructor(private readonly handle: ExecutionDatabase,
    private readonly tick: (programId: string, now: string) => Promise<unknown>,
    private readonly clock: () => string = () => new Date().toISOString(),
    private readonly intervalMs = 10_000,
    private readonly onError: (error: unknown) => void = () => {}, private readonly instanceId?: string) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new RangeError("intervalMs must be positive");
    this.wakeups = new WakeupService(handle);
    this.outbox = new ExecutionOutboxRepository(handle);
    this.barrier = new ExecutionBarrier(handle);
  }

  poll(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.advance().finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  async stop(): Promise<void> { this.stopped = true; await this.inFlight; }

  private program(id: string): ProgramRow | undefined {
    return this.handle.connection.prepare("SELECT id,status,execution_epoch,active_plan_version_id FROM programs WHERE id=?").get(id) as ProgramRow | undefined;
  }

  private ensureScheduled(program: ProgramRow, wakeAt: string, now: string): void {
    if (!ACTIVE.includes(program.status) || !program.active_plan_version_id || (program.status !== "closing_out" && this.barrier.isFrozen(program.id))) return;
    // Keep the original deadline across restarts and clock rollback. A claimed
    // event also counts, so a slow delivery cannot generate a second heartbeat.
    const outstanding = this.handle.connection.prepare(`SELECT 1 FROM wakeups w LEFT JOIN execution_outbox o ON o.id=w.outbox_event_id
      WHERE w.program_id=? AND json_extract(w.payload_json,'$.kind')='scheduler_tick'
      AND json_extract(w.payload_json,'$.executionEpoch')=? AND json_extract(w.payload_json,'$.planVersionId')=?
      AND (w.state='pending' OR (w.state='dispatched' AND o.state IN ('pending','publishing'))) LIMIT 1`)
      .get(program.id, program.execution_epoch, program.active_plan_version_id);
    if (outstanding) return;
    this.wakeups.schedule({ programId: program.id, dedupeKey: `scheduler:${randomUUID()}`, wakeAt,
      payload: { kind: "scheduler_tick", executionEpoch: program.execution_epoch, planVersionId: program.active_plan_version_id }, createdAt: now });
  }

  private async advance(): Promise<void> {
    const now = new Date(this.clock()).toISOString();
    this.handle.connection.transaction(() => {
      const programs = this.handle.connection.prepare("SELECT id,status,execution_epoch,active_plan_version_id FROM programs WHERE status IN ('admitted','running','waiting','closing_out') ORDER BY id").all() as ProgramRow[];
      for (const program of programs) this.ensureScheduled(program, now, now);
    }).immediate();
    this.wakeups.dispatchDue({ now, limit: 100 });
    for (let count = 0; count < 100 && !this.stopped; count++) {
      const at = new Date(this.clock()).toISOString();
      const later = new Date(Date.parse(at) + this.intervalMs).toISOString();
      const event = this.outbox.claimNext({ workerId: this.workerId, now: at,
        leaseExpiresAt: new Date(Date.parse(at) + 60_000).toISOString(), eventType: "program.wakeup_due", schedulerOwnerId: this.instanceId });
      if (!event) return;
      let renewal: NodeJS.Timeout | undefined;
      try {
        const payload = Payload.parse(event.payload);
        const wakeup = this.handle.connection.prepare("SELECT program_id,outbox_event_id FROM wakeups WHERE id=?").get(payload.wakeupId) as { program_id: string; outbox_event_id: string } | undefined;
        if (!wakeup || wakeup.program_id !== event.aggregateId || wakeup.outbox_event_id !== event.id || event.aggregateType !== "program") throw new Error("Wakeup event identity mismatch");
        const program = this.program(event.aggregateId);
        const stale = !program || program.execution_epoch !== payload.executionEpoch || program.active_plan_version_id !== payload.planVersionId;
        const terminal = program && ["completed", "incomplete", "cancelled"].includes(program.status);
        if (!stale && !terminal && (!ACTIVE.includes(program!.status) || (program!.status !== "closing_out" && this.barrier.isFrozen(program!.id)))) {
          this.outbox.defer(event.id, this.workerId, later);
          continue;
        }
        if (!stale && !terminal) {
          renewal = setInterval(() => {
            try {
              this.handle.connection.prepare("UPDATE execution_outbox SET lease_expires_at=? WHERE id=? AND state='publishing' AND lease_owner=?")
                .run(new Date(Date.parse(this.clock()) + 60_000).toISOString(), event.id, this.workerId);
            } catch (error) { this.onError(error); }
          }, 20_000);
          renewal.unref();
          const result = await this.tick(program!.id, at);
          if (result && typeof result === "object" && "mode" in result && result.mode === "standby") {
            this.outbox.defer(event.id, this.workerId, later);
            continue;
          }
        }
        const finishedAt = new Date(this.clock()).toISOString();
        this.handle.connection.transaction(() => {
          // Ack and next heartbeat commit together: a crash leaves either the
          // claimed event to replay or a persistent successor, never a gap.
          this.outbox.markPublished(event.id, this.workerId, finishedAt);
          new ExecutionAuditRepository(this.handle).append({ id: `audit:${event.id}`, programId: event.aggregateId,
            actorType: "service", actorId: this.workerId, eventType: "program.wakeup_consumed",
            metadata: { wakeupId: payload.wakeupId, outboxEventId: event.id, executionEpoch: payload.executionEpoch,
              outcome: stale ? "stale" : terminal ? "terminal" : "scheduled" }, createdAt: finishedAt });
          const current = this.program(event.aggregateId);
          if (current) this.ensureScheduled(current, new Date(Date.parse(finishedAt) + this.intervalMs).toISOString(), finishedAt);
        }).immediate();
      } catch (error) {
        this.onError(error);
        this.outbox.markFailed({ id: event.id, workerId: this.workerId, availableAt: later,
          error: error instanceof Error ? error.message : String(error), maxAttempts: 5 });
      } finally { if (renewal) clearInterval(renewal); }
    }
  }
}
