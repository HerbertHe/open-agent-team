# Three-tier Agent memory architecture

> Status: design proposal; it is not implemented yet. It replaces the idea that `CHANGELOG.md` is the only collaboration memory without removing that human-readable record.

## Goal

Memory should restore goals and tests after a restart, detect conflicts before task creation, link decisions to evidence, and keep context injection bounded. Every item has a scope, source, version, and review status.

## Tiers

| Tier | Role | Storage and lifetime |
| --- | --- | --- |
| L1 | Hot session and task context: goal, tests, blockers, and next step | In-memory `Map`, short TTL, 1,000–2,000-token budget |
| L2 | Structured collaboration facts: tasks, resource claims, decisions, and reviews | SQLite WAL + FTS5 at `<state_dir>/memory.sqlite` |
| L3 | Archives and semantic retrieval: CHANGELOG, events, commits, diffs, and approved versions | Local files/index first; replaceable vector store when needed |

L1 belongs to `agentId + taskId + sessionId`. L2 shares only reviewable information across `task → agent → team → project → global` scopes. L3 is queried on demand so that it does not overload the active context.

## Control, evidence, and conflicts

A Worker may write L1 and propose an L2 promotion. A Leader reviews and promotes team facts; only the Admin publishes a project fact or decision. Every promotion must cite at least one piece of evidence: a task, commit, test, event, file, or review. Corrections create a new version and mark the old one `superseded`.

Before `create task`, an L2 gate checks `resource_claims`, active context, and `conflictKey`. On conflict, it rejects the task, serializes it, or asks for a genuinely independent split.

## Proposed interface

The proposed tools are `memory-context-get`, `memory-search`, `memory-propose`, `memory-promote`, `memory-supersede`, `memory-claim-resources`, `memory-check-conflicts`, and `memory-forget`, with equivalent REST APIs. Desktop would expose L1 active summaries, L2 items awaiting review and resource occupancy, and L3 archives with sources, dates, confidence, and version history.

## Phased delivery

1. Define `MemoryProvider` contracts, auditing, and migrations.
2. Deliver L1 and L2 with SQLite/FTS5 and queue conflict control.
3. Index L3 archives and add hybrid keyword/vector search.
4. Evaluate a temporal graph such as Graphiti only if multi-hop queries become a demonstrated need.

## Design references

- [Letta](https://github.com/letta-ai/letta)
- [Mem0](https://github.com/mem0ai/mem0)
- [LangGraph Persistence](https://github.com/langchain-ai/docs/blob/main/src/oss/langgraph/persistence.mdx)
- [Graphiti](https://github.com/getzep/graphiti)
- [OpenMemory](https://github.com/CaviraOSS/OpenMemory)
