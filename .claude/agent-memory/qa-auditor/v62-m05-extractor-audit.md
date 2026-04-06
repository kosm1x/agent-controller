---
name: v6.2 M0.5 Background Memory Extractor Audit
description: Audit of background-extractor.ts, enrichment pgvector integration, router integration — 3 critical (hash collision, no storeFacts tests, duplicate DB read), 5 warnings
type: project
---

v6.2 M0.5 background memory extractor audit (2026-04-06). Verdict: PASS WITH WARNINGS.

3 critical:

- C1: Duplicate DB read for toolCalls in router.ts (lines 1457 and 1492) — refactoring gap
- C2: storeFacts() and runBackgroundExtraction() have zero test coverage
- C3: 8-char SHA-256 hash prefix in path (`extracted/{date}-{hash8}.md`) — birthday collision at ~65K entries, silent data loss via pgUpsert merge-on-path

5 warnings:

- W1: Enrichment pgvector path adds unbounded latency (docstring claims 3s, actual up to 15s+)
- W2: Content-hash dedup is exact-match only, LLM non-determinism creates semantic dupes
- W3: User conversation content sent to cheapest/fallback provider (data exposure risk)
- W4: Concurrent storeFacts can race on pgFindByHash (mitigated by upsert idempotency)
- W5: Duplicated comment line in router.ts:1449-1450

**Why:** First pgvector-integrated extraction module. Fire-and-forget design is correct but storage layer has collision risk.
**How to apply:** Verify hash prefix length and test coverage before M1 builds on this foundation.
