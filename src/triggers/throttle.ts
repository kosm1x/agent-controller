/**
 * Trigger throttle + cadence state — V8.1 Phase 7 (spec §6, §14 Q4).
 *
 * `trigger_runs` is the restart-safe ledger every Phase 7 trigger writes to.
 * Two invariants read it back:
 *   - per-surface throttling — idle-detect fires at most once per 12h (§6);
 *   - the §14-Q4 cost ceiling — at most 10 reflection runs per rolling 24h
 *     across n-turn + idle-detect, so a high-activity day cannot run
 *     unbounded inference.
 *
 * The N-turn *counter* itself is in-memory (`src/triggers/n-turn.ts`) — an
 * approximate cadence where a restart losing ≤ N-1 counts is harmless. The
 * cost ceiling is the load-bearing invariant, so it lives in the DB.
 *
 * Both the throttle and the ceiling count only `outcome='fired'` rows — a
 * 'skipped' / 'failed' row is pure observability and never gates a future
 * fire (otherwise an exhausted budget would self-perpetuate). NOTE: a
 * `cron_morning` row uses `outcome='fired'` purely for observability — it is
 * excluded from BOTH the reflection ceiling (`reflectionRunsInLast24h` filters
 * to n_turn/idle_detect) and from any throttle. Only n-turn and idle-detect
 * `fired` rows gate a future fire.
 *
 * Windows are ROLLING (`datetime('now','-24 hours')`, `'-12 hours'`), not
 * per-calendar-day — intentionally stricter than the §14-Q4 worked example,
 * which reasons in runs/day. A burst that hits the ceiling at 23:00 stays
 * capped until 23:00 the next day; that is the intended hard bound.
 *
 * All time math is done in SQLite (`datetime('now', ?)`), which is UTC, so
 * there is no JS `Date`-parsing timezone trap on `fired_at`.
 */

import { getDatabase, writeWithRetry } from "../db/index.js";

/** The three Phase 7 trigger kinds. Mirrors the `trigger_runs` CHECK. */
export type TriggerKind = "n_turn" | "cron_morning" | "idle_detect";

/** §14 Q4 — hard ceiling on reflection runs per rolling 24h. */
export const MAX_REFLECTION_RUNS_PER_DAY = 10;

/**
 * Append a `trigger_runs` row.
 *
 * @param outcome - 'fired' for a real run; 'skipped' / 'failed' for
 *   observability only. An n_turn/idle_detect `fired` row counts toward the
 *   §14-Q4 ceiling and (idle_detect) the 12h throttle; a `cron_morning`
 *   `fired` row counts toward neither — it is observability only.
 */
export function recordTriggerRun(
  kind: TriggerKind,
  outcome: "fired" | "skipped" | "failed",
  detail?: string,
): void {
  writeWithRetry(() => {
    getDatabase()
      .prepare(
        `INSERT INTO trigger_runs (trigger_kind, outcome, detail)
         VALUES (?, ?, ?)`,
      )
      .run(kind, outcome, detail ?? null);
  });
}

/**
 * True when `kind` has a `fired` row inside `sqlInterval` (a SQLite modifier
 * such as `'-12 hours'`). Used for the idle-detect 12h throttle.
 */
export function isThrottled(kind: TriggerKind, sqlInterval: string): boolean {
  const row = getDatabase()
    .prepare(
      `SELECT 1 FROM trigger_runs
        WHERE trigger_kind = ?
          AND outcome = 'fired'
          AND fired_at > datetime('now', ?)
        LIMIT 1`,
    )
    .get(kind, sqlInterval);
  return row !== undefined;
}

/** Count of reflection runs (n-turn + idle-detect) actually fired in 24h. */
export function reflectionRunsInLast24h(): number {
  const row = getDatabase()
    .prepare(
      `SELECT COUNT(*) AS c FROM trigger_runs
        WHERE trigger_kind IN ('n_turn', 'idle_detect')
          AND outcome = 'fired'
          AND fired_at > datetime('now', '-24 hours')`,
    )
    .get() as { c: number };
  return row.c;
}

/** True while the rolling-24h reflection budget (§14 Q4) still has headroom. */
export function reflectionBudgetAvailable(): boolean {
  return reflectionRunsInLast24h() < MAX_REFLECTION_RUNS_PER_DAY;
}
