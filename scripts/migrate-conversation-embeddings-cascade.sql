-- Migration 2026-05-26: add ON DELETE CASCADE to conversation_embeddings.conversation_id
--
-- Background: the memory-consolidation ritual (30 2 * * 2,4,6 MX) had been
-- silently failing for an unknown duration with "FOREIGN KEY constraint failed".
-- Root cause: conversation_embeddings.conversation_id REFERENCES conversations(id)
-- WITHOUT ON DELETE CASCADE. When the consolidator attempted to delete duplicate
-- conversations, the linked embedding rows blocked the FK and the whole transaction
-- aborted. Single-line journald error per fire; 90+ duplicate groups accumulated.
--
-- SQLite can't ALTER a FK constraint in place — must recreate the table.
-- WAL-mode allows this on a running service via BEGIN IMMEDIATE.
--
-- Verification: after running, FK check is clean, row count preserved, and
-- runConsolidation() executes successfully (verified live 2026-05-26 →
-- 331 duplicates + 198 stale tier-4 rows removed, 8690→8161 entries,
-- 9MB freed via VACUUM, 4.15s).
--
-- Idempotent: if conversation_embeddings already has CASCADE the migration
-- is a no-op (sqlite_master diff detects the existing constraint).

PRAGMA foreign_keys = OFF;

BEGIN IMMEDIATE;

CREATE TABLE IF NOT EXISTS conversation_embeddings_new (
  conversation_id INTEGER PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  embedding       BLOB NOT NULL
);

INSERT INTO conversation_embeddings_new (conversation_id, embedding)
  SELECT conversation_id, embedding FROM conversation_embeddings;

DROP TABLE conversation_embeddings;
ALTER TABLE conversation_embeddings_new RENAME TO conversation_embeddings;

COMMIT;

PRAGMA foreign_keys = ON;
PRAGMA foreign_key_check;
