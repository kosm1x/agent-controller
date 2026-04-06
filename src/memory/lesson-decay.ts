/**
 * Lesson Fingerprinting — Confidence Decay Sweep (v6.2 M1)
 *
 * Weekly cron that marks low-confidence, unreinforced KB entries as stale.
 * Uses the kb_decay_sweep Postgres RPC function for atomic server-side update.
 *
 * Entries become stale when:
 *   confidence < 0.1 AND reinforcement_count = 0 AND age > 7 days
 *
 * Stale entries are excluded from pgvector hybrid search (kb_hybrid_search
 * has WHERE stale = false) but remain in the database for historical reference.
 *
 * Also provides KB health stats via kb_health_stats RPC.
 */

import {
  isPgvectorEnabled,
  getApiKey,
  supabaseHeaders,
} from "../db/pgvector.js";

const SUPABASE_RPC_URL = "https://db.mycommit.net/rest/v1/rpc";

// ---------------------------------------------------------------------------
// Decay sweep
// ---------------------------------------------------------------------------

/**
 * Run the weekly confidence decay sweep.
 * Returns the number of entries marked stale, or -1 on failure.
 */
export async function runDecaySweep(
  minAgeDays = 7,
  confidenceThreshold = 0.1,
): Promise<number> {
  const apiKey = getApiKey();
  if (!apiKey || !isPgvectorEnabled()) return -1;

  try {
    const res = await fetch(`${SUPABASE_RPC_URL}/kb_decay_sweep`, {
      method: "POST",
      headers: supabaseHeaders(apiKey),
      body: JSON.stringify({
        min_age_days: minAgeDays,
        confidence_threshold: confidenceThreshold,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      console.warn(`[lesson-decay] Sweep failed: ${res.status}`);
      return -1;
    }

    const affected = (await res.json()) as number;
    if (affected > 0) {
      console.log(
        `[lesson-decay] Sweep complete: ${affected} entries marked stale`,
      );
    }
    return affected;
  } catch (err) {
    console.warn(
      "[lesson-decay] Sweep error:",
      err instanceof Error ? err.message : err,
    );
    return -1;
  }
}

// ---------------------------------------------------------------------------
// Health stats
// ---------------------------------------------------------------------------

export interface KbHealthStats {
  totalEntries: number;
  activeEntries: number;
  staleEntries: number;
  avgConfidence: number;
  reinforcedEntries: number;
  avgReinforcements: number;
}

/**
 * Get KB health stats from pgvector.
 * Returns null on failure.
 */
export async function getKbHealthStats(): Promise<KbHealthStats | null> {
  const apiKey = getApiKey();
  if (!apiKey || !isPgvectorEnabled()) return null;

  try {
    const res = await fetch(`${SUPABASE_RPC_URL}/kb_health_stats`, {
      method: "POST",
      headers: supabaseHeaders(apiKey),
      body: "{}",
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) return null;

    const rows = (await res.json()) as Array<{
      total_entries: number;
      active_entries: number;
      stale_entries: number;
      avg_confidence: number;
      reinforced_entries: number;
      avg_reinforcements: number;
    }>;

    if (rows.length === 0) return null;
    const r = rows[0];

    return {
      totalEntries: r.total_entries,
      activeEntries: r.active_entries,
      staleEntries: r.stale_entries,
      avgConfidence: r.avg_confidence,
      reinforcedEntries: r.reinforced_entries,
      avgReinforcements: r.avg_reinforcements,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cron registration
// ---------------------------------------------------------------------------

/**
 * Register the weekly decay sweep cron job.
 * Runs every Sunday at 2:00 AM Mexico City time.
 * Call this from the ritual scheduler initialization.
 */
// ---------------------------------------------------------------------------
// Retention sweep (v6.2 M2 — Ebbinghaus)
// ---------------------------------------------------------------------------

export interface RetentionSweepResult {
  swept: number;
  hot: number;
  warm: number;
  cold: number;
  evictable: number;
}

/**
 * Run the nightly Ebbinghaus retention sweep.
 * Computes retention score for each active entry, marks evictable as stale.
 * Returns tier counts + swept count, or null on failure.
 */
export async function runRetentionSweep(
  evictionThreshold = 0.15,
): Promise<RetentionSweepResult | null> {
  const apiKey = getApiKey();
  if (!apiKey || !isPgvectorEnabled()) return null;

  try {
    const res = await fetch(`${SUPABASE_RPC_URL}/kb_retention_sweep`, {
      method: "POST",
      headers: supabaseHeaders(apiKey),
      body: JSON.stringify({ eviction_threshold: evictionThreshold }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      console.warn(`[retention] Sweep failed: ${res.status}`);
      return null;
    }

    const rows = (await res.json()) as RetentionSweepResult[];
    if (rows.length === 0) return null;

    const result = rows[0];
    console.log(
      `[retention] Sweep: ${result.swept} evicted | hot=${result.hot} warm=${result.warm} cold=${result.cold} evictable=${result.evictable}`,
    );
    return result;
  } catch (err) {
    console.warn(
      "[retention] Sweep error:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cron registration (M1 weekly decay + M2 nightly retention)
// ---------------------------------------------------------------------------

export function registerDecayCron(): void {
  if (!isPgvectorEnabled()) {
    console.log("[lesson-decay] pgvector not enabled, skipping crons");
    return;
  }

  import("node-cron")
    .then((cron) => {
      // M1: Weekly confidence decay (Sundays 2 AM)
      cron.default.schedule(
        "0 2 * * 0",
        () => {
          runDecaySweep().catch((err) => {
            console.warn(
              "[lesson-decay] Cron sweep failed:",
              err instanceof Error ? err.message : err,
            );
          });
        },
        { timezone: "America/Mexico_City" },
      );

      // M2: Nightly retention scoring (daily 3 AM)
      cron.default.schedule(
        "0 3 * * *",
        () => {
          runRetentionSweep().catch((err) => {
            console.warn(
              "[retention] Nightly sweep failed:",
              err instanceof Error ? err.message : err,
            );
          });
        },
        { timezone: "America/Mexico_City" },
      );

      console.log(
        "[lesson-decay] Crons scheduled: M1 Sundays 2 AM + M2 nightly 3 AM",
      );
    })
    .catch(() => {
      console.warn("[lesson-decay] Failed to register crons");
    });
}
