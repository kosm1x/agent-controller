/**
 * Recurring-blocker detector — V8.1 Phase 5, spec §8.
 *
 * The capability AutoGen explicitly does not ship (microsoft/autogen#7487):
 * the same failure recurring across distinct task runs. Clusters failed
 * tasks by an error signature; a cluster spanning ≥3 distinct tasks is
 * surfaced and recorded in `recurring_blockers`.
 *
 * RECONCILIATION vs spec §8:
 *   - No `task_errors` table — clusters over the existing `tasks.error`
 *     column (failed tasks already record it). §12 item 2 conditionalises
 *     `task_errors`; this avoids a detector that needs hot-path ingest
 *     wiring to ever see data.
 *   - `blocker_signature` is `sha256(normalized error text)`. The spec's
 *     `error_class +` prefix is dropped — `tasks` has no error-class column,
 *     and a coarse class only matters once the §14-Q3 semantic layer exists.
 *   - Clustering is EXACT on the normalized text (lowercase + whitespace-
 *     collapsed). Semantic/embedding equivalence is §14 Q3 — deferred; the
 *     `signature_embedding` column is left for it.
 *   - Resolution lifecycle (`resolved_at`) is not driven here — the pass
 *     records currently-active clusters; marking a vanished blocker resolved
 *     is a follow-up.
 *   - Spec §8's `idx_rb_signature` index is intentionally not created — the
 *     `blocker_signature TEXT NOT NULL UNIQUE` constraint already builds the
 *     index the `ON CONFLICT` lookup needs; a second one would be redundant.
 */

import { createHash } from "node:crypto";
import { getDatabase, writeWithRetry } from "../db/index.js";
import type { RecurringBlockerSignal } from "./signals.js";

const WINDOW_DAYS = 14;
/** A cluster is "recurring" once this many DISTINCT tasks share a signature. */
const MIN_TASKS = 3;
/** Defensive cap on the failed-task scan. */
const MAX_FAILED_TASKS = 2000;
/**
 * A cluster with no new failure in this many days is auto-resolved and
 * stops surfacing. Longer than the longest nanoclaw daily-cron interval
 * (so a daily failure doesn't keep flipping), short enough that a fixed
 * blocker drops off the briefing within ~one session.
 * 2026-05-24: introduced after the morning ritual confidently recommended
 * a docker rebuild for clusters whose last failure was 1–10 days old and
 * whose fixes had already shipped (`d9f4d15` / `6020c61`).
 */
const STALE_AFTER_DAYS = 3;

