---
name: v6.4 Sprint Audit
description: v6.4 sprint (OH2→G1.5, 10 commits, 9 sessions) — PASS WITH WARNINGS, latency denominator bug, pgCascadeStale unconditional fire, expandQuery timeout mismatch, overfitting regex misses real case IDs, 3 untested modules
type: project
---

## v6.4 Sprint Audit (2026-04-07)

**Verdict**: PASS WITH WARNINGS

### Critical (1)

- `isDegraded()` avgLatencyMs uses `recent.length` as denominator but should use `totalCapped` — excess capped failures contribute latency but not to the count, creating inconsistent metrics

### Warnings (4)

- pgCascadeStale fires on every pgUpsert even when content unchanged (no hash comparison)
- expandQuery 5s timeout inside 2s outer pgvector timeout — expansion effectively never completes
- Overfitting regex catches "case42" but real seed case IDs use "ts-web-search-01" format — regex misses actual overfitting
- batch_decompose: no upper bound on items.length, could submit thousands of subtasks

### Test gaps (3)

- No tests: batch_decompose, dynamic.ts (executeScheduleNow + retryScheduledTask), expandQuery/session-diversity

### Design notes

- SearchResult type doesn't include source_task_id, enrichment uses unsafe cast
- Kimi containment (tool strip) correct but logs no warning when tools stripped
