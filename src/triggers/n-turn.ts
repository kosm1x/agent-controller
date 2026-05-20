/**
 * N-turn-piggybacked reflection trigger — V8.1 Phase 7, spec §6 Trigger 1.
 *
 * Subscribes to `task.completed`. After every Nth foreground task completes
 * (`REFLECTION_FREQ`, default 5) it fires a fire-and-forget reflection pass.
 * Reflection cadence therefore tracks operator activity — a busy day yields
 * more passes, an idle day yields none.
 *
 * "Foreground" = a `spawn_type='root'` task. Subtasks do NOT qualify, and
 * reflection's own inference runs via `fastRunner.execute` / `infer()`
 * directly (not the dispatcher), so it never emits `task.completed` and
 * cannot feed this counter recursively.
 *
 * The counter is in-memory and approximate: a deploy restart loses ≤ N-1
 * counts, harmless for a cadence target. The COST ceiling (§14 Q4) is the
 * load-bearing bound and is DB-backed — see `reflectionBudgetAvailable()`.
 *
 * RECONCILIATION vs spec §6: the spec says "fire-and-forget via
 * `safe_create_task`". `runReflection` is already a self-contained async
 * function; calling it directly avoids a dispatcher round-trip AND the
 * recursion risk a reflection *task* would create by emitting its own
 * `task.completed`. The cursor used is `general_events_discovery` — spec §6
 * Trigger 1 is the trigger that "updates general_events (auto-discovery
 * candidates)", and that is the cursor §7 names for exactly that consumer.
 */

import type { Event } from "../lib/events/types.js";
import { getTask } from "../dispatch/dispatcher.js";
import { runReflection } from "../reflection/runner.js";
import { createLogger } from "../lib/logger.js";
import { recordTriggerRun, reflectionBudgetAvailable } from "./throttle.js";

const log = createLogger("triggers:n-turn");

/** Foreground completions per reflection pass (spec §6 `reflection_freq=5`). */
export const REFLECTION_FREQ: number = (() => {
  const raw = Number(process.env.REFLECTION_FREQ);
  return Number.isInteger(raw) && raw > 0 ? raw : 5;
})();

/** In-memory count of foreground completions since the last reflection pass. */
let foregroundCount = 0;

/** Test-only: read the in-memory counter. */
export function getNTurnCounter(): number {
  return foregroundCount;
}

/** Test-only: reset the in-memory counter. */
export function resetNTurnCounter(): void {
  foregroundCount = 0;
}

/**
 * `task.completed` event handler. NEVER throws — the bus delivers to every
 * subscriber in a shared loop, and while a throw here is error-isolated by
 * the bus, we still swallow + log so a malformed task row cannot derail the
 * count for the next event.
 */
export function handleTaskCompleted(event: Event<"task.completed">): void {
  try {
    const task = getTask(event.data.task_id);
    // Foreground only — subtasks and any non-root spawn do not count.
    if (!task || task.spawn_type !== "root") return;

    foregroundCount++;
    if (foregroundCount < REFLECTION_FREQ) return;

    foregroundCount = 0;
    void fireNTurnReflection();
  } catch (err) {
    log.warn({ err }, "n-turn handler error (swallowed)");
  }
}

/**
 * Fire one reflection pass, gated by the §14-Q4 rolling-24h cost ceiling.
 *
 * The ceiling is a HARD bound, not best-effort: `reflectionBudgetAvailable()`
 * and the `recordTriggerRun(..., 'fired', ...)` below are sequential
 * SYNCHRONOUS statements (better-sqlite3 is synchronous) with no `await`
 * between them — the first suspension point is `await runReflection`, after
 * the row is already written. Two `task.completed` events therefore cannot
 * both pass the check before either records. Do NOT insert an `await`
 * between the budget check and the row write, or this guarantee breaks.
 */
async function fireNTurnReflection(): Promise<void> {
  if (!reflectionBudgetAvailable()) {
    log.info("n-turn reflection skipped — 24h reflection budget exhausted");
    recordTriggerRun("n_turn", "skipped", "reflection budget exhausted");
    return;
  }

  recordTriggerRun(
    "n_turn",
    "fired",
    `every ${REFLECTION_FREQ} foreground tasks`,
  );
  try {
    const result = await runReflection({
      cursorName: "general_events_discovery",
      trigger: "n-turn",
    });
    log.info(
      {
        ran: result.ran,
        reason: result.reason,
        advancedTo: result.cursorAdvancedTo,
      },
      "n-turn reflection pass complete",
    );
  } catch (err) {
    // runReflection maps its own failures to a typed result; a throw here is
    // unexpected. Swallow so the trigger path cannot crash the event loop.
    log.error({ err }, "n-turn reflection pass threw");
  }
}
