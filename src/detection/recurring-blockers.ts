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

  const surfaced = [...clusters.values()].filter(
    (c) => c.taskIds.size >= minTasks,
  );

  writeWithRetry(() => {
    const upsert = db.prepare(
      `INSERT INTO recurring_blockers
         (blocker_signature, first_seen_at, last_seen_at, task_count, task_ids_json)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(blocker_signature) DO UPDATE SET
         last_seen_at  = excluded.last_seen_at,
         task_count    = excluded.task_count,
         task_ids_json = excluded.task_ids_json`,
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
    });
    tx(surfaced);
  });

  // Read first_seen_at back from the rows: on an upsert CONFLICT the column
  // is intentionally NOT updated, so a blocker first seen before this
  // window keeps its true age — the in-window `c.firstSeen` would understate
  // it (audit W3).
  const trueFirstSeen = new Map<string, string>();
  for (const c of surfaced) {
    const row = db
      .prepare(
        "SELECT first_seen_at FROM recurring_blockers WHERE blocker_signature = ?",
      )
      .get(c.signature) as { first_seen_at: string } | undefined;
    if (row) trueFirstSeen.set(c.signature, row.first_seen_at);
  }

  return surfaced.map((c) => {
    const taskIds = [...c.taskIds];
    return {
      kind: "recurring_blocker",
      severity: "at_risk",
      summary:
        `Blocker recurred across ${taskIds.length} tasks: ` +
        `"${c.sampleText.slice(0, 80).replace(/\s+/g, " ").trim()}"`,
      blockerSignature: c.signature,
      taskCount: taskIds.length,
      taskIds,
      firstSeenAt: trueFirstSeen.get(c.signature) ?? c.firstSeen,
    };
  });
}
