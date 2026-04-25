-- 2026-04-25 — allow type='correction' in kb_entries.
-- v6.4 correction-loop ships type='correction' (see
-- src/intelligence/correction-loop.ts and the type-aware min-length
-- guard in src/db/pgvector.ts:136), but the CHECK constraint on
-- Supabase Postgres was never updated, so 0 corrections ever
-- persisted. This script applied live 2026-04-25.
--
-- ## Idempotency + env divergence
--
-- The DO block guards on whether 'correction' is already present, so
-- re-running this script is a safe no-op. If a sister environment has
-- ADDITIONAL types beyond what's in the canonical array below, the
-- DROP + ADD will silently revert those additions. To preserve them,
-- append them to the ARRAY[...] expression before applying.
--
-- The canonical allow-list snapshot lives at `schema/kb_entries.sql`.

DO $$
DECLARE
  cdef TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO cdef
  FROM pg_constraint
  WHERE conname = 'kb_entries_type_check';

  IF cdef IS NULL THEN
    ALTER TABLE kb_entries ADD CONSTRAINT kb_entries_type_check
      CHECK (type = ANY (ARRAY[
        'pattern', 'preference', 'architecture', 'bug', 'workflow',
        'fact', 'correction'
      ]::text[]));
    RAISE NOTICE 'kb_entries_type_check did not exist — created with canonical set including correction';
  ELSIF cdef LIKE '%''correction''%' THEN
    RAISE NOTICE 'kb_entries_type_check already allows correction — no-op';
  ELSE
    ALTER TABLE kb_entries DROP CONSTRAINT kb_entries_type_check;
    ALTER TABLE kb_entries ADD CONSTRAINT kb_entries_type_check
      CHECK (type = ANY (ARRAY[
        'pattern', 'preference', 'architecture', 'bug', 'workflow',
        'fact', 'correction'
      ]::text[]));
    RAISE NOTICE 'kb_entries_type_check rebuilt to add correction';
  END IF;
END $$;
