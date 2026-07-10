/**
 * §13 activation gate — V8.1 Phase 9.
 *
 * Evaluates whether V8.1's Proactive Context Engine is ready to be declared
 * active, per spec §13:
 *   - cache-read ratio ≥ 80% over a rolling 24h window of CACHEABLE inference
 *     (everything except `reflection:%` and `heavy` — see the two notes below);
 *   - ≥ 20 cacheable runs in that window — enough signal to trust the ratio;
 *   - morning-surface briefing promote-rate ≥ 60% over the last 7 days.
 *
 * Reads two ledgers: `cost_ledger` rows that clear the cacheable filter, and
 * `proposed_briefings`. Pure read — no writes, no side effects. Surfaced to
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
 *   measuring the high-frequency path where TTL actually covers inter-run
 *   gaps. See feedback_gate_target_must_match_cadence.
 *
 * Spec correction (2026-07-10) — `heavy` is NOT a high-frequency path:
 *   The 2026-05-27 note assumed `heavy` sat on the high-frequency side. Live
 *   `cost_ledger` says otherwise: `heavy` fires EXACTLY ONCE PER DAY (14/14
 *   days, one run each), so every run is a cold start whose first turn must
 *   pay `cache_creation` — the same TTL argument that excluded `reflection:%`.
 *   Worse, its ratio is capped by turn count, not prefix health: a cold N-turn
 *   run creates the prefix once and reads it N-1 times, so cache-read ≤
 *   (N-1)/N. The ratio therefore tracks TURN COUNT, not cache health: on
 *   recent days `heavy` runs ~1.7-1.9 turns (prompt/cache_creation) → a ~43-48%
 *   ceiling, which is exactly what it measures; on 2026-06-27/28 it ran ~4.5
 *   turns and measured 75.7-77.6% with no cache change. Including it dragged
 *   the 24h aggregate to ~78.3% while `fast` — the path this check actually
 *   exists to watch — sat at 80.5% (87.2% over 14d). Note the ceiling is
 *   INDEPENDENT of prefix size: shrinking `heavy`'s ~350k-token cold prefix
 *   would cut cost but move the ratio by ~0, so no prompt-prefix work can lift
 *   it. Excluded here to keep §13 measuring what it claims to measure.
 *   Trade-off: `heavy`'s cold start (~$8/run) no longer gates §13 — it stays
 *   visible, non-gating, via `excludedColdStart` (rendered by `mc-ctl
 *   briefing-gate`) and `mc-ctl audit-claim cache-hit --stratify-by=agent_type`.
 */

import { getDatabase } from "../db/index.js";
import { REFLECTION_AGENT_TYPE_PREFIX } from "../budget/service.js";

/** spec §13 thresholds. */
export const GATE_CACHE_READ_PCT = 80;
export const GATE_MIN_CACHEABLE_RUNS = 20;
export const GATE_MORNING_PROMOTE_PCT = 60;

/**
 * Agent types excluded from the §13 cache-read ratio because they fire less
 * often than the prompt cache's 5-min TTL, so every run is a cold start that
 * MUST pay `cache_creation` — a structural floor, not a cache regression.
 * `reflection:%` is matched by prefix (see `REFLECTION_AGENT_TYPE_PREFIX`);
 * this list is the exact-match half. See the 2026-07-10 spec-correction note.
 *
 * MUST stay non-empty: it is interpolated into `NOT IN (...)`, and SQLite
 * rejects `NOT IN ()` as a syntax error. Fail-loud by design — an empty list
 * would mean the exclusion silently stopped applying.
 */
export const GATE_COLD_START_AGENT_TYPES = ["heavy"] as const;

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
  /**
   * Count of cacheable inference runs in 24h — i.e. rows surviving BOTH the
   * `reflection:%` prefix filter and the `GATE_COLD_START_AGENT_TYPES` filter.
   */
  cacheableRuns: number;
  /** Total cost ($) of those cacheable runs in 24h. */
  cacheableCostUsd: number;
  /**
   * The cold-start rows this gate deliberately does NOT score (`heavy`), last
   * 24h. Reported for observability ONLY — never gates. Exists so the
   * exclusion can't silently hide a regression: if `runs` climbs well past 1/day
   * the cold-start premise has lapsed and `heavy` belongs back in the ratio; if
   * `cacheReadPct` collapses toward 0 (vs its ~(N-1)/N turn ceiling) its caching
   * is genuinely broken. `null` pct = no such rows in the window.
   */
  excludedColdStart: {
    runs: number;
    cacheReadPct: number | null;
    costUsd: number;
  };
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
  // Filter excludes `reflection:%` AND `GATE_COLD_START_AGENT_TYPES` (`heavy`)
  // because those rows fire too infrequently for the 5-min prompt-cache TTL to
  // cover inter-run gaps (see both "Spec correction" notes in the module
  // docstring). Also filters `prompt_tokens
  // > 0` to skip null-usage rows that would otherwise pollute the ratio.
  //
  // `cost_ledger.created_at` defaults to `datetime('now')` (UTC); the window
  // bound below is UTC too, so the comparison is timezone-correct even though
  // the service runs TZ=America/Mexico_City. The same holds for the 7-day
  // briefing query — `generated_at` is written via `Date.toISOString()` (UTC).
  // Reuse `REFLECTION_AGENT_TYPE_PREFIX` (the same constant the writer in
  // budget/service.ts uses to label these rows) so a future rename of that
  // prefix can't silently break the gate by leaving stale rows uncounted.
  const coldStartPlaceholders = GATE_COLD_START_AGENT_TYPES.map(() => "?").join(
    ",",
  );
  const cache = db
    .prepare(
      `SELECT SUM(cache_read_tokens)    AS cache_read,
              SUM(prompt_tokens)        AS prompt,
              COUNT(*)                  AS runs,
              COALESCE(SUM(cost_usd),0) AS cost
         FROM cost_ledger
        WHERE agent_type NOT LIKE ?
          AND agent_type NOT IN (${coldStartPlaceholders})
          AND prompt_tokens > 0
          AND created_at > datetime('now','-1 day')`,
    )
    .get(
      `${REFLECTION_AGENT_TYPE_PREFIX}%`,
      ...GATE_COLD_START_AGENT_TYPES,
    ) as CacheRow;

  // The mirror of query 1: the cold-start rows we just excluded. Never gates —
  // rendered by `mc-ctl briefing-gate` so the exclusion stays auditable (W1).
  const excluded = db
    .prepare(
      `SELECT SUM(cache_read_tokens)    AS cache_read,
              SUM(prompt_tokens)        AS prompt,
              COUNT(*)                  AS runs,
              COALESCE(SUM(cost_usd),0) AS cost
         FROM cost_ledger
        WHERE agent_type IN (${coldStartPlaceholders})
          AND prompt_tokens > 0
          AND created_at > datetime('now','-1 day')`,
    )
    .get(...GATE_COLD_START_AGENT_TYPES) as CacheRow;

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
    excludedColdStart: {
      runs: excluded.runs,
      cacheReadPct:
        excluded.prompt && excluded.prompt > 0
          ? round1((100 * (excluded.cache_read ?? 0)) / excluded.prompt)
          : null,
      costUsd: Math.round(excluded.cost * 10000) / 10000,
    },
    briefingHealth,
    checks: {
      cacheRead: { pass: cacheReadPass, detail: cacheDetail },
      promoteRate: { pass: promoteRatePass, detail: promoteDetail },
    },
    verdict,
  };
}
