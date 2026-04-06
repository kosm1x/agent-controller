---
name: M0 pgvector KB migration audit
description: Audit findings for pgvector dual-write migration (5 new files + 1 modified). 3 critical bugs, sync gaps, no tests for 3/5 files
type: project
---

Audited 2026-04-06. Files: pgvector.ts, pgvector-sync.ts, pgvector-backfill.ts, embeddings.ts, pgvector.test.ts, jarvis-fs.ts

## Critical bugs found

- pgRecordAccess sends `"access_count + 1"` as string literal to PostgREST PATCH -- does not execute SQL. Needs RPC function
- pgReinforce has read-modify-write race (GET then PATCH). Needs RPC function for atomic update
- pgFindByHash does not URL-encode hash param (all other path queries do)

## Sync gaps in jarvis-fs.ts

- appendToFile, moveFile, updateMetadata do NOT sync to pgvector. Only upsertFile + deleteFile wired

## Code duplication

- qualifierToSalience duplicated in pgvector-sync.ts and pgvector-backfill.ts (identical)

## Test gaps

- Zero tests for pgvector-sync.ts, pgvector-backfill.ts, embeddings.ts
- No test for pgRecordAccess
- Tests use clearAllMocks in beforeEach (convention says restoreAllMocks in afterEach)

**Why:** Phase 1 is safe (SQLite primary, pgvector failures non-fatal). Phase 2 read-path migration MUST fix C1-C3 and W1 first.

**How to apply:** Block Phase 2 on these fixes. Track as pre-Phase-2 checklist.
