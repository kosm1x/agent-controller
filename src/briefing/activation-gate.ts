/**
 * §13 activation gate — V8.1 Phase 9.
 *
 * §13 v2 (operator ruling 2026-10-06): the verdict is scored on FIVE checks
 * about the 08:00 Morning Sync — delivery, cleanCompletion, grounding,
 * operatorVerdict, costPerRun (see `evaluateMorningSync`). The lines below
 * describe the LEGACY §13 terms, still computed and rendered as unscored
 * information (`legacy`, `legacyVerdict`): the cache ratio tracks run length.
 *
 * Legacy spec §13:
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
import { RITUALS_TIMEZONE } from "../rituals/config.js";

/** spec §13 thresholds. */
export const GATE_CACHE_READ_PCT = 80;
export const GATE_MIN_CACHEABLE_RUNS = 20;
export const GATE_MORNING_PROMOTE_PCT = 60;

/**
 * Minimum morning briefs carrying a real operator verdict before check 2's
 * promote-rate is trusted. Since §17 6a was removed (2026-08-02 — see the module
 * doc in `v82-activation-gate.ts`), check 2 is the gate system's ONLY
 * promote-rate measure: it asks whether delivered briefs are useful, and makes
 * no discrimination claim over the §12 confidence colors.
 *
 * Without a floor, `ruled > 0` lets a SINGLE ruling decide the gate: one
 * discarded brief in a quiet week is `0/1 = 0%` → measurable → §13 FAIL. That
 * became reachable the moment promotion started requiring an explicit verdict
 * (most briefs now expire unruled), so the floor ships with it. Below it →
 * `insufficient_data`, never `fail`. (qa-auditor W-B, 2026-07-10.)
 */
export const GATE_MIN_RULED_BRIEFS = 3;

/**
 * Agent types whose cold-start rows are RENDERED separately by
 * `mc-ctl briefing-gate` (the "excluded" mirror query) so the §13 exclusion
 * stays auditable. These fire less often than the prompt cache's 5-min TTL,
 * so every run is a cold start that MUST pay `cache_creation` — a structural
 * floor, not a cache regression. Since V8.5 Phase 3.3 the GATE filter itself
 * is the `GATE_CACHEABLE_AGENT_TYPES` allow-list below; this const no longer
 * shapes the ratio, only the mirror display.
 *
 * MUST stay non-empty: it is interpolated into `IN (...)`, and SQLite
 * rejects `IN ()` as a syntax error.
 *
 * `nanoclaw` added 2026-08-02. It had been in the CACHEABLE allow-list below
 * while meeting this list's criterion more strongly than `heavy` does — every
 * run gets a fresh Docker container and a fresh clone, so it can never reuse a
 * prompt-cache prefix across runs. Measured over 30d: `nanoclaw` pooled 34.5%
 * cache-read over 49 runs / 72.0M prompt tokens, versus `heavy` (already
 * excluded for coldness) at 61.8% and the hot path `fast` at 85.8%. The
 * excluded type was warmer than the scored one — a category error, not a
 * threshold problem.
 *
 * It bit because the ratio is TOKEN-weighted (`SUM/SUM`), so a low-count,
 * multi-million-token runner outvotes the whole hot path: on 2026-08-02 a
 * single 3.13M-token nanoclaw run at 0% cache-read pulled the 24h ratio from
 * 94.7% (18 `fast` runs) to 76.8% and failed §13 on its own.
 *
 * CRITERION for adding a future runner here: does it start from a cold prompt
 * prefix on EVERY run (containerized, fresh clone, or fires less often than the
 * 5-min cache TTL)? If yes it belongs here, not in the allow-list — regardless
 * of how good its numbers happen to look this week. Do NOT instead make the
 * ratio weight-robust (median/capped contribution): pooled token share is the
 * cost-relevant question the gate exists to ask, and blunting it would mask a
 * genuine hot-path cache regression.
 */
export const GATE_COLD_START_AGENT_TYPES = ["heavy", "nanoclaw"] as const;

