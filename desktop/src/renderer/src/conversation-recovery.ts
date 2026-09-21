export type RecoverableTaskResponse = {
  finalResponse?: { content: string };
  lastProgress?: { stage?: string; message: string };
};

/** Live data wins while connected; durable task data keeps completed replies visible after event eviction. */
export function resolveTaskReply(
  task: RecoverableTaskResponse,
  eventReply: string | undefined,
  streamedMarkdown: string,
): string {
  if (eventReply !== undefined) return eventReply;
  if (streamedMarkdown) return streamedMarkdown;
  if (task.finalResponse?.content) return task.finalResponse.content;
  return task.lastProgress?.stage === 'user_response' ? task.lastProgress.message : '';
}
