-- kb_entries — canonical schema snapshot.
--
-- Source of truth for the Supabase Postgres `kb_entries` table.
-- Captured 2026-04-25 via:
--   docker exec supabase-db pg_dump -U postgres -d postgres --schema-only -t kb_entries
--
-- ## Update protocol
--
-- This file MUST be updated whenever schema changes (CHECK constraints,
-- column additions, index changes). The flow is:
--   1. Write the migration as `scripts/migrate-kb-entries-*.sql` (additive
--      DO block — see existing migrations for the pattern).
--   2. Apply live: `docker exec -i supabase-db psql -U postgres -d postgres < scripts/migrate-...sql`.
--   3. Re-snapshot this file: `docker exec supabase-db pg_dump -U postgres -d postgres --schema-only -t kb_entries > schema/kb_entries.sql`
--      (then strip pg_dump preamble lines as below).
--   4. Commit migration + schema snapshot together.
--
-- Drift between this file and the live DB is detectable via:
--   diff <(docker exec supabase-db pg_dump -U postgres -d postgres --schema-only -t kb_entries | grep -vE '^(--|SET |SELECT pg_catalog|$)') schema/kb_entries.sql

-- Prerequisite extension. The `embedding` column uses pgvector's `vector`
-- type; a fresh-env replay of this snapshot will fail with `type
-- "public.vector" does not exist` unless the extension is installed first.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE public.kb_entries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    path text NOT NULL,
    title text NOT NULL,
    content text DEFAULT ''::text NOT NULL,
    content_hash text,
    embedding public.vector(1536),
    type text DEFAULT 'fact'::text,
    qualifier text DEFAULT 'reference'::text,
    condition text,
    tags jsonb DEFAULT '[]'::jsonb,
    priority integer DEFAULT 50,
    salience real DEFAULT 0.5,
    confidence real DEFAULT 1.0,
    reinforcement_count integer DEFAULT 0,
    access_count integer DEFAULT 0,
    last_accessed_at timestamp with time zone,
    last_reinforced_at timestamp with time zone,
    stale boolean DEFAULT false,
    source_task_id text,
    related_to jsonb DEFAULT '[]'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    fts tsvector GENERATED ALWAYS AS (to_tsvector('spanish'::regconfig, ((COALESCE(title, ''::text) || ' '::text) || COALESCE(content, ''::text)))) STORED,
    modality text DEFAULT 'text'::text,
    parent_doc_id uuid,
    section_path jsonb DEFAULT '[]'::jsonb,
    chunk_position integer,
    CONSTRAINT kb_entries_qualifier_check CHECK ((qualifier = ANY (ARRAY['always-read'::text, 'enforce'::text, 'conditional'::text, 'reference'::text, 'workspace'::text, 'pdf'::text]))),
    CONSTRAINT kb_entries_type_check CHECK ((type = ANY (ARRAY['pattern'::text, 'preference'::text, 'architecture'::text, 'bug'::text, 'workflow'::text, 'fact'::text, 'correction'::text, 'ingested'::text])))
);

ALTER TABLE public.kb_entries OWNER TO postgres;

ALTER TABLE ONLY public.kb_entries
    ADD CONSTRAINT kb_entries_path_key UNIQUE (path);
ALTER TABLE ONLY public.kb_entries
    ADD CONSTRAINT kb_entries_pkey PRIMARY KEY (id);

CREATE INDEX idx_kb_entries_confidence ON public.kb_entries USING btree (confidence);
CREATE INDEX idx_kb_entries_content_hash ON public.kb_entries USING btree (content_hash);
CREATE INDEX idx_kb_entries_embedding ON public.kb_entries USING hnsw (embedding public.vector_cosine_ops);
CREATE INDEX idx_kb_entries_fts ON public.kb_entries USING gin (fts);
CREATE INDEX idx_kb_entries_modality ON public.kb_entries USING btree (modality) WHERE (stale = false);
CREATE INDEX idx_kb_entries_parent_doc ON public.kb_entries USING btree (parent_doc_id) WHERE (parent_doc_id IS NOT NULL);
CREATE INDEX idx_kb_entries_qualifier ON public.kb_entries USING btree (qualifier);
CREATE INDEX idx_kb_entries_stale ON public.kb_entries USING btree (stale) WHERE (stale = true);
CREATE INDEX idx_kb_entries_type ON public.kb_entries USING btree (type);

GRANT ALL ON TABLE public.kb_entries TO service_role;
GRANT ALL ON TABLE public.kb_entries TO authenticated;