/**
 * ALLOW-LIST of agent_type values the §13 cache-read ratio measures — the
 * exact population the gate covered before V8.5 Phase 3.3, when the query
 * was exclusion-based (`NOT LIKE 'reflection:%' AND NOT IN ('heavy')`).
 *
 * 3.3's claude-sdk seam metering added whole new row CLASSES to cost_ledger
 * (`sdk:unattributed`, `chat:*`, `aux:*`, `v82:*`, `audit:*`, `tuning:*`) —
 * mostly tiny, cache-cold aux calls. Under the old exclusion filter every
 * one of them would have silently joined the ratio's denominator and could
 * flip the razor-thin PASS (80.51 vs 80). Exclusion lists silently widen;
 * gates enumerate what they MEAN to measure (feedback_allow_list_state_gating).
 * A future agent_type stays OUT of the gate until deliberately added here.
 *
 * `skill:` is a prefix (writer uses `skill:<name>`), matched via LIKE.
 */
export const GATE_CACHEABLE_AGENT_TYPES = [
  "fast",
  "swarm",
  // `nanoclaw` was here until 2026-08-02 — moved to GATE_COLD_START_AGENT_TYPES
  // (containerized, fresh clone per run ⇒ structurally cold). See that const.
  "a2a",
  "self-healing-triage",
  "hindsight",
] as const;
export const GATE_CACHEABLE_AGENT_PREFIX = "skill:" as const;

export interface BriefingSurfaceHealth {
  surface: string;
  generated: number;
  promoted: number;
  discarded: number;
  expired: number;
  pending: number;
  /** Briefs carrying a real operator verdict: `promoted + discarded`. */
  ruled: number;
  /** promoted / RULED, as a percentage (0 when nothing was ruled on). Excludes
   *  `expired`/`pending` — the absence of a verdict is not a rejection. */
  promoteRatePct: number;
}

export interface ActivationGateCheck {
  pass: boolean;
  detail: string;
}

/** A scored §13 v2 check: three-state, `pass` mirrors `status === "pass"`. */
export interface ScoredGateCheck extends ActivationGateCheck {
  status: "pass" | "fail" | "insufficient_data";
}

// ── §13 v2 (operator ruling 2026-10-06): score the Morning Sync itself ──────
//
// The legacy 24h cache-read ratio tracks run length (one ledger row per run
// summing its turns: 1–2-turn runs read ~41 %, 9+-turn runs ~87 %), and the
// promote-rate line retired 2026-08-03 when the 08:00 Morning Sync became
// V8.1's surface. Both stay visible as UNSCORED information (`legacy`); the
// verdict rides on the five checks below.

/** Predecessor Morning Sync schedule ids, deleted from `scheduled_tasks` but
 *  still inside the window. Their deliveries count as Morning Sync runs. */
export const RETIRED_MORNING_SYNC_SCHEDULE_IDS = [
  "6c312196-87e9-4741-987e-0a1bfec089eb",
] as const;
export const MORNING_SYNC_NAME_PATTERN = "Morning Sync%";
/** Calendar days (MX) in the delivery / completion / grounding / cost window. */
export const GATE_MS_WINDOW_DAYS = 14;
/** Calendar days (MX) in the operator-verdict window. */
export const GATE_MS_VERDICT_WINDOW_DAYS = 30;
/** Check 1: distinct delivered days needed out of GATE_MS_WINDOW_DAYS. */
export const GATE_MS_MIN_DELIVERED_DAYS = 13;
/** Check 2: hard defects allowed. */
export const GATE_MS_MAX_HARD_DEFECTS = 0;
export const GATE_MS_HARD_DEFECT_REASONS = [
  "max_turns",
  "tool_scope_block",
  "delivery_error",
] as const;
/** Checks 2, 3, 5: runs needed before the check is measurable. */
export const GATE_MS_MIN_RUNS = 7;
/** Check 3: ungrounded runs allowed in the window. */
export const GATE_MS_MAX_UNGROUNDED = 1;
/** Check 4: rated runs needed, and the positive share needed. */
export const GATE_MS_MIN_RATED = 5;
export const GATE_MS_MIN_POSITIVE_SHARE = 0.6;
/** Check 5: median USD per run. */
export const GATE_MS_MAX_MEDIAN_COST_USD = 0.25;

