-- 2026-04-25 — allow type='ingested' + qualifier='pdf' in kb_entries.
-- v7.13 structured PDF ingestion at src/kb/pdf-structured-ingest.ts:395-396
-- ships these values, but neither was in the original allow-list. Result:
-- every PDF chunk upsert returned HTTP 400 / SQLSTATE 23514. Live count of
-- entries with type='ingested' or qualifier='pdf' was 0 prior to this fix.
--
-- ## Idempotency + env divergence
--
-- Each DO block guards on whether the value is already present, so re-runs
-- are safe no-ops. If a sister environment has ADDITIONAL types or
-- qualifiers beyond what's in the canonical arrays below, the DROP + ADD
-- will silently revert those additions — append them to the ARRAY[...]
-- expressions before applying.
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
        'fact', 'correction', 'ingested'
      ]::text[]));
    RAISE NOTICE 'kb_entries_type_check did not exist — created with canonical set including ingested';
  ELSIF cdef LIKE '%''ingested''%' THEN
    RAISE NOTICE 'kb_entries_type_check already allows ingested — no-op';
  ELSE
    ALTER TABLE kb_entries DROP CONSTRAINT kb_entries_type_check;
    ALTER TABLE kb_entries ADD CONSTRAINT kb_entries_type_check
      CHECK (type = ANY (ARRAY[
        'pattern', 'preference', 'architecture', 'bug', 'workflow',
        'fact', 'correction', 'ingested'
      ]::text[]));
    RAISE NOTICE 'kb_entries_type_check rebuilt to add ingested';
  END IF;
END $$;

DO $$
DECLARE
  cdef TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO cdef
  FROM pg_constraint
  WHERE conname = 'kb_entries_qualifier_check';

  IF cdef IS NULL THEN
    ALTER TABLE kb_entries ADD CONSTRAINT kb_entries_qualifier_check
      CHECK (qualifier = ANY (ARRAY[
        'always-read', 'enforce', 'conditional', 'reference',
        'workspace', 'pdf'
      ]::text[]));
    RAISE NOTICE 'kb_entries_qualifier_check did not exist — created with canonical set including pdf';
  ELSIF cdef LIKE '%''pdf''%' THEN
    RAISE NOTICE 'kb_entries_qualifier_check already allows pdf — no-op';
  ELSE
    ALTER TABLE kb_entries DROP CONSTRAINT kb_entries_qualifier_check;
    ALTER TABLE kb_entries ADD CONSTRAINT kb_entries_qualifier_check
      CHECK (qualifier = ANY (ARRAY[
        'always-read', 'enforce', 'conditional', 'reference',
        'workspace', 'pdf'
      ]::text[]));
    RAISE NOTICE 'kb_entries_qualifier_check rebuilt to add pdf';
  END IF;
END $$;
