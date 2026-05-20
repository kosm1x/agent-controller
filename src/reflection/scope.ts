/**
 * Reflection scope — the bounded diff (V8.1 Phase 4, spec §7).
 *
 * The reflector never sees "all memory". `buildReflectionScope` reads a
 * cursor (`src/reflection/cursors.ts`), pulls the bounded set of tasks after
 * it, and returns the §7 input contract:
 *
 *   { priorStateSnapshot, deltaEvents, lastProcessedEventId }
 *
 * The runner puts this in the reflection prompt and, on a successful pass,
 * advances the cursor to `lastProcessedEventId`.
 *
 * RECONCILIATION vs spec §7 (Phase 4 scope — designed to ground truth):
 *   - `deltaEvents` is task-anchored only. Spec §7's "+ conversations /
 *     cost_ledger / general_events / recall_audit" enrichment is detection
 *     input — Phase 5 enriches the delta; Phase 4 ships the task skeleton.
 *   - cron-morning's "Last 24h OR since cursor" is implemented as "since
 *     cursor, row-capped". `id > cursor` already IS "since cursor"; the cap
 *     replaces the unbounded read the literal OR would cause when the cursor
 *     sits at 0 (a fresh cursor would otherwise pull the entire task table).
 *   - idle-detect's "Last 4h" is a TRIGGER gate (Phase 7), not a scope
 *     filter. Phase 4's idle-detect scope is the stalled-task subset itself.
 */

import { getDatabase } from "../db/index.js";
import { readCursor, type ReflectionCursorName } from "./cursors.js";

/** The three reflection triggers (spec §6). */
export type ReflectionTrigger = "n-turn" | "cron-morning" | "idle-detect";

/** A single task record in the bounded diff. */
export interface ReflectionDeltaEvent {
  /** `tasks.id` — the cursor anchor. */
  eventId: number;
  /** `tasks.task_id` — the TEXT uuid. */
  taskId: string;
  title: string;
  status: string;
  agentType: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

/** Snapshot of state as of the cursor — the floor of the bounded diff. */
export interface ReflectionPriorState {
  /** The cursor's `last_event_id` when the scope was built. */
  asOfEventId: number;
  /** The cursor's `updated_at`, or null if the cursor was never advanced. */
  asOfTimestamp: string | null;
}

/** The §7 reflection input contract. */
export interface ReflectionScope {
  cursorName: ReflectionCursorName;
  trigger: ReflectionTrigger;
  priorStateSnapshot: ReflectionPriorState;
  deltaEvents: ReflectionDeltaEvent[];
  /**
   * The `tasks.id` the cursor should advance to after a successful pass —
   * the max `eventId` in `deltaEvents`, or the cursor's current position
   * when the delta is empty (an empty pass must not move the cursor).
   */
  lastProcessedEventId: number;
}

// --- Bounds (every per-trigger query is capped — no unbounded reads) -------

/** N-turn reflects on the last 5 tasks (spec §6 Trigger 1, `reflection_freq=5`). */
const N_TURN_LIMIT = 5;
/** cron-morning row cap — the safety bound replacing the unbounded "OR" (see header). */
const CRON_TASK_CAP = 200;
/** idle-detect stalled-subset cap. */
const IDLE_STALLED_CAP = 50;
/** A task is "stalled" once it has been `running` and untouched this long (spec §4/§8). */
const STALLED_DAYS = 7;

interface TaskRow {
  id: number;
  task_id: string;
  title: string;
  status: string;
  agent_type: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

const rowToDelta = (r: TaskRow): ReflectionDeltaEvent => ({
  eventId: r.id,
  taskId: r.task_id,
  title: r.title,
  status: r.status,
  agentType: r.agent_type,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  completedAt: r.completed_at,
});

const TASK_COLS =
  "id, task_id, title, status, agent_type, created_at, updated_at, completed_at";

/**
 * Build the bounded-diff scope for a reflection pass.
 *
 * @param cursorName - which cursor bounds the read (its `last_event_id` is
 *   the floor — only `tasks.id` strictly greater is in the delta).
 * @param trigger - selects the windowing/cap per spec §7's scope table.
 */
export function buildReflectionScope(
  cursorName: ReflectionCursorName,
  trigger: ReflectionTrigger,
): ReflectionScope {
  const cursor = readCursor(cursorName);
  const db = getDatabase();
  const floor = cursor.lastEventId;

  let rows: TaskRow[];
  if (trigger === "n-turn") {
    // The last N tasks after the cursor — newest first, then re-ordered asc.
    rows = (
      db
        .prepare(
          `SELECT ${TASK_COLS} FROM tasks
            WHERE id > ? ORDER BY id DESC LIMIT ?`,
        )
        .all(floor, N_TURN_LIMIT) as TaskRow[]
    ).reverse();
  } else if (trigger === "cron-morning") {
    // Everything since the cursor, row-capped. Capped DESC then re-asc so an
    // overflowing backlog keeps the most RECENT tasks, not the oldest.
    rows = (
      db
        .prepare(
          `SELECT ${TASK_COLS} FROM tasks
            WHERE id > ? ORDER BY id DESC LIMIT ?`,
        )
        .all(floor, CRON_TASK_CAP) as TaskRow[]
    ).reverse();
  } else {
    // idle-detect: the stalled-task subset (running + untouched > STALLED_DAYS),
    // still bounded by the cursor floor and a cap.
    // PHASE 5 NOTE (audit R2): the `id > floor` bound means a task that
    // stalls BELOW the cursor is never surfaced. Staleness is a time
    // property, not an insertion-order one — Phase 5 should decide whether
    // idle-detect is cursor-bounded at all, or windowed purely by time.
    rows = (
      db
        .prepare(
          `SELECT ${TASK_COLS} FROM tasks
            WHERE id > ?
              AND status = 'running'
              AND updated_at < datetime('now', ?)
            ORDER BY id DESC LIMIT ?`,
        )
        .all(floor, `-${STALLED_DAYS} days`, IDLE_STALLED_CAP) as TaskRow[]
    ).reverse();
  }

  const deltaEvents = rows.map(rowToDelta);
  // `deltaEvents` is sorted ascending by eventId (every branch builds it
  // DESC-then-`.reverse()`), so the last element is the max — O(1), no
  // spread. Empty delta → cursor must not move (lastProcessedEventId === floor).
  const lastProcessedEventId =
    deltaEvents.length > 0 ? deltaEvents.at(-1)!.eventId : floor;

  return {
    cursorName,
    trigger,
    priorStateSnapshot: {
      asOfEventId: cursor.lastEventId,
      asOfTimestamp: cursor.updatedAt,
    },
    deltaEvents,
    lastProcessedEventId,
  };
}