export interface MorningSyncInfo {
  /** Morning Sync runs (distinct task ids) in the 14-day window. */
  runs: number;
  /** First-turn cache-read share, unscored. `null` = attrs not recorded yet. */
  firstTurn: {
    runsWithAttrs: number;
    cacheReadPct: number | null;
    cacheCreationTokens: number;
  };
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
  /** The five scored §13 v2 checks — the ONLY inputs to `verdict`. */
  checks: {
    delivery: ScoredGateCheck;
    cleanCompletion: ScoredGateCheck;
    grounding: ScoredGateCheck;
    operatorVerdict: ScoredGateCheck;
    costPerRun: ScoredGateCheck;
  };
  /** Unscored Morning Sync information. */
  morningSync: MorningSyncInfo;
  /**
   * Legacy §13 lines — information only since 2026-10-06 (the cache ratio
   * tracks run length; not scored). Computed exactly as before.
   */
  legacy: {
    cacheRead: ActivationGateCheck;
    promoteRate: ActivationGateCheck;
  };
  /** What the legacy two-line gate WOULD say. Never feeds `verdict`. */
  legacyVerdict: "pass" | "fail" | "insufficient_data";
  /**
   * `fail` if any scored check fails; else `insufficient_data` if any is not
   * measurable; else `pass`. An unmeasurable term never reads as PASS or FAIL.
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
 * Operator ruling 2026-08-03: the delivered morning brief is RETIRED as a
 * surface — the 08:00 Morning Sync carries the strategic reading instead
 * (lib/v8-2/sync-surfacing.ts). A CODE constant, not an env read: the gate
 * runs both inside the service (which sees `.env` via `EnvironmentFile=`) and
 * from `mc-ctl briefing-gate` (a bare shell that deliberately never sources
 * `.env` — qa R1-C2 caught the env read silently skipping the check in the
 * ONE process that actually runs it). Reversing the ruling = flip this here,
 * deliberately, in a commit.
 */
export const BRIEF_SURFACE_RETIRED = true;

/**
 * Evaluate the §13 activation gate against the live ledgers. Safe to call any
 * time — during the shadow run it returns `insufficient_data`.
 *
 * `opts.briefSurfaceRetired` (default: the ruling constant) exists so tests
 * can exercise the promote-rate SCORING path, which stays real code for a
 * possible reversal of the ruling.
 */
export function evaluateActivationGate(opts?: {
  briefSurfaceRetired?: boolean;
  /** Clock override for tests; defaults to now. */
  now?: Date;
}): ActivationGateResult {
  const db = getDatabase();

  // §13 query 1 — cache-read ratio over CACHEABLE inference, rolling 24h.
  // ALLOW-LIST filter (V8.5 Phase 3.3, audit C2): only the agent_type values
  // in `GATE_CACHEABLE_AGENT_TYPES` (+ the `skill:` prefix) enter the ratio —
  // the same population the old exclusion filter (`NOT LIKE 'reflection:%'
  // AND NOT IN ('heavy')`) measured before the claude-sdk seam metering
  // started writing new row classes. reflection:%/heavy stay out for the
  // original cold-start reason (they fire less often than the prompt-cache
  // TTL — see the "Spec correction" notes in the module docstring); the new
  // chat/aux/v82/tuning/sdk:unattributed classes stay out because they were
  // never part of the §13 population. Also filters `prompt_tokens > 0` to
  // skip null-usage rows that would otherwise pollute the ratio.
  //
  // `cost_ledger.created_at` defaults to `datetime('now')` (UTC); the window
  // bound below is UTC too, so the comparison is timezone-correct even though
  // the service runs TZ=America/Mexico_City. The same holds for the 7-day
  // briefing query — `generated_at` is written via `Date.toISOString()` (UTC).
  const coldStartPlaceholders = GATE_COLD_START_AGENT_TYPES.map(() => "?").join(
    ",",
  );
  const cacheablePlaceholders = GATE_CACHEABLE_AGENT_TYPES.map(() => "?").join(
    ",",
  );
  const cache = db
    .prepare(
      `SELECT SUM(cache_read_tokens)    AS cache_read,
              SUM(prompt_tokens)        AS prompt,
              COUNT(*)                  AS runs,
              COALESCE(SUM(cost_usd),0) AS cost
         FROM cost_ledger
        WHERE (agent_type IN (${cacheablePlaceholders})
           OR agent_type LIKE ?)
          AND prompt_tokens > 0
          AND created_at > datetime('now','-1 day')`,
    )
    .get(
      ...GATE_CACHEABLE_AGENT_TYPES,
      `${GATE_CACHEABLE_AGENT_PREFIX}%`,
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
    // RULED = the briefs the operator actually gave a verdict on. `expired`
    // (never answered) and `pending` (not yet answered) are the ABSENCE of a
    // verdict, not rejections — silence is ambiguous, so it cannot count against
    // the promote-rate. See the 2026-07-10 note on `promoteRatePct`.
    ruled: r.promoted + r.discarded,
    promoteRatePct:
      r.promoted + r.discarded > 0
        ? round1((100 * r.promoted) / (r.promoted + r.discarded))
        : 0,
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

  // --- Check 2: morning promote-rate over RULED briefs (2026-07-10).
  //
  // Was `promoted / generated`, with `expired` counted as "resolved". That held
  // only while ANY inbound owner message promoted the pending brief, so briefs
  // were effectively never expired-unread. Now that promotion requires an
  // explicit "sirve"/"descarta" (see `promote.ts` `classifyOperatorVerdict`), an
  // unanswered brief EXPIRES — and the old formula would read that silence as a
  // rejection, collapsing the rate below 60% and failing §13 for a reason that
  // has nothing to do with briefing quality.
  //
  // Silence is ambiguous (the operator may be busy, or the brief may have been
  // read and simply not answered), so an unruled brief is excluded rather than
  // charged against the rate. With zero rulings the check is `insufficient_data`,
  // never `fail` — the same cadence-trap discipline as §17. Note `expired` no
  // longer makes the check measurable; only a real verdict does.
  // With the brief surface retired (see BRIEF_SURFACE_RETIRED) this check can
  // never accrue data again, so it is scored as an explicit SKIP (pass,
  // annotated) — not `insufficient_data`, which would read as "still
  // accumulating" forever and hold the combined verdict hostage to a check the
  // operator deliberately retired (§14 vacuous-check discipline).
  const surfaceRetired = opts?.briefSurfaceRetired ?? BRIEF_SURFACE_RETIRED;
  const morningRuled = morning?.ruled ?? 0;
  const promoteScorable =
    morning !== undefined && morningRuled >= GATE_MIN_RULED_BRIEFS;
  const promoteMeasurable = surfaceRetired || promoteScorable;
  const promoteRatePass =
    surfaceRetired ||
    (promoteScorable && morning.promoteRatePct >= GATE_MORNING_PROMOTE_PCT);
  const promoteDetail = surfaceRetired
    ? "surface retired 2026-08-03 (Morning Sync carries the strategic reading); promote-rate not scored"
    : !morning
      ? "no morning briefings generated in the last 7 days"
      : morningRuled < GATE_MIN_RULED_BRIEFS
        ? `${morning.generated} morning brief(s) generated, only ${morningRuled} ruled on ` +
          `(need ≥${GATE_MIN_RULED_BRIEFS}; ${morning.expired} expired unanswered, ${morning.pending} pending)`
        : `morning promote-rate ${morning.promoteRatePct}% over ${morningRuled} ruled brief(s) (need ≥${GATE_MORNING_PROMOTE_PCT}%)`;

  // Legacy two-line verdict — kept as information, never feeds `verdict`.
  let legacyVerdict: ActivationGateResult["legacyVerdict"];
  if (!cacheReadMeasurable || !promoteMeasurable) {
    legacyVerdict = "insufficient_data";
  } else if (cacheReadPass && promoteRatePass) {
    legacyVerdict = "pass";
  } else {
    legacyVerdict = "fail";
  }

  const { checks, morningSync } = evaluateMorningSync(opts?.now ?? new Date());
  const states = Object.values(checks).map((c) => c.status);
  const verdict: ActivationGateResult["verdict"] = states.includes("fail")
    ? "fail"
    : states.includes("insufficient_data")
      ? "insufficient_data"
      : "pass";

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
    checks,
    morningSync,
    legacy: {
      cacheRead: { pass: cacheReadPass, detail: cacheDetail },
      promoteRate: { pass: promoteRatePass, detail: promoteDetail },
    },
    legacyVerdict,
    verdict,
  };
}

/**
 * The rituals-timezone (MX by default) calendar day (`YYYY-MM-DD`)
 * `offsetDays` before `now`. `ritual_deliveries.day` is written in
 * `RITUALS_TIMEZONE` (delivery-policy.ts), so the window bound uses that same
 * value — explicitly via Intl, never the process TZ (`mc-ctl briefing-gate`
 * runs from a bare shell, the service runs TZ=America/Mexico_City; both must
 * agree).
 */
export function morningSyncDay(now: Date, offsetDays = 0): string {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: RITUALS_TIMEZONE,
  }).format(now);
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - offsetDays);
  return d.toISOString().slice(0, 10);
}

