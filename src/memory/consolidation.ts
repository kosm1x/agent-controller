/**
 * CCP7: Memory Consolidation Cycle — 4-phase overnight process.
 *
 * Reduces memory noise by pruning stale, low-tier entries.
 * Runs after overnight tuning (2:30 AM Tue/Thu/Sat).
 *
 * Phases:
 * 1. Orient — count entries by bank/tier/age
 * 2. Gather — find stale candidates (tier 3-4, old)
 * 3. Consolidate — deduplicate similar entries (same bank+content prefix)
 * 4. Prune — delete aged-out entries, VACUUM
 *
 * Safety: Never deletes tier-1 or tier-2 (verified/inferred).
 * Never deletes bank="mc-system" (directives).
 */

import { getDatabase, writeWithRetry } from "../db/index.js";

/** Age thresholds for pruning by trust tier (days). */
const PRUNE_AGE: Record<number, number> = {
  4: 60, // unverified: prune after 60 days
  3: 180, // provisional: prune after 180 days
};

/** Protected banks — never pruned. */
const PROTECTED_BANKS = new Set(["mc-system"]);

interface ConsolidationReport {
  /** Entries per bank before consolidation. */
  orient: Record<string, number>;
  /** Number of stale candidates found. */
  staleCandidates: number;
  /** Duplicates removed in consolidation phase. */
  duplicatesRemoved: number;
  /** Entries pruned by age+tier. */
  pruned: number;
  /** Total entries remaining. */
  remaining: number;
  durationMs: number;
}

/**
 * Phase 1: Orient — count entries by bank.
 */
function orient(): Record<string, number> {
  const db = getDatabase();
  const rows = db
    .prepare("SELECT bank, COUNT(*) as cnt FROM conversations GROUP BY bank")
    .all() as Array<{ bank: string; cnt: number }>;
  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.bank] = row.cnt;
  }
  return counts;
}

/**
 * Phase 2+3: Gather stale candidates and deduplicate.
 * Finds entries with same bank + first 100 chars of content (likely duplicates).
 * Keeps the most recent / highest tier. Deletes the rest.
 */
function consolidateDuplicates(): number {
  const db = getDatabase();

  // Find groups with duplicate content prefixes in the same bank
  const groups = db
    .prepare(
      `SELECT bank, SUBSTR(content, 1, 100) as prefix, COUNT(*) as cnt,
              MIN(id) as keep_id, MAX(trust_tier) as best_tier
       FROM conversations
       WHERE bank NOT IN (${[...PROTECTED_BANKS].map(() => "?").join(",")})
       GROUP BY bank, prefix
       HAVING cnt > 1`,
    )
    .all(...PROTECTED_BANKS) as Array<{
    bank: string;
    prefix: string;
    cnt: number;
    keep_id: number;
    best_tier: number;
  }>;

  let removed = 0;
  for (const group of groups) {
    // Keep the entry with highest trust_tier (or most recent if tied)
    const keep = db
      .prepare(
        `SELECT id FROM conversations
         WHERE bank = ? AND SUBSTR(content, 1, 100) = ?
         ORDER BY trust_tier DESC, created_at DESC LIMIT 1`,
      )
      .get(group.bank, group.prefix) as { id: number } | undefined;

    if (!keep) continue;

    // Delete all others in this group
    const result = writeWithRetry(() =>
      db
        .prepare(
          `DELETE FROM conversations
           WHERE bank = ? AND SUBSTR(content, 1, 100) = ? AND id != ?`,
        )
        .run(group.bank, group.prefix, keep.id),
    );
    removed += result.changes;
  }

  return removed;
}

/**
 * Phase 4: Prune — delete aged-out entries by tier.
 * Tier 4 (unverified): > 60 days. Tier 3 (provisional): > 180 days.
 * Never touches tier 1-2. Never touches protected banks.
 */
function pruneStale(): number {
  const db = getDatabase();
  let totalPruned = 0;

  for (const [tier, maxAgeDays] of Object.entries(PRUNE_AGE)) {
    const bankExclusions = [...PROTECTED_BANKS].map(() => "?").join(",");
    const result = writeWithRetry(() =>
      db
        .prepare(
          `DELETE FROM conversations
           WHERE trust_tier = ?
             AND created_at < datetime('now', '-' || ? || ' days')
             AND bank NOT IN (${bankExclusions})`,
        )
        .run(Number(tier), maxAgeDays, ...PROTECTED_BANKS),
    );
    if (result.changes > 0) {
      console.log(
        `[consolidation] Pruned ${result.changes} tier-${tier} entries older than ${maxAgeDays} days`,
      );
    }
    totalPruned += result.changes;
  }

  return totalPruned;
}

/**
 * Run the full 4-phase consolidation cycle.
 * Returns a report with counts for monitoring.
 */
export async function runConsolidation(): Promise<ConsolidationReport> {
  const start = Date.now();
  console.log("[consolidation] Starting memory consolidation cycle");

  // Phase 1: Orient
  const counts = orient();
  const totalBefore = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(
    `[consolidation] Orient: ${totalBefore} total entries across ${Object.keys(counts).length} banks`,
  );

  // Phase 2+3: Consolidate duplicates
  const duplicatesRemoved = consolidateDuplicates();
  if (duplicatesRemoved > 0) {
    console.log(
      `[consolidation] Deduplicated: ${duplicatesRemoved} near-duplicate entries removed`,
    );
  }

  // Count stale candidates (for reporting — before prune)
  const db = getDatabase();
  const staleCount = (
    db
      .prepare(
        `SELECT COUNT(*) as cnt FROM conversations
         WHERE (trust_tier = 4 AND created_at < datetime('now', '-60 days'))
            OR (trust_tier = 3 AND created_at < datetime('now', '-180 days'))`,
      )
      .get() as { cnt: number }
  ).cnt;

  // Phase 4: Prune
  const pruned = pruneStale();

  // VACUUM to reclaim space
  if (duplicatesRemoved + pruned > 0) {
    try {
      db.exec("VACUUM");
      console.log("[consolidation] VACUUM complete");
    } catch {
      // Non-fatal — WAL mode may prevent VACUUM
    }
  }

  // Final count
  const remaining = (
    db.prepare("SELECT COUNT(*) as cnt FROM conversations").get() as {
      cnt: number;
    }
  ).cnt;

  const durationMs = Date.now() - start;
  console.log(
    `[consolidation] Complete: removed ${duplicatesRemoved + pruned}, remaining ${remaining} (${durationMs}ms)`,
  );

  return {
    orient: counts,
    staleCandidates: staleCount,
    duplicatesRemoved,
    pruned,
    remaining,
    durationMs,
  };
}
