---
name: perf-audit-20260409
description: Performance audit of mission-control on 8GB VPS — spin-wait, prepared statement reuse, day log over-pipeline, 3 LLM calls per message, 118MB DB
type: project
---

Performance audit 2026-04-09. 3 critical, 8 warnings.

**Critical findings:**

1. `writeWithRetry()` in db/index.ts:291 uses spin-wait busy loop (blocks event loop 20-150ms per retry)
2. No prepared statement caching — ~15-20 `db.prepare()` calls per message hot path (only bus.ts caches correctly)
3. `appendDayLog()` calls full `upsertFile()` pipeline (pgvector embed + Drive sync + index regen) on every message x2

**Key warnings:**

- 3 LLM calls per message (scope classifier 3s + expandQuery 5s + main task)
- 118MB DB, events table 19MB, no retention on scope_telemetry/tasks
- searchFiles() does triple LIKE full table scan
- previousScopeGroups/previousMessages Maps have no TTL eviction
- findRelevantPatterns() has N+1 query pattern (1 + 3 reads)
- ProviderMetrics.entries splice(0, n) is O(n)

**Why:** Production VPS (8GB RAM, single process, 170 tools). Current workload (~1900 tasks) is manageable but patterns don't scale.

**How to apply:** Prioritize C1 (spin-wait) and C3 (day log) — these fire on every message. C2 (prepared statements) is a larger refactor but saves 15+ SQL compiles per message.
