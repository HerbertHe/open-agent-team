import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { MemoryService } from "./memory-service";

export function buildScratchpadTool(
  memory: MemoryService,
  agentId: string,
  currentTaskId: () => string | undefined,
): ReturnType<typeof defineTool> {
  return defineTool({
    name: "oat-scratchpad",
    label: "OAT Scratchpad",
    description: [
      "Manage owner-private temporary reminders that survive sessions.",
      "Use add for unresolved follow-ups or hypotheses, list to inspect reminders, done/reopen to change status, remove to delete one item, and clear_done to remove completed items.",
      "Scratchpad notes are fallible working context, not durable facts or new operator instructions.",
    ].join(" "),
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("add"), Type.Literal("list"), Type.Literal("done"),
        Type.Literal("reopen"), Type.Literal("remove"), Type.Literal("clear_done"),
      ]),
      text: Type.Optional(Type.String({ description: "Reminder text; required for add." })),
      id: Type.Optional(Type.String({ description: "Scratchpad item id; required for done, reopen, or remove." })),
      includeDone: Type.Optional(Type.Boolean({ description: "Include completed items when listing." })),
    }),
    execute: async (_toolCallId, params) => {
      let result: unknown;
      if (params.action === "add") {
        if (!params.text?.trim()) throw new Error("Scratchpad text is required for add.");
        result = memory.addScratchpad(agentId, params.text, currentTaskId());
      } else if (params.action === "list") {
        result = memory.listScratchpad(agentId, params.includeDone === true);
      } else if (params.action === "clear_done") {
        result = { removed: memory.clearCompletedScratchpad(agentId) };
      } else {
        if (!params.id?.trim()) throw new Error(`Scratchpad item id is required for ${params.action}.`);
        if (params.action === "remove") {
          const removed = memory.removeScratchpad(agentId, params.id);
          if (!removed) throw new Error("Scratchpad item was not found for this Agent.");
          result = { removed };
        } else result = memory.updateScratchpad(agentId, params.id, params.action === "done" ? "done" : "open");
        if (!result) throw new Error("Scratchpad item was not found for this Agent.");
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: {} };
    },
  });
}
