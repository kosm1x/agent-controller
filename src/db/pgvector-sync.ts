/**
 * pgvector dual-write adapter — syncs jarvis_files writes to pgvector.
 *
 * Wraps upsertFile/deleteFile with async pgvector sync + embedding generation.
 * pgvector writes are fire-and-forget: failures never block the SQLite path.
 *
 * Transition plan:
 *   Phase 1 (current): dual-write — SQLite is primary, pgvector is secondary
 *   Phase 2: switch reads to pgvector for enrichment (hybrid search)
 *   Phase 3: deprecate SQLite KB tables
 */

import { generateEmbedding } from "../inference/embeddings.js";
import {
  pgUpsert,
  pgDelete,
  pgFindByHash,
  pgReinforce,
  isPgvectorEnabled,
  contentHash,
} from "./pgvector.js";

/**
 * Sync a jarvis_files upsert to pgvector (fire-and-forget).
 * Generates embedding from title + content, then upserts to kb_entries.
 * Call this after the SQLite upsertFile() succeeds.
 */
export function syncToPgvector(
  path: string,
  title: string,
  content: string,
  tags: string[] = [],
  qualifier = "reference",
  priority = 50,
  condition: string | null = null,
): void {
  if (!isPgvectorEnabled()) return;

  // Async, non-blocking — embedding + upsert happens in background
  (async () => {
    try {
      const hash = contentHash(content);

      // M1 dedup: if content hash exists at a DIFFERENT path, reinforce
      // instead of creating a duplicate. Saves embedding API calls.
      // Same-path updates (edits to existing file) still go through full upsert.
      const existing = await pgFindByHash(hash);
      if (existing && existing.path !== path) {
        await pgReinforce(existing.path);
        console.log(
          `[pgvector-sync] Dedup: ${path} matches ${existing.path}, reinforced`,
        );
        return;
      }

      // Generate embedding from title + first 8K of content
      const embeddingText = `${title}\n\n${content.slice(0, 8000)}`;
      const embedding = await generateEmbedding(embeddingText);

      await pgUpsert({
        path,
        title,
        content,
        content_hash: hash,
        embedding: embedding ?? undefined,
        qualifier,
        condition: condition ?? undefined,
        tags,
        priority,
        salience: qualifierToSalience(qualifier),
      });
    } catch (err) {
      console.warn(
        `[pgvector-sync] Failed for ${path}:`,
        err instanceof Error ? err.message : err,
      );
    }
  })();
}

/**
 * Sync a jarvis_files delete to pgvector (fire-and-forget).
 * Call this after the SQLite deleteFile() succeeds.
 */
export function syncDeleteToPgvector(path: string): void {
  if (!isPgvectorEnabled()) return;
  pgDelete(path).catch(() => {});
}

/**
 * Map qualifier to salience weight for retention scoring.
 * Higher salience = decays slower.
 */
export function qualifierToSalience(qualifier: string): number {
  switch (qualifier) {
    case "enforce":
      return 0.95;
    case "always-read":
      return 0.9;
    case "conditional":
      return 0.7;
    case "workspace":
      return 0.3;
    case "reference":
    default:
      return 0.5;
  }
}
