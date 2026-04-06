---
name: v6.2 M1 lesson fingerprinting + dedup audit
description: M1 decay sweep + content dedup audit. PASS WITH WARNINGS. C1 enforce sweep risk, C2 metadata loss on dedup, no stop cron, no dedup tests
type: project
---

Audited 2026-04-06. Files: lesson-decay.ts (new), pgvector-sync.ts (modified), health.ts (modified), index.ts (modified), lesson-decay.test.ts (new)

## Critical

- C1: kb_decay_sweep RPC has no salience/qualifier guard. enforce/always-read files can be swept stale if confidence drops below 0.1
- C2: Dedup reinforce skips creating pgvector entry for new path — metadata (qualifier, title, tags) silently lost. SQLite/pgvector diverge

## Warnings

- W1: No stopDecayCron() — cron leaks on shutdown, violates pattern (proactive, ritual, dynamic all have stop functions)
- W2: index.ts catches lesson-decay import errors silently (empty catch), unlike code-index which logs
- W3: cron.default.schedule() — fragile ESM interop vs static import used by other cron users
- W4: Tests re-import module but Vitest caches — fragile, cron registration would leak
- W5: SUPABASE_RPC_URL hardcoded (same as pgvector.ts, known from M0)

## Standards violations

- SV1: Zero tests for registerDecayCron (other cron schedulers all tested)
- SV2: Zero tests for dedup path in pgvector-sync.ts (no pgvector-sync.test.ts at all, M0 gap persists)
- SV3: getApiKey() + headers() duplicated from pgvector.ts

**Why:** Phase 1 dual-write means pgvector failures are non-fatal. But C1 could cause enforce files to vanish from hybrid search once decay runs live.

**How to apply:** Fix C1 (salience guard in RPC) before first Sunday sweep. Track C2 as accepted risk or fix before Phase 2.