function scored(
  status: ScoredGateCheck["status"],
  detail: string,
): ScoredGateCheck {
  return { status, pass: status === "pass", detail };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Score the five §13 v2 checks over Morning Sync runs. Pure read. */
function evaluateMorningSync(now: Date): {
  checks: ActivationGateResult["checks"];
  morningSync: MorningSyncInfo;
} {
  const db = getDatabase();
  const retiredJson = JSON.stringify(RETIRED_MORNING_SYNC_SCHEDULE_IDS);
  const namedSchedules = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM scheduled_tasks WHERE name LIKE ?`)
      .get(MORNING_SYNC_NAME_PATTERN) as { n: number }
  ).n;
  // A Morning Sync run = a delivery or a `schedule_runs` row of a
  // `Morning Sync%` schedule (live) or a retired predecessor id.
  const msScheduleIds = `SELECT schedule_id FROM scheduled_tasks WHERE name LIKE ?
      UNION SELECT value FROM json_each(?)`;
  const msRitual = `ritual_id IN (SELECT 'schedule:' || schedule_id FROM (${msScheduleIds}))`;
  const today = morningSyncDay(now);
  // Window = `days` MX calendar days ending today, inclusive (exactly `days`).
  // Population = deliveries UNION schedule_runs, de-duplicated by task id:
  // `ritual_deliveries` is written only on the success broadcast path, so a
  // failed or cancelled run exists ONLY in `schedule_runs` (audit R1-W3).
  // `spawned_at` is UTC `datetime('now')` text, bucketed into its MX day in JS
  // (the SQL bound is a loose prefilter one day early). A run still `running`
  // on today's MX day is in flight and skipped; an older `running` row is a
  // lost run and counts.
  const runIds = (days: number): string[] => {
    const from = morningSyncDay(now, days - 1);
    const ids = new Set(
      (
        db
          .prepare(
            `SELECT DISTINCT task_id FROM ritual_deliveries
              WHERE ${msRitual} AND task_id IS NOT NULL AND day BETWEEN ? AND ?`,
          )
          .all(MORNING_SYNC_NAME_PATTERN, retiredJson, from, today) as {
          task_id: string;
        }[]
      ).map((r) => r.task_id),
    );
    const scheduleRuns = db
      .prepare(
        `SELECT task_id, spawned_at, status FROM schedule_runs
          WHERE schedule_id IN (${msScheduleIds})
            AND spawned_at >= date(?, '-1 day')`,
      )
      .all(MORNING_SYNC_NAME_PATTERN, retiredJson, from) as {
      task_id: string;
      spawned_at: string;
      status: string;
    }[];
    for (const r of scheduleRuns) {
      const day = morningSyncDay(
        new Date(`${r.spawned_at.replace(" ", "T")}Z`),
      );
      if (day < from || day > today) continue;
      if (r.status === "running" && day === today) continue;
      ids.add(r.task_id);
    }
    return [...ids];
  };
  const runs = runIds(GATE_MS_WINDOW_DAYS);
  const runsJson = JSON.stringify(runs);

  // 1. delivery — distinct delivered MX days in a 14-day window. The schedule
  // fires at 08:00 MX, so until today's run is delivered the window ends
  // YESTERDAY; otherwise a pre-08:00 read could reach at most 13/14 and one
  // earlier miss would flip the verdict by time of day (audit R1-W4).
  const deliveredDaysIn = (from: string, to: string): number =>
    (
      db
        .prepare(
          `SELECT COUNT(DISTINCT day) AS n FROM ritual_deliveries
            WHERE ${msRitual} AND delivered = 1 AND day BETWEEN ? AND ?`,
        )
        .get(MORNING_SYNC_NAME_PATTERN, retiredJson, from, to) as {
        n: number;
      }
    ).n;
  const deliveryEnd = deliveredDaysIn(today, today) > 0 ? 0 : 1;
  const deliveredDays = deliveredDaysIn(
    morningSyncDay(now, GATE_MS_WINDOW_DAYS - 1 + deliveryEnd),
    morningSyncDay(now, deliveryEnd),
  );
  const delivery =
    namedSchedules === 0
      ? scored(
          "fail",
          `no schedule named \`${MORNING_SYNC_NAME_PATTERN}\` exists in scheduled_tasks`,
        )
      : scored(
          deliveredDays >= GATE_MS_MIN_DELIVERED_DAYS ? "pass" : "fail",
          `delivered on ${deliveredDays}/${GATE_MS_WINDOW_DAYS} MX days ending ` +
            `${deliveryEnd === 0 ? "today" : "yesterday"} (${morningSyncDay(now, deliveryEnd)}) ` +
            `(need ≥${GATE_MS_MIN_DELIVERED_DAYS})`,
        );

  // 2. cleanCompletion — measured = the latest `task.completed` carries a
  // `concern_reason` key (json_type sees a present JSON null too), or the task
  // failed (a failed task emits `task.failed`, never `task.completed`, so it
  // would otherwise be unmeasurable by construction; it reaches the population
  // through `schedule_runs` only). A `cancelled` task is an operator cancel:
  // neither measured nor a defect, only counted below (its missing delivery is
  // scored by check 1).
  const outcomes = db
    .prepare(
      `SELECT r.value AS task_id, t.status AS status,
              (SELECT json_type(e.attrs,'$.concern_reason') FROM task_trace_events e
                WHERE e.task_id = r.value AND e.name = 'task.completed'
                ORDER BY e.id DESC LIMIT 1) AS cr_type,
              (SELECT json_extract(e.attrs,'$.concern_reason') FROM task_trace_events e
                WHERE e.task_id = r.value AND e.name = 'task.completed'
                ORDER BY e.id DESC LIMIT 1) AS cr
         FROM json_each(?) r LEFT JOIN tasks t ON t.task_id = r.value`,
    )
    .all(runsJson) as {
    task_id: string;
    status: string | null;
    cr_type: string | null;
    cr: string | null;
  }[];
  const measured = outcomes.filter(
    (o) => o.cr_type !== null || o.status === "failed",
  );
  const hardReasons: readonly string[] = GATE_MS_HARD_DEFECT_REASONS;
  const hardDefects = measured.filter(
    (o) =>
      o.status === "failed" || (o.cr !== null && hardReasons.includes(o.cr)),
  ).length;
  const withConcerns = outcomes.filter(
    (o) => o.status === "completed_with_concerns",
  ).length;
  const cancelled = outcomes.filter((o) => o.status === "cancelled").length;
  const perReason = new Map<string, number>();
  for (const o of measured)
    if (o.cr !== null) perReason.set(o.cr, (perReason.get(o.cr) ?? 0) + 1);
  const reasonText =
    perReason.size === 0
      ? "none"
      : [...perReason].map(([k, v]) => `${k}=${v}`).join(", ");
  const cleanCompletion = scored(
    measured.length < GATE_MS_MIN_RUNS
      ? "insufficient_data"
      : hardDefects <= GATE_MS_MAX_HARD_DEFECTS
        ? "pass"
        : "fail",
    `${hardDefects} hard defect(s) over ${measured.length}/${runs.length} measured run(s) ` +
      `(need ≥${GATE_MS_MIN_RUNS} measured, ≤${GATE_MS_MAX_HARD_DEFECTS} defects); ` +
      `unscored: ${withConcerns} completed_with_concerns, ${cancelled} cancelled, reasons: ${reasonText}`,
  );

  // Checks 3 and 5 score only runs that COMPLETED. A failed, cancelled or lost
  // run (or one with no task row) has no audit event and a partial ledger: it
  // is excluded and counted, never scored as ungrounded or cheap (audit R2-WA).
  const completedRuns = outcomes
    .filter(
      (o) => o.status === "completed" || o.status === "completed_with_concerns",
    )
    .map((o) => o.task_id);
  const completedJson = JSON.stringify(completedRuns);
  const notCompleted = runs.length - completedRuns.length;

  // 3. grounding — the latest `numbers.audited` has unverified = 0 AND
  // evidence_chunks ≥ 1. No event ⇒ not grounded.
  const groundedRuns = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM json_each(?) r
          WHERE (SELECT json_extract(e.attrs,'$.unverified') = 0
                    AND json_extract(e.attrs,'$.evidence_chunks') >= 1
                   FROM task_trace_events e
                  WHERE e.task_id = r.value AND e.name = 'numbers.audited'
                  ORDER BY e.id DESC LIMIT 1) = 1`,
      )
      .get(completedJson) as { n: number }
  ).n;
  const ungrounded = completedRuns.length - groundedRuns;
  const grounding = scored(
    completedRuns.length < GATE_MS_MIN_RUNS
      ? "insufficient_data"
      : ungrounded <= GATE_MS_MAX_UNGROUNDED
        ? "pass"
        : "fail",
    `${ungrounded} of ${completedRuns.length} completed run(s) not grounded, ` +
      `${notCompleted} not completed, excluded ` +
      `(need ≥${GATE_MS_MIN_RUNS} completed runs, ≤${GATE_MS_MAX_UNGROUNDED} ungrounded)`,
  );

  // 4. operatorVerdict — latest `feedback.explicit` per run, 30-day window.
  const verdictRuns = runIds(GATE_MS_VERDICT_WINDOW_DAYS);
  const signals = db
    .prepare(
      `SELECT (SELECT json_extract(e.attrs,'$.signal') FROM task_trace_events e
                WHERE e.task_id = r.value AND e.name = 'feedback.explicit'
                ORDER BY e.id DESC LIMIT 1) AS signal
         FROM json_each(?) r`,
    )
    .all(JSON.stringify(verdictRuns)) as { signal: string | null }[];
  const positive = signals.filter((s) => s.signal === "positive").length;
  const negative = signals.filter((s) => s.signal === "negative").length;
  const rated = positive + negative;
  const operatorVerdict = scored(
    rated < GATE_MS_MIN_RATED
      ? "insufficient_data"
      : positive / rated >= GATE_MS_MIN_POSITIVE_SHARE
        ? "pass"
        : "fail",
    `${positive} positive, ${negative} negative, ${rated} rated, ` +
      `${verdictRuns.length - rated} unrated run(s) in ${GATE_MS_VERDICT_WINDOW_DAYS}d ` +
      `(need ≥${GATE_MS_MIN_RATED} rated, ≥${GATE_MS_MIN_POSITIVE_SHARE * 100}% positive)`,
  );

  // 5. costPerRun — median of per-run SUM(cost_ledger.cost_usd), completed
  // runs only.
  const costs = (
    db
      .prepare(
        `SELECT SUM(c.cost_usd) AS usd FROM cost_ledger c
          WHERE c.task_id IN (SELECT value FROM json_each(?))
          GROUP BY c.task_id`,
      )
      .all(completedJson) as { usd: number }[]
  ).map((r) => r.usd);
  const med = costs.length > 0 ? median(costs) : null;
  const costPerRun = scored(
    costs.length < GATE_MS_MIN_RUNS || med === null
      ? "insufficient_data"
      : med <= GATE_MS_MAX_MEDIAN_COST_USD
        ? "pass"
        : "fail",
    `median $${med === null ? "n/a" : med.toFixed(4)} over ${costs.length} completed run(s) with ledger rows, ` +
      `${notCompleted} not completed, excluded ` +
      `(need ≥${GATE_MS_MIN_RUNS}, ≤$${GATE_MS_MAX_MEDIAN_COST_USD})`,
  );

  // Unscored — first-turn cache-read share. `round` starts at 1 in live rows;
  // the first turn is the lowest round. Share = cache_read / tokens_in, the
  // same convention as the legacy ratio (cache_read / prompt_tokens).
  const first = db
    .prepare(
      `SELECT COUNT(*) AS n,
              SUM(json_extract(f.attrs,'$.cache_read_tokens')) AS cr,
              SUM(json_extract(f.attrs,'$.cache_creation_tokens')) AS cc,
              SUM(f.tokens_in) AS tin
         FROM json_each(?) r
         JOIN task_trace_events f ON f.id = (
              SELECT e.id FROM task_trace_events e
               WHERE e.task_id = r.value AND e.name = 'turn.completed'
               ORDER BY e.round ASC, e.id ASC LIMIT 1)
        WHERE json_type(f.attrs,'$.cache_read_tokens') IS NOT NULL`,
    )
    .get(runsJson) as {
    n: number;
    cr: number | null;
    cc: number | null;
    tin: number | null;
  };

  return {
    checks: {
      delivery,
      cleanCompletion,
      grounding,
      operatorVerdict,
      costPerRun,
    },
    morningSync: {
      runs: runs.length,
      firstTurn: {
        runsWithAttrs: first.n,
        cacheReadPct:
          first.n > 0 && first.tin
            ? round1((100 * (first.cr ?? 0)) / first.tin)
            : null,
        cacheCreationTokens: first.cc ?? 0,
      },
    },
  };
}
