/**
 * Ritual failure recorder.
 *
 * Leaf on purpose: importable from any scheduled job without pulling the
 * scheduler. Imports only the event bus and the error-message helper.
 */

import { getEventBus } from "../lib/event-bus.js";
import { errMsg } from "../lib/err-msg.js";

/**
 * Dim-4 R5 fix: record a ritual failure as a persistent event.
 *
 * Static rituals (morning-briefing, market-*, nightly-close, kb-backup,
 * memory-consolidation, diff-digest, stale-artifact-prune) previously logged
 * failures to console only — full-system-audit success criterion requires an
 * events row with category=schedule + type=failed so health queries,
 * monitoring, and reaction rules can catch systemic ritual outages.
 *
 * Always best-effort: if the bus isn't initialized yet (e.g. during boot
 * before initEventBus ran), we swallow the throw rather than mask the real
 * failure. console.error still fires at the caller for tail-the-log diagnosis.
 */
export function recordRitualFailure(
  ritualId: string,
  err: unknown,
  phase: "submit" | "execute",
): void {
  const message = errMsg(err);
  try {
    getEventBus().emitEvent("schedule.run_failed", {
      ritual_id: ritualId,
      error: message.slice(0, 1000),
      phase,
    });
  } catch (busErr) {
    // Dim-4 round-2 C-RES-5/M-RES-6 fix: the prior bare `catch {}` silently
    // swallowed EVERY throw — event-bus-not-initialized AND any programming
    // bug in the emit path (type mismatch after payload shape change,
    // SQLITE_MISUSE on a closed DB during shutdown, etc.). That turned the
    // enforcement gate into theater. Narrow swallow: still non-fatal, but
    // passthrough to console so the break is observable in journalctl.
    const busMsg = errMsg(busErr);
    console.error(
      `[rituals] recordRitualFailure: event bus unavailable (${busMsg}) — original error: ${message}`,
    );
  }
}
