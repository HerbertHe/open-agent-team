export type FaultPoint = "reservation_after_account_update" | "dispatch_after_provider_accept" |
  "settlement_before_commit" | "lease_after_acquire" | "snapshot_after_manifest" | "resume_after_epoch_increment";

export class InjectedCrashError extends Error {
  constructor(readonly point: FaultPoint) { super(`Injected crash at ${point}`); this.name = "InjectedCrashError"; }
}

/** Deterministic, one-shot fault injection. Production construction leaves every point disarmed. */
export class FaultInjectionHarness {
  private readonly armed = new Set<FaultPoint>();
  arm(...points: FaultPoint[]): void { for (const point of points) this.armed.add(point); }
  hit(point: FaultPoint): void {
    if (!this.armed.delete(point)) return;
    throw new InjectedCrashError(point);
  }
  isArmed(point: FaultPoint): boolean { return this.armed.has(point); }
}
