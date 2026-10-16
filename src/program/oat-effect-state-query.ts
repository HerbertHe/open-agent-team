import type { TaskManager } from "../orchestrator/task-manager";
import { QueuedTaskStatusEnum } from "../types";
import { effectDigest, type Effect } from "./effect-ledger";
import type { ProviderEffectState } from "./effect-reconciler";

/** Read existing durable OAT facts; this adapter never re-executes the original tool. */
export async function queryOatEffectState(store: Pick<TaskManager, "getTasks" | "listReleaseProposals" | "listReviewRequests">, effect: Effect): Promise<ProviderEffectState> {
  const task = store.getTasks().find((item) => item.executionContext?.attemptId === effect.attemptId && item.executionContext.programId === effect.programId);
  if (effect.effectType === "report-progress" && task?.lastProgress
    && effectDigest({ message: task.lastProgress.message, stage: task.lastProgress.stage ?? null }) === effect.request.progressDigest) {
    return { state: "confirmed", receipt: { evidence: "task_progress", taskId: task.id } };
  }
  if (["notify-complete", "submit-review"].includes(effect.effectType) && task
    && [QueuedTaskStatusEnum.Completed, QueuedTaskStatusEnum.ReviewPending].includes(task.status as QueuedTaskStatusEnum)
    && (effect.effectType === "notify-complete" || task.git?.headSha)) {
    return { state: "confirmed", receipt: { evidence: "task_delivery", taskId: task.id, status: task.status, headSha: task.git?.headSha ?? null } };
  }
  if (typeof effect.request.proposalId === "string") {
    const proposal = (await store.listReleaseProposals()).find((item) => item.id === effect.request.proposalId);
    if (proposal && ((effect.effectType === "push-release" && proposal.pushedAt) || (effect.effectType === "approve-release" && proposal.approvedAt))) {
      return { state: "confirmed", receipt: { evidence: "release_proposal", proposalId: proposal.id, headSha: proposal.headSha } };
    }
  }
  if (effect.effectType === "review-worker-branch" && typeof effect.request.reviewId === "string" && typeof effect.request.agentId === "string") {
    const review = (await store.listReviewRequests(effect.request.agentId)).find((item) => item.id === effect.request.reviewId);
    if (review && ((effect.request.approve === true && review.status === "merged") || (effect.request.approve === false && review.status === "changes_requested"))) {
      return { state: "confirmed", receipt: { evidence: "review_record", reviewId: review.id, status: review.status, headSha: review.headSha } };
    }
  }
  return { state: "unknown", reason: "no_authoritative_tool_state" };
}
