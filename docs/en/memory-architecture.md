# Three-tier memory for Admin and Leader agents

> Status: implemented on 2026-08-26. This document describes current behavior.

Memory is enabled for Admin and Leader agents. Useful Worker events belong to the matching Leader; Workers do not own an independent long-term memory. Retrieved memories are explicitly marked as fallible historical context, never as new operator instructions.

## Storage and tiers

The implementation uses local `better-sqlite3` with WAL, foreign keys, and a busy timeout. The default database is `<state_dir>/memory/memory.db`.

| Tier | Purpose | Lifecycle |
| --- | --- | --- |
| L1 | Recent tasks, progress, replies, and failures | Captured from observability events, capped per agent, deleted after its configured TTL during a dream run |
| L2 | Consolidated decisions, episodes, and failure patterns | Created during idle consolidation; repeated content increases evidence, confidence, and salience; expired items become `superseded` |
| L3 | Stable deep memories and procedures | Promoted when L2 evidence reaches the threshold, or manually promoted in Desktop |

The current summarizer and ranker are deterministic. Retrieval combines lexical overlap, salience, confidence, and age; embeddings and a temporal graph are not current runtime dependencies. Admin can retrieve project-wide L2/L3 records. A Leader can only retrieve its own L2/L3 records. L1 is always agent-local.

## Dream mode and safety

Dream mode runs only after the idle delay and only when no prompt is active and no task is `queued`, `running`, `waiting`, or `review_pending`. One bounded transaction consolidates pending events, updates evidence, promotes eligible L2 records to L3, expires old L2 records, prunes old L1 records, and records an auditable result. A new task requests cancellation. Interrupted `running` records are marked `failed` at the next startup.

Only useful extracted text is stored, not the complete raw event payload. Common token, API-key, and secret forms are redacted, content is capped at 4,000 characters, and `memory.*` events are excluded to prevent recursion. Streaming `pi.message_update` snapshots are ignored; only a completed `pi.message_end` Assistant message is retained, and unsupported pending snapshots from an older build are cleaned up at startup. Forgetting marks a record `forgotten`; it disappears from normal retrieval and prompt injection.

## Configuration

```json
{
  "memory": {
    "enabled": true,
    "roles": ["admin", "leader"],
    "database": "memory/memory.db",
    "l1": { "maxItems": 24, "completedTaskTtlHours": 48 },
    "l2": { "maxResults": 5, "retentionDays": 180 },
    "l3": { "maxPromptItems": 5, "minEvidence": 2 },
    "dream": {
      "enabled": true,
      "idleAfterSeconds": 300,
      "pollSeconds": 30,
      "maxEventsPerRun": 250,
      "cancelOnNewTask": true
    }
  }
}
```

A relative database path is resolved from `state_dir`. Defaults are defined in the TypeScript types, Zod loader, and `schema/v1.json`.

## API and Desktop

- `GET /memory/overview`
- `GET /memory?agentId=&level=&status=&limit=`
- `POST /memory/dream`
- `POST /memory/:id/promote`
- `POST /memory/:id/forget`

When an Admin or Leader is selected, Desktop exposes a brain icon. Its dialog displays tier counts, pending events, dream status, evidence, source Agent and event type, confidence, and salience. It refreshes every five seconds to tolerate a project-port transition, can run an idle consolidation, promote L2 to L3, and forget a record. Workers do not see the entry.

Tables are `memory_events`, `memory_items`, `dream_runs`, and `memory_injections`. Prompt injections record the query and selected memory IDs for auditability.

## Validation and limitations

Run `pnpm test:memory`, `pnpm exec tsc --noEmit`, `pnpm run build`, and `pnpm --filter desktop run build`.

The current system has no embedding index, autonomous LLM reflector, cross-project global memory, or resource-conflict knowledge graph. These can later be implemented behind the existing service/API contract. Letta, Mem0, LangGraph persistence, Graphiti, OpenMemory, and Qdrant are relevant references, but none is currently required at runtime.
