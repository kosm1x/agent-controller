/**
 * §13 activation gate — V8.1 Phase 9.
 *
 * Evaluates whether V8.1's Proactive Context Engine is ready to be declared
 * active, per spec §13:
 *   - cache-read ratio ≥ 80% over a rolling 24h window of reflection
 *     inference (the V8-VISION §4-V8.1 explicit gate);
 *   - ≥ 5 reflection runs in that window — enough signal to trust the ratio;
 *   - morning-surface briefing promote-rate ≥ 60% over the last 7 days.
 *
 * Reads two ledgers: `cost_ledger` rows tagged `agent_type LIKE 'reflection:%'`
 * (written by `recordReflectionCost`, Phase 9) and `proposed_briefings`. Pure
 * read — no writes, no side effects. Surfaced to the operator via
 * `mc-ctl briefing-gate` (→ `scripts/briefing-gate.ts`).
 */

import { getDatabase } from "../db/index.js";
import { REFLECTION_AGENT_TYPE_PREFIX } from "../budget/service.js";

/** spec §13 thresholds. */
export const GATE_CACHE_READ_PCT = 80;
export const GATE_MIN_REFLECTION_RUNS = 5;
export const GATE_MORNING_PROMOTE_PCT = 60;

export interface BriefingSurfaceHealth {
  surface: string;
  generated: number;
  promoted: number;
  discarded: number;
  expired: number;
  pending: number;
  /** promoted / generated, as a percentage. */
  promoteRatePct: number;
}

export interface ActivationGateCheck {
  pass: boolean;
  detail: string;
}

export interface ActivationGateResult {
  /** Cache-read ratio (%) over reflection inference, last 24h. null = no rows. */
  cacheReadPct: number | null;
  reflectionRuns: number;
  reflectionCostUsd: number;
  briefingHealth: BriefingSurfaceHealth[];
  checks: {
    cacheRead: ActivationGateCheck;
    promoteRate: ActivationGateCheck;
  };
  /**
   * `pass` — both §13 checks green; `fail` — measurable but below a threshold;
   * `insufficient_data` — not enough reflection runs / resolved briefings to
   * judge yet (the expected verdict during the early shadow run).
   */
  verdict: "pass" | "fail" | "insufficient_data";
}

interface CacheRow {
  cache_read: number | null;
  prompt: number | null;
  runs: number;
  cost: number;
}

interface HealthRow {
  surface: string;
  generated: number;
  promoted: number;
  discarded: number;
  expired: number;
  pending: number;
}

/** Round to one decimal place. */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Evaluate the §13 activation gate against the live ledgers. Safe to call any
 * time — during the shadow run it returns `insufficient_data`.
 */
export function evaluateActivationGate(): ActivationGateResult {
  const db = getDatabase();

  // §13 query 1 — cache-read ratio over reflection inference, rolling 24h.
  // `cost_ledger.created_at` defaults to `datetime('now')` (UTC); the window
  // bound below is UTC too, so the comparison is timezone-correct even though
  // the service runs TZ=America/Mexico_City. The same holds for the 7-day
  // briefing query — `generated_at` is written via `Date.toISOString()` (UTC).
  const cache = db
    .prepare(
      `SELECT SUM(cache_read_tokens)    AS cache_read,
              SUM(prompt_tokens)        AS prompt,
              COUNT(*)                  AS runs,
              COALESCE(SUM(cost_usd),0) AS cost
         FROM cost_ledger
        WHERE agent_type LIKE ?
          AND created_at > datetime('now','-1 day')`,
    )
    .get(`${REFLECTION_AGENT_TYPE_PREFIX}%`) as CacheRow;

  const reflectionRuns = cache.runs;
  const cacheReadPct =
    cache.prompt && cache.prompt > 0
      ? round1((100 * (cache.cache_read ?? 0)) / cache.prompt)
      : null;

  // §13 query 2 — briefing health over the last 7 days, per surface.
  const healthRows = db
    .prepare(
      `SELECT surface,
              COUNT(*)                          AS generated,
              COALESCE(SUM(status='promoted'),0)  AS promoted,
              COALESCE(SUM(status='discarded'),0) AS discarded,
              COALESCE(SUM(status='expired'),0)   AS expired,
              COALESCE(SUM(status='pending'),0)   AS pending
         FROM proposed_briefings
        WHERE generated_at > datetime('now','-7 days')
        GROUP BY surface`,
    )
    .all() as HealthRow[];

  const briefingHealth: BriefingSurfaceHealth[] = healthRows.map((r) => ({
    surface: r.surface,
    generated: r.generated,
    promoted: r.promoted,
    discarded: r.discarded,
    expired: r.expired,
    pending: r.pending,
    promoteRatePct:
      r.generated > 0 ? round1((100 * r.promoted) / r.generated) : 0,
  }));
  const morning = briefingHealth.find((h) => h.surface === "morning");

  // --- Check 1: cache-read ratio (needs ≥ GATE_MIN_REFLECTION_RUNS to judge).
  const cacheReadMeasurable =
    cacheReadPct !== null && reflectionRuns >= GATE_MIN_REFLECTION_RUNS;
  const cacheReadPass =
    cacheReadMeasurable && cacheReadPct >= GATE_CACHE_READ_PCT;
  const cacheDetail =
    cacheReadPct === null
      ? "no reflection inference recorded in the last 24h"
      : reflectionRuns < GATE_MIN_REFLECTION_RUNS
        ? `only ${reflectionRuns} reflection run(s) in 24h (need ≥${GATE_MIN_REFLECTION_RUNS})`
        : `cache-read ${cacheReadPct}% over ${reflectionRuns} runs (need ≥${GATE_CACHE_READ_PCT}%)`;

  // --- Check 2: morning promote-rate (judgeable only once briefs resolved).
  const morningResolved = morning
    ? morning.promoted + morning.discarded + morning.expired
    : 0;
  const promoteMeasurable = morning !== undefined && morningResolved > 0;
  const promoteRatePass =
    promoteMeasurable && morning.promoteRatePct >= GATE_MORNING_PROMOTE_PCT;
  const promoteDetail = !morning
    ? "no morning briefings generated in the last 7 days"
    : morningResolved === 0
      ? `${morning.generated} morning brief(s) generated, none resolved yet`
      : `morning promote-rate ${morning.promoteRatePct}% (need ≥${GATE_MORNING_PROMOTE_PCT}%)`;

  let verdict: ActivationGateResult["verdict"];
  if (!cacheReadMeasurable || !promoteMeasurable) {
    verdict = "insufficient_data";
  } else if (cacheReadPass && promoteRatePass) {
    verdict = "pass";
  } else {
    verdict = "fail";
  }

  return {
    cacheReadPct,
    reflectionRuns,
    reflectionCostUsd: Math.round(cache.cost * 10000) / 10000,
    briefingHealth,
    checks: {
      cacheRead: { pass: cacheReadPass, detail: cacheDetail },
      promoteRate: { pass: promoteRatePass, detail: promoteDetail },
    },
    verdict,
  };
}
