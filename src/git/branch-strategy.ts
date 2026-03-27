export function leaderBranch(prefix: string): string {
  return prefix;
}

export function workerBranch(prefix: string, workerIndex: number): string {
  return `${prefix}/worker-${workerIndex}`;
}

export function isWorkerPushAllowed(branch: string): boolean {
  return /.+\/worker-\d+$/.test(branch);
}
