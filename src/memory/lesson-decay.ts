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

import { isPgvectorEnabled } from "../db/pgvector.js";

const SUPABASE_RPC_URL = "https://db.mycommit.net/rest/v1/rpc";

function getApiKey(): string | null {
  return process.env.COMMIT_DB_KEY ?? null;
}

function headers(apiKey: string): Record<string, string> {
  return {
    apikey: apiKey,
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

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
      headers: headers(apiKey),
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
      headers: headers(apiKey),
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
export function registerDecayCron(): void {
  if (!isPgvectorEnabled()) {
    console.log("[lesson-decay] pgvector not enabled, skipping cron");
    return;
  }

  // Dynamic import to avoid circular deps with node-cron
  import("node-cron")
    .then((cron) => {
      cron.default.schedule(
        "0 2 * * 0", // Sunday 2 AM
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
      console.log(
        "[lesson-decay] Decay sweep scheduled: Sundays 2:00 AM Mexico City",
      );
    })
    .catch(() => {
      console.warn("[lesson-decay] Failed to register cron");
    });
}
