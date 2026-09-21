# Owner-private Agent memory and shared file knowledge

> Status: implemented through SQLite schema v10, including owner-private Scratchpads, governed Agent read/search/write tools, bounded recent activity, and read-only Markdown projections, on 2026-09-21.

Admin, Leader, and Worker each own an isolated three-tier memory. Worker events remain owned by the Worker; they are not assigned to the Leader. Runtime Agents can retrieve only their own memory. The trusted local user can inspect and govern records by owner.

Shared information is a separate file-backed knowledge domain. Project knowledge lives under `knowledge/project`, team knowledge under `knowledge/teams/<teamId>`, and Desktop uploads under `knowledge/uploads`. Private memory is never automatically promoted into shared knowledge.

## Storage and maintenance

The canonical store is `<state_dir>/memory/memory.db`, using `better-sqlite3` with WAL, foreign keys, and a busy timeout.

| Tier | Purpose | Lifecycle |
| --- | --- | --- |
| L1 | Recent work, progress, replies, and failures | Captured per owner, bounded and TTL-pruned |
| L2 | Governed decisions, episodes, procedures, and failure patterns | Produced only from that owner's events; candidates and disputes are not injected |
| L3 | Stable deep memory | Promoted after evidence/governance checks or explicit user action |

There is no central Dream Agent. Task completion and idle scheduling start an owner-scoped maintenance run for each Agent independently. Runs are recorded in `maintenance_runs` and streamed as `agent.memory_maintenance.*`. The legacy `dream_runs` path remains only for migration history and internal compatibility tests; runtime timers, HTTP, and Desktop no longer invoke project-wide consolidation.

## Retrieval and vector indexing

Before a managed prompt, memory and shared knowledge are retrieved in parallel. Both are marked as fallible reference data, never as operator instructions.

Each internal Agent also has an owner-private persistent Scratchpad managed through the `oat-scratchpad` tool. Up to 12 open reminders are injected before historical memory as fallible working notes. Scratchpad entries do not participate in L2/L3 governance or shared knowledge.

The second batch adds `oat-memory-read`, `oat-memory-search`, and `oat-memory-write`. Reads and searches are fixed to the calling Agent's private scope. Daily writes are append-only working history; long-term writes create candidates and cannot bypass confirmation, conflict checks, or promotion. At most eight task outcomes or daily notes from the last 48 hours are injected in a clearly delimited, non-instructional recent-activity block.

The third batch applies one `memory.retrieval.maxPromptTokens` budget across Scratchpad, recent activity, and L1/L2/L3; lower-priority items are removed before unresolved reminders, failures, and stable L3. Lifecycle cleanup runs at startup and after owner maintenance, removes only unreferenced expired/over-capacity daily events, prunes old completed Scratchpad items, and expires stale candidates. Desktop exposes provenance, conflicts, rejection, and edit-before-confirm review.

OAT deterministically projects canonical SQLite state into per-Agent `MEMORY.md`, `SCRATCHPAD.md`, `RECENT.md`, `daily/YYYY-MM-DD.md`, and `notes/*.md` files under `<state_dir>/memory/views/`. These are read-only views rather than sources of truth. Desktop can inspect and explicitly export them; edits never write back to canonical memory.

SQLite remains authoritative. Memory and knowledge share the Embedding Profile, collection revision, Semantic Outbox, retry/dead-letter behavior, rebuild/activation/rollback lifecycle, and Zvec batch optimization. Zvec candidate filters are followed by canonical SQLite authorization hydration. Lexical retrieval remains available when no active collection exists.

Knowledge retrieval combines lexical, Dense, and FTS routes with reciprocal-rank fusion. Structured knowledge references are persisted with the task and rendered separately in Desktop.

## API and Desktop

Memory:

- `GET /memory/overview?agentId=...`
- `GET /memory?agentId=&level=&status=&limit=`
- `POST /memory/maintenance` with `{ "agentId": "..." }`
- `POST /memory/:id/confirm`, `/promote`, or `/forget`
- `GET /memory/views?agentId=...` and `GET /memory/scratchpad?agentId=...`
- `GET /memory/recent?agentId=...&hours=24`
- `POST /memory/lifecycle/cleanup`
- `POST /memory/:id/edit-confirm`
- the index lifecycle endpoints under `/memory/index/*`

Knowledge:

- `GET /knowledge/operations`
- `POST /knowledge/uploads`, `/knowledge/scan`, and `/knowledge/sources/:id/retry`
- `DELETE /knowledge/sources/:id` for canonical user uploads only

Desktop exposes Agent memory for Admin, Leader, and Worker. “Settings → Shared knowledge” provides project/team upload, source and chunk status, index status, rescan, retry, and safe deletion. Workspace/Agent-produced files are read-only from this page.

## Validation

Run:

```bash
pnpm run test:memory
pnpm exec tsc --noEmit
pnpm --filter ./desktop run lint
pnpm run build
pnpm run build:desktop
```

The Chinese documentation contains the full operational detail: [memory architecture](../zh-CN/memory-architecture.md), [shared knowledge](../zh-CN/knowledge-architecture.md), and [ADR 0002](../zh-CN/adr/0002-agent-memory-file-knowledge.md).
