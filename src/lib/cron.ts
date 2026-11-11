/**
 * Shared cron scheduling wrapper — node-cron v4 missed-execution hardening.
 *
 * node-cron 4.x SKIPS (never runs) any scheduled fire that the event loop is
 * blocked past `missedExecutionTolerance` for — and the default is 1000ms.
 * This process routinely blocks the loop 2-3s at busy seconds (SDK task
 * spawns, synchronous better-sqlite3 sweeps), which silently killed the
 * 06:00 MX morning-surface trigger and 15+ other slots for three days after
 * the v3→v4 upgrade (2026-07-12..14 incident: the §17 gate lost 3 days of
 * verdict fuel, and a bare "Sirve" with no pending brief fell through to
 * chat as a Phase 2 go-ahead).
 *
 * Every cron in this codebase must schedule through here:
 * - 60s tolerance: all our jobs are minutely-or-coarser, so running late
 *   strictly beats not running; a >60s loop block is a real incident, not
 *   scheduling jitter.
 * - a skip beyond even that window is NEVER silent: console.error +
 *   `schedule.run_failed` (phase "missed") so reaction rules, /health and
 *   the operator alert path see it. (Attaching the listener also suppresses
 *   node-cron's own console-only warn — we replace it, not duplicate it.)
 * - a job function that throws or rejects is recorded the same way (phase
 *   "execute"). A job function returns its promise (`() => job()`), never
 *   `() => void job()`: a detached promise's rejection never reaches node-cron.
 */

import cron, {
  type ScheduledTask,
  type TaskFn,
  type TaskOptions,
} from "node-cron";
import { getEventBus } from "./event-bus.js";
import { errMsg } from "./err-msg.js";

export const MISSED_EXECUTION_TOLERANCE_MS = 60_000;

/**
 * Drop-in replacement for `cron.schedule` with a stable job id (used as the
 * node-cron task name, the missed-execution log tag, and the
 * `schedule.run_failed` ritual_id).
 */
export function scheduleCron(
  id: string,
  expression: string,
  fn: TaskFn,
  options?: TaskOptions,
): ScheduledTask {
  const task = cron.schedule(expression, fn, {
    name: id,
    missedExecutionTolerance: MISSED_EXECUTION_TOLERANCE_MS,
    ...options,
  });
  task.on("execution:missed", (ctx) => {
    const toleranceMs =
      options?.missedExecutionTolerance ?? MISSED_EXECUTION_TOLERANCE_MS;
    const message = `[cron] ${id}: missed execution at ${ctx.dateLocalIso} — skipped (event loop blocked > ${toleranceMs}ms)`;
    console.error(message);
    try {
      getEventBus().emitEvent("schedule.run_failed", {
        ritual_id: id,
        error: message.slice(0, 1000),
        phase: "missed",
      });
    } catch (busErr) {
      // Same narrow swallow as recordRitualFailure: non-fatal, but the break
      // must be observable in journalctl rather than silently discarded.
      console.error(
        `[cron] ${id}: event bus unavailable for missed-execution record (${errMsg(busErr)})`,
      );
    }
  });
  // The job function threw or its returned promise rejected. node-cron logs
  // the bare error without the job id; this line and the event carry the id,
  // so the failure reaches the same alert path as a missed run.
  task.on("execution:failed", (ctx) => {
    try {
      // An error whose message cannot be read still gives the line and event.
      let message: string;
      try {
        message = errMsg(ctx.execution?.error);
      } catch {
        message = "(unreadable error)";
      }
      console.error(`[cron] ${id}: execution failed: ${message.slice(0, 200)}`);
      try {
        getEventBus().emitEvent("schedule.run_failed", {
          ritual_id: id,
          error: message.slice(0, 1000),
          phase: "execute",
        });
      } catch (busErr) {
        console.error(
          `[cron] ${id}: event bus unavailable for failed-execution record (${errMsg(busErr)})`,
        );
      }
    } catch {
      // a recorder must not throw into the scheduler
    }
  });
  return task;
}
