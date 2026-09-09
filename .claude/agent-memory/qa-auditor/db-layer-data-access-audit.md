---
name: db-layer-data-access-audit
description: mission-control DB layer (src/db/ + all query call-sites) cross-cutting data-access audit, 2026-07-05 — structure, N+1s, index gaps, schema debt
metadata:
  type: project
---

# DB Layer / Data-Access Audit (2026-07-05)

Scope: src/db/ (5817 LOC, index.ts 1229) + every query call-site across src/. better-sqlite3 SYNCHRONOUS (every query blocks event loop). mc.db = 451MB.

## Structural facts (durable)
- **NO query-layer abstraction.** getDatabase() singleton + index.ts (1229 lines, ~1000 = inline DDL) + ~40 domain modules each doing raw `getDatabase().prepare(sql)`. No DAO/repo/query-builder. Deliberate domain-colocated style, mostly coherent.
- **prepare-per-call is the convention** (474 getDatabase() sites, ZERO module-level statement caching) EXCEPT `src/reactions/manager.ts` which caches instance stmts in constructor (`this.stmtStuckTasks` etc.) — the MODEL pattern nobody else follows. better-sqlite3 recompiles SQL per .prepare(); cheap per-call, wasteful in loops.
- **Schema-source SPRAWL / no migration versioning.** ~130 tables split across: schema.sql (51 CREATE TABLE) + index.ts inline (33) + 8 ensure*Tables modules (tuning/schema.ts 6, v8-3/schema.ts 4, intel-schema.ts 4, social-schema.ts 2, dynamic.ts 2, + singles). 34 `ALTER TABLE ADD COLUMN` (many try/catch) + 7 PRAGMA table_info probes RE-RUN EVERY BOOT. No PRAGMA user_version. Idempotent (not a correctness bug) but accretes forever.
- **Concurrency story is well-built**: WAL + synchronous=NORMAL + busy_timeout=1000 + `writeWithRetry()` (jitter 20-150ms via Atomics.wait, breaks convoy) + PASSIVE checkpoint every 100 writes. Good.
- **Index coverage is STRONG** — nearly every hot WHERE/ORDER BY col indexed. Only real gap: `reactions.spawned_task_id` (unindexed; countReactionChainLength store.ts:156 walks ≤20 lookups/retry, table-scans; only source_task_id indexed).

## Confirmed findings
- **signal-store.ts:36-38** — dedup `SELECT 1 FROM signals WHERE content_hash=?` RE-PREPARED per signal inside batch tx (INSERT hoisted, SELECT not). signals=54,116 rows, ingest hot path. content_hash indexed (non-unique). Making idx UNIQUE → INSERT OR IGNORE kills the SELECT.
- **dispatcher.ts:939 listTasks `SELECT *`** — pulls output(avg1.6KB/max21KB)+metadata blobs for paginated LIST api (tasks table=140MB). Column-project list views.
- **memory/consolidation.ts:85-107** — prepare-in-loop + non-sargable `SUBSTR(content,1,100)=?` scan of conversations(7090) per dedup group.
- **baseline_history DEAD** — created+indexed every boot (index.ts:558), registry.ts:8 COMMENT claims "signal updates also write a baseline_history [row]" but `INSERT INTO baseline_history` appears NOWHERE. signal_baselines ALSO 0 rows → S3 baseline subsystem dormant/unwired. Doc-vs-code discrepancy.
- **tasks(140MB)+runs(138MB)=62% of 451MB DB, NO retention/pruning.** reconcileOrphanedTasks flips status, nothing archives old completed rows. Unbounded growth.
- prepare-in-loop cluster (18 sites): trajectory-miner, intel/baselines (WINDOWS), finance/budget (boot seed), video cleanup, hindsight-cost-pull, memory/recall-utility — all low-freq ritual/maintenance + small N; violate hoist+transaction pattern but low impact.
- embedding recall (sqlite-backend.ts:382) reads last-500 embedding BLOBs (~3MB) per recall; Float32Array parse cached via vectorCache (LRU max 1000) but the DB read of e.embedding is unconditional. Bounded + page-cached.

## Detector scripts (scratchpad, reusable)
prepare-in-loop / query-in-loop brace-depth python detector. NOTE: `.get(`/`.all(` regex catches JS Map.get/Set — false positives (projects.ts grouped facts, recurring-blockers cluster-map, classifier runnerHits all FINE batch-fetch+in-memory-group patterns, NOT N+1). Filter to stmt/prepared-statement receivers.
