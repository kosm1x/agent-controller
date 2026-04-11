/**
 * Learning consolidation — semantic deduplication of accumulated learnings.
 *
 * Uses existing embedding infrastructure (Gemini gemini-embedding-001, 1536-dim)
 * to find and merge near-duplicate entries in the conversations table.
 * Designed to be called from the evolution ritual, not auto-scheduled.
 */

import { getDatabase } from "../db/index.js";
import { cosineSimilarity, deserializeEmbedding } from "./embeddings.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConsolidationOptions {
  /** Memory bank to consolidate (default: "mc-operational"). */
  bank?: string;
  /** Cosine similarity threshold for merging (default: 0.85). */
  similarityThreshold?: number;
  /** Max merges per run — safety cap (default: 50). */
  maxMerges?: number;
  /** Preview only, don't delete (default: false). */
  dryRun?: boolean;
  /** Max entries to load (default: 200). */
  maxEntries?: number;
}

export interface ConsolidationResult {
  /** Number of entries loaded for comparison. */
  entriesScanned: number;
  /** Number of duplicate groups found. */
  groupCount: number;
  /** Total entries merged (deleted). */
  mergedCount: number;
  /** IDs of deleted entries (empty in dry-run). */
  deletedIds: number[];
}

interface LearningRow {
  id: number;
  content: string;
  trust_tier: number;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Core consolidation function
// ---------------------------------------------------------------------------

/**
 * Find and merge semantically similar learnings in the conversations table.
 *
 * Algorithm:
 * 1. Load recent entries + their embeddings
 * 2. Compute pairwise cosine similarity
 * 3. Group entries above threshold
 * 4. Keep highest trust_tier (or most recent) from each group, delete rest
 */
export function consolidateLearnings(
  options: ConsolidationOptions = {},
): ConsolidationResult {
  const {
    bank = "mc-operational",
    similarityThreshold = 0.85,
    maxMerges = 50,
    dryRun = false,
    maxEntries = 200,
  } = options;

  const db = getDatabase();

  // Step 1: Load recent entries with embeddings
  const rows = db
    .prepare(
      `SELECT c.id, c.content, c.trust_tier, c.created_at, ce.embedding
       FROM conversations c
       JOIN conversation_embeddings ce ON ce.conversation_id = c.id
       WHERE c.bank = ?
         AND c.created_at >= datetime('now', '-30 days')
       ORDER BY c.created_at DESC
       LIMIT ?`,
    )
    .all(bank, maxEntries) as (LearningRow & { embedding: Buffer })[];

  if (rows.length < 2) {
    return {
      entriesScanned: rows.length,
      groupCount: 0,
      mergedCount: 0,
      deletedIds: [],
    };
  }

  // Step 2: Deserialize embeddings
  const entries = rows.map((r) => ({
    id: r.id,
    content: r.content,
    trustTier: r.trust_tier,
    createdAt: r.created_at,
    embedding: deserializeEmbedding(r.embedding),
  }));

  // Step 3: Find similar pairs above threshold
  const visited = new Set<number>();
  const groups: number[][] = [];

  for (let i = 0; i < entries.length; i++) {
    if (visited.has(i)) continue;

    const group = [i];
    for (let j = i + 1; j < entries.length; j++) {
      if (visited.has(j)) continue;
      const sim = cosineSimilarity(entries[i].embedding, entries[j].embedding);
      if (sim >= similarityThreshold) {
        group.push(j);
      }
    }

    if (group.length > 1) {
      groups.push(group);
      for (const idx of group) visited.add(idx);
    }
  }

  if (groups.length === 0) {
    return {
      entriesScanned: entries.length,
      groupCount: 0,
      mergedCount: 0,
      deletedIds: [],
    };
  }

  // Step 4: For each group, keep the best entry, delete the rest
  const deletedIds: number[] = [];
  let mergeCount = 0;

  for (const group of groups) {
    if (mergeCount >= maxMerges) break;

    // Sort: lowest trust_tier first (1=best), then most recent
    const sorted = group
      .map((idx) => entries[idx])
      .sort((a, b) => {
        if (a.trustTier !== b.trustTier) return a.trustTier - b.trustTier;
        return b.createdAt.localeCompare(a.createdAt); // newer first
      });

    // Keep first (best), delete rest
    const toDelete = sorted.slice(1);

    for (const entry of toDelete) {
      if (mergeCount >= maxMerges) break;
      deletedIds.push(entry.id);
      mergeCount++;
    }
  }

  // Step 5: Execute deletions (unless dry-run)
  if (!dryRun && deletedIds.length > 0) {
    const deleteConversations = db.prepare(
      `DELETE FROM conversations WHERE id = ?`,
    );
    const deleteEmbeddings = db.prepare(
      `DELETE FROM conversation_embeddings WHERE conversation_id = ?`,
    );

    const deleteAll = db.transaction((ids: number[]) => {
      for (const id of ids) {
        deleteEmbeddings.run(id);
        deleteConversations.run(id);
      }
    });

    deleteAll(deletedIds);

    console.log(
      `[consolidate] Merged ${deletedIds.length} duplicate learnings from ${groups.length} groups (bank=${bank})`,
    );
  } else if (dryRun && deletedIds.length > 0) {
    console.log(
      `[consolidate] DRY RUN: would merge ${deletedIds.length} duplicate learnings from ${groups.length} groups`,
    );
  }

  return {
    entriesScanned: entries.length,
    groupCount: groups.length,
    mergedCount: dryRun ? 0 : deletedIds.length,
    deletedIds: dryRun ? [] : deletedIds,
  };
}
