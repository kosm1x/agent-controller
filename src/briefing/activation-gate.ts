/**
 * §13 activation gate — V8.1 Phase 9.
 *
 * Evaluates whether V8.1's Proactive Context Engine is ready to be declared
 * active, per spec §13:
 *   - cache-read ratio ≥ 80% over a rolling 24h window of CACHEABLE inference
 *     (everything except `reflection:%` — see "Spec correction" note below);
 *   - ≥ 20 cacheable runs in that window — enough signal to trust the ratio;
 *   - morning-surface briefing promote-rate ≥ 60% over the last 7 days.
 *
 * Reads two ledgers: `cost_ledger` rows where `agent_type NOT LIKE 'reflection:%'`
 * and `proposed_briefings`. Pure read — no writes, no side effects. Surfaced to
 * the operator via `mc-ctl briefing-gate` (→ `scripts/briefing-gate.ts`).
 *
 * Spec correction (2026-05-27):
 *   The original §13 measured cache-read% on `reflection:%` agent_types
 *   (briefing-construct + n-turn reflection). That metric is structurally
 *   unachievable: Anthropic's prompt cache has a 5-min default TTL, but
 *   morning-briefing construction fires once per day and n-turn reflection
 *   fires ~hourly — every adjacent-run gap exceeds the TTL, so cache-read is
 *   ~0% by structural design, not by regression. The intent of the check
 *   (verify caching is wired in the substrate V8.1 sits on) is preserved by
 *   measuring the high-frequency path (`fast`, `heavy`, etc.) where TTL
 *   actually covers inter-run gaps. See feedback_gate_target_must_match_cadence.
 */

import { getDatabase } from "../db/index.js";
import { REFLECTION_AGENT_TYPE_PREFIX } from "../budget/service.js";

/** spec §13 thresholds. */
export const GATE_CACHE_READ_PCT = 80;
export const GATE_MIN_CACHEABLE_RUNS = 20;
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
  /** Cache-read ratio (%) over cacheable inference, last 24h. null = no rows. */
  cacheReadPct: number | null;
  /** Count of cacheable inference runs (agent_type NOT LIKE 'reflection:%') in 24h. */
  cacheableRuns: number;
  /** Total cost ($) of those cacheable runs in 24h. */
  cacheableCostUsd: number;
  briefingHealth: BriefingSurfaceHealth[];
  checks: {
    cacheRead: ActivationGateCheck;
    promoteRate: ActivationGateCheck;
  };
  /**
   * `pass` — both §13 checks green; `fail` — measurable but below a threshold;
   * `insufficient_data` — not enough cacheable runs / resolved briefings to
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

  // §13 query 1 — cache-read ratio over CACHEABLE inference, rolling 24h.
  // Filter excludes `reflection:%` because those rows fire too infrequently
  // for the 5-min prompt-cache TTL to cover inter-run gaps (see "Spec
  // correction" note in the module docstring). Also filters `prompt_tokens
  // > 0` to skip null-usage rows that would otherwise pollute the ratio.
  //
  // `cost_ledger.created_at` defaults to `datetime('now')` (UTC); the window
  // bound below is UTC too, so the comparison is timezone-correct even though
  // the service runs TZ=America/Mexico_City. The same holds for the 7-day
  // briefing query — `generated_at` is written via `Date.toISOString()` (UTC).
  // Reuse `REFLECTION_AGENT_TYPE_PREFIX` (the same constant the writer in
  // budget/service.ts uses to label these rows) so a future rename of that
  // prefix can't silently break the gate by leaving stale rows uncounted.
  const cache = db
    .prepare(
      `SELECT SUM(cache_read_tokens)    AS cache_read,
              SUM(prompt_tokens)        AS prompt,
              COUNT(*)                  AS runs,
              COALESCE(SUM(cost_usd),0) AS cost
         FROM cost_ledger
        WHERE agent_type NOT LIKE ?
          AND prompt_tokens > 0
          AND created_at > datetime('now','-1 day')`,
    )
    .get(`${REFLECTION_AGENT_TYPE_PREFIX}%`) as CacheRow;

  const cacheableRuns = cache.runs;
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

  // --- Check 1: cache-read ratio (needs ≥ GATE_MIN_CACHEABLE_RUNS to judge).
  const cacheReadMeasurable =
    cacheReadPct !== null && cacheableRuns >= GATE_MIN_CACHEABLE_RUNS;
  const cacheReadPass =
    cacheReadMeasurable && cacheReadPct >= GATE_CACHE_READ_PCT;
  const cacheDetail =
    cacheReadPct === null
      ? "no cacheable inference recorded in the last 24h"
      : cacheableRuns < GATE_MIN_CACHEABLE_RUNS
        ? `only ${cacheableRuns} cacheable run(s) in 24h (need ≥${GATE_MIN_CACHEABLE_RUNS})`
        : `cache-read ${cacheReadPct}% over ${cacheableRuns} runs (need ≥${GATE_CACHE_READ_PCT}%)`;

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
    cacheableRuns,
    cacheableCostUsd: Math.round(cache.cost * 10000) / 10000,
    briefingHealth,
    checks: {
      cacheRead: { pass: cacheReadPass, detail: cacheDetail },
      promoteRate: { pass: promoteRatePass, detail: promoteDetail },
    },
    verdict,
  };
}
