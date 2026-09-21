import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { MemoryRepository } from "./memory-repository";
import type { MemoryMarkdownFile, MemoryMarkdownView, MemoryRecord, ScratchpadItem } from "./types";

function redact(value: string, max = 2_000): string {
  const clean = value
    .replace(/(?:sk|api[_-]?key|token|secret)\s*[:=]\s*[^\s,;]+/gi, "[REDACTED]")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function safeAgentDirectory(agentId: string): string {
  const label = agentId.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "agent";
  const digest = createHash("sha256").update(agentId).digest("hex").slice(0, 8);
  return `${label}-${digest}`;
}

function memoryLines(items: MemoryRecord[]): string[] {
  if (!items.length) return ["_No entries._"];
  return items.map((item) => [
    `<!-- memory-id: ${item.id} -->`,
    `- **${item.kind}**: ${redact(item.summary || item.content)}`,
  ].join("\n"));
}

function scratchpadLines(items: ScratchpadItem[]): string[] {
  if (!items.length) return ["_No scratchpad items._"];
  return items.map((item) => [
    `<!-- scratchpad-id: ${item.id} -->`,
    `- [${item.status === "done" ? "x" : " "}] ${redact(item.text, 1_000)}`,
  ].join("\n"));
}

async function writeAtomic(file: string, content: string): Promise<void> {
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700).catch(() => undefined);
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await fs.writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, file);
    await fs.chmod(file, 0o600).catch(() => undefined);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export class MemoryMarkdownProjection {
  private readonly root: string;

  constructor(
    private readonly projectId: string,
    stateDir: string,
    private readonly repository: MemoryRepository,
  ) {
    this.root = path.join(stateDir, "memory", "views");
  }

  async refresh(agentId: string): Promise<MemoryMarkdownView> {
    const generatedAt = new Date().toISOString();
    const recentSince = new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString();
    const recent = this.repository.listRecentDailyEvents(agentId, recentSince, 50);
    const activeL3 = this.repository.list({ agentId, level: "L3", status: "active", limit: 500 });
    const activeL2 = this.repository.list({ agentId, level: "L2", status: "active", limit: 500 });
    const candidates = [
      ...this.repository.list({ agentId, status: "candidate", limit: 500 }),
      ...this.repository.list({ agentId, status: "disputed", limit: 500 }),
    ];
    const scratchpad = this.repository.listScratchpad(agentId, true, 500);
    const notes = new Map<string, MemoryRecord[]>([
      ["decisions", activeL2.filter(({ kind }) => kind === "decision")],
      ["procedures", activeL2.filter(({ kind }) => kind === "procedure" || kind === "failure-pattern")],
      ["preferences", activeL2.filter(({ kind }) => kind === "preference")],
      ["other", activeL2.filter(({ kind }) => !["decision", "procedure", "failure-pattern", "preference"].includes(kind))],
    ]);
    const files: MemoryMarkdownFile[] = [
      {
        path: "README.md",
        content: [
          "# Agent memory view",
          "",
          `Project: ${this.projectId}`,
          `Agent: ${agentId}`,
          "",
          "> Generated from OAT's canonical SQLite memory. These files are read-only projections; editing them does not change Agent memory.",
          "",
        ].join("\n"),
      },
      {
        path: "MEMORY.md",
        content: ["# Stable long-term memory", "", ...memoryLines(activeL3), ""].join("\n"),
      },
      {
        path: "SCRATCHPAD.md",
        content: ["# Scratchpad", "", ...scratchpadLines(scratchpad), ""].join("\n"),
      },
      {
        path: "RECENT.md",
        content: [
          "# Last 24 hours",
          "",
          `- Completed tasks: ${recent.filter(({ eventType }) => eventType === "task.completed").length}`,
          `- Failed tasks: ${recent.filter(({ eventType }) => eventType === "task.failed").length}`,
          `- Daily notes: ${recent.filter(({ eventType }) => eventType === "agent.daily_note").length}`,
          "",
          ...(recent.length ? recent.map((event) => `- **${event.eventType}**: ${redact(event.content)}`) : ["_No recent activity._"]),
          "",
        ].join("\n"),
      },
      ...[...notes].map(([name, items]) => ({
        path: `notes/${name}.md`,
        content: [`# ${name[0]!.toUpperCase()}${name.slice(1)}`, "", ...memoryLines(items), ""].join("\n"),
      })),
      {
        path: "notes/conflicts.md",
        content: ["# Candidates and conflicts", "", ...memoryLines(candidates), ""].join("\n"),
      },
    ];

    for (const date of this.repository.listDailyEventDates(agentId)) {
      const events = this.repository.listDailyEvents(agentId, date);
      const deduplicated = new Map<string, typeof events[number]>();
      for (const event of events) deduplicated.set(event.eventType === "agent.daily_note" ? event.id : event.taskId ?? event.id, event);
      files.push({
        path: `daily/${date}.md`,
        content: [
          `# ${date}`,
          "",
          ...[...deduplicated.values()].map((event) => [
            `<!-- event-id: ${event.id}${event.taskId ? ` task-id: ${event.taskId}` : ""} -->`,
            `- **${event.eventType}**: ${redact(event.content)}`,
          ].join("\n")),
          "",
        ].join("\n"),
      });
    }

    const directory = path.join(this.root, safeAgentDirectory(agentId));
    await Promise.all(files.map((file) => writeAtomic(path.join(directory, ...file.path.split("/")), file.content)));
    const expectedDailyFiles = new Set(files.filter(({ path: file }) => file.startsWith("daily/")).map(({ path: file }) => path.basename(file)));
    const dailyDirectory = path.join(directory, "daily");
    const existingDailyFiles = await fs.readdir(dailyDirectory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    await Promise.all(existingDailyFiles
      .filter((file) => file.endsWith(".md") && !expectedDailyFiles.has(file))
      .map((file) => fs.rm(path.join(dailyDirectory, file), { force: true })));
    return { projectId: this.projectId, agentId, generatedAt, files };
  }
}