/** Lowercase + whitespace-collapse — the spec §8 `error_text_normalized`. */
function normalizeError(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** `sha256` hex of the normalized error text — the cluster key. */
function signatureOf(errorText: string): string {
  return createHash("sha256").update(normalizeError(errorText)).digest("hex");
}

interface FailedRow {
  task_id: string;
  error: string;
  updated_at: string;
}

interface Cluster {
  signature: string;
  sampleText: string;
  /** A Set so a repeated task_id cannot inflate the count (O(1) dedup). */
  taskIds: Set<string>;
  firstSeen: string;
  lastSeen: string;
}

export interface DetectRecurringBlockersOptions {
  windowDays?: number;
  minTasks?: number;
}

/**
 * Detect recurring blockers (spec §8). Clusters failed tasks in the window,
 * upserts every ≥`minTasks` cluster into `recurring_blockers`, and returns a
 * signal per surfaced cluster.
 */
export function detectRecurringBlockers(
  opts: DetectRecurringBlockersOptions = {},
): RecurringBlockerSignal[] {
  const windowDays = opts.windowDays ?? WINDOW_DAYS;
  const minTasks = opts.minTasks ?? MIN_TASKS;
  const db = getDatabase();

  const rows = db
    .prepare(
      `SELECT task_id, error, updated_at FROM tasks
        WHERE status = 'failed' AND error IS NOT NULL AND error != ''
          AND updated_at >= datetime('now', ?)
        ORDER BY updated_at ASC LIMIT ?`,
    )
    .all(`-${windowDays} days`, MAX_FAILED_TASKS) as FailedRow[];

  // Cluster by signature. `updated_at ASC` ordering means the first row of a
  // cluster is its earliest occurrence and the last is its most recent.
  const clusters = new Map<string, Cluster>();
  for (const r of rows) {
    const signature = signatureOf(r.error);
    const existing = clusters.get(signature);
    if (existing) {
      // Distinct tasks only — the Set drops a repeated task_id.
      existing.taskIds.add(r.task_id);
      existing.lastSeen = r.updated_at;
    } else {
      clusters.set(signature, {
        signature,
        sampleText: r.error,
        taskIds: new Set([r.task_id]),
        firstSeen: r.updated_at,
        lastSeen: r.updated_at,
      });
    }
  }

  const meetingMinTasks = [...clusters.values()].filter(
    (c) => c.taskIds.size >= minTasks,
  );

  writeWithRetry(() => {
    const upsert = db.prepare(
      `INSERT INTO recurring_blockers
         (blocker_signature, first_seen_at, last_seen_at, task_count, task_ids_json)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(blocker_signature) DO UPDATE SET
         last_seen_at      = excluded.last_seen_at,
         task_count        = excluded.task_count,
         task_ids_json     = excluded.task_ids_json,
         resolved_at       = NULL,
         resolution_signal = NULL`,
    );
    // Auto-resolve any cluster whose newest failure is older than the
    // staleness window. Hits (1) clusters re-upserted this run with stale
    // lastSeen, (2) prior rows that received no new failure (their
    // last_seen_at sticks at the old value), and re-resolves a previously-
    // resolved cluster whose new last_seen_at is STILL stale — the upsert
    // above unconditionally clears resolved_at so a genuine recurrence
    // re-surfaces (audit C1).
    const autoResolve = db.prepare(
      `UPDATE recurring_blockers
          SET resolved_at = datetime('now'),
              resolution_signal = 'auto-stale'
        WHERE resolved_at IS NULL
          AND last_seen_at < datetime('now', ?)`,
    );
    const tx = db.transaction((cs: Cluster[]) => {
      for (const c of cs) {
        upsert.run(
          c.signature,
          c.firstSeen,
          c.lastSeen,
          c.taskIds.size,
          JSON.stringify([...c.taskIds]),
        );
      }
      autoResolve.run(`-${STALE_AFTER_DAYS} days`);
    });
    tx(meetingMinTasks);
  });

  // Read first_seen_at + resolved_at back from the rows. first_seen_at: on
  // an upsert CONFLICT the column is intentionally NOT updated, so a
  // blocker first seen before this window keeps its true age — the in-window
  // `c.firstSeen` would understate it (audit W3). resolved_at: the just-run
  // auto-resolve UPDATE may have flipped this cluster to resolved; we filter
  // those out of the surface so the briefing doesn't recommend fixes for
  // blockers that have already gone quiet.
  const persistedRow = db.prepare(
    "SELECT first_seen_at, resolved_at FROM recurring_blockers WHERE blocker_signature = ?",
  );
  const surfaced: Array<{ cluster: Cluster; trueFirstSeen: string }> = [];
  for (const c of meetingMinTasks) {
    const row = persistedRow.get(c.signature) as
      | { first_seen_at: string; resolved_at: string | null }
      | undefined;
    if (!row) continue;
    if (row.resolved_at !== null) continue;
    surfaced.push({ cluster: c, trueFirstSeen: row.first_seen_at });
  }

  return surfaced.map(({ cluster: c, trueFirstSeen }) => {
    const taskIds = [...c.taskIds];
    const daysAgo = daysSince(c.lastSeen);
    const recency =
      daysAgo === 0 ? "today" : daysAgo === 1 ? "1d ago" : `${daysAgo}d ago`;
    return {
      kind: "recurring_blocker",
      severity: "at_risk",
      summary:
        `Blocker recurred across ${taskIds.length} tasks (last seen ${recency}): ` +
        `"${c.sampleText.slice(0, 80).replace(/\s+/g, " ").trim()}"`,
      blockerSignature: c.signature,
      taskCount: taskIds.length,
      taskIds,
      firstSeenAt: trueFirstSeen,
      lastSeenAt: c.lastSeen,
    };
  });
}

/** Whole days between a UTC timestamp string and now. Accepts both the SQLite
 * `datetime('now')` format ("YYYY-MM-DD HH:MM:SS", naive UTC) and an ISO 8601
 * string ending in "Z". Returns 0 for unparseable inputs (better to under-
 * report staleness than to mis-parse and silently lie). */
function daysSince(ts: string): number {
  const normalized = /Z$/i.test(ts) ? ts : ts.replace(" ", "T") + "Z";
  const ms = Date.parse(normalized);
  if (Number.isNaN(ms)) return 0;
  return Math.max(0, Math.floor((Date.now() - ms) / 86_400_000));
}
