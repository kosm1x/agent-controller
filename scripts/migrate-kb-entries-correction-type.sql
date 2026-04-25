-- 2026-04-25 — allow type='correction' in kb_entries.
-- Pre-fix: kb_entries_type_check rejected every correction-loop upsert
-- (HTTP 400 / SQLSTATE 23514). The v6.4 correction-loop feature ships
-- type='correction' (see src/intelligence/correction-loop.ts and the
-- type-aware min-length guard in src/db/pgvector.ts:136), but the CHECK
-- constraint on Supabase Postgres was never updated, so 0 corrections
-- ever persisted. This file records the schema change applied live
-- 2026-04-25 via `docker exec supabase-db psql`.
--
-- Idempotent: drops the constraint if it exists, recreates with the
-- expanded allow-list. Safe to re-run.

BEGIN;

ALTER TABLE kb_entries DROP CONSTRAINT IF EXISTS kb_entries_type_check;

ALTER TABLE kb_entries ADD CONSTRAINT kb_entries_type_check
  CHECK (type = ANY (ARRAY[
    'pattern',
    'preference',
    'architecture',
    'bug',
    'workflow',
    'fact',
    'correction'
  ]::text[]));

COMMIT;
