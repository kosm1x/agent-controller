/**
 * §17 no-verdict reminder — V8.5 Phase 4.6.
 *
 * Verdict capture is live (explicit whole-message `sirve`/`descarta`,
 * promote.ts) but the §17 acceptance gate only accrues when the operator
 * actually rules on the 06:00 brief — an unanswered brief expires silently at
 * 24h and the gate's ruled-only denominator never grows. This sends ONE
 * evening reminder for a delivered brief that is still `pending`, referencing
 * the brief and the exact reply vocabulary. Directly unblocks the
 * §17 → §14 → L2 arming chain.
 *
 * Mechanical (no LLM). Scheduled from the ritual scheduler at 20:00 MX —
 * ~14h after morning delivery, ~10h before the brief expires.
 *
 * Send-once guard: `safeguard_state['no_verdict_reminder_last_briefing_id']`
 * stores the briefing_id of the last brief we reminded about. A brief lives
 * <24h so the daily cron crosses it at most once anyway; the persisted guard
 * makes "ONE reminder per brief" hold structurally across restarts and manual
 * invocations rather than by cron-cadence luck. Recorded only after ≥1 channel
 * delivery — a zero-delivery attempt does not consume the brief's one shot
 * (same "zero delivery ≠ committed" stance as notifyRitualFailure).
 */

import { getDatabase, writeWithRetry } from "../db/index.js";
import { getRouter } from "../messaging/index.js";
import { getResolvablePendingBriefing } from "./storage.js";

const GUARD_KEY = "no_verdict_reminder_last_briefing_id";

export interface NoVerdictReminderResult {
  sent: boolean;
  reason:
    | "sent"
    | "no_pending_brief"
    | "expired"
    | "already_reminded"
    | "zero_delivery";
  briefingId?: string;
}

export interface NoVerdictReminderDeps {
  /** Delivers the reminder to the operator; returns the per-channel tally.
   *  Defaults to router.sendBriefingToOwner (owner Telegram / WhatsApp). */
  send?: (text: string) => Promise<{ sent: number; failed: number }>;
  /** Current-time source (injected in tests for the expiry check). */
  now?: () => Date;
}

function getLastRemindedBriefingId(): string | null {
  try {
    const row = getDatabase()
      .prepare("SELECT value FROM safeguard_state WHERE key = ?")
      .get(GUARD_KEY) as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    // safeguard_state missing (fresh DB before initDatabase's ensure) — treat
    // as never-reminded; the write below will surface a real problem loudly.
    return null;
  }
}

function recordRemindedBriefingId(briefingId: string): void {
  writeWithRetry(() => {
    getDatabase()
      .prepare(
        `INSERT INTO safeguard_state (key, value, updated_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(GUARD_KEY, briefingId);
  });
}

/**
 * Reminder text. Spanish (operator-facing product content) and deliberately
 * verbatim on the reply vocabulary — promote.ts only resolves on a
 * whole-message `sirve` / `descarta`, so the reminder must hand the operator
 * the exact words, not a paraphrase (classifier-needs-named-action).
 */
function composeReminder(surface: string, deliveredAt: string | null): string {
  const surfaceLabel = surface === "morning" ? "brief de las 06:00" : surface;
  // delivered_at comes from SQLite datetime('now') — already "YYYY-MM-DD HH:MM".
  const delivered = deliveredAt ? deliveredAt.slice(0, 16) : "hoy";
  return (
    `📋 Recordatorio: el ${surfaceLabel} (entregado ${delivered} UTC) sigue sin veredicto.\n` +
    `Responde "sirve" o "descarta" antes de que expire mañana a las 06:00 — ` +
    `cada veredicto acumula para la activación §17.`
  );
}

/**
 * Send at most one reminder for the currently resolvable pending brief.
 * Never throws for expected states (no brief, already reminded); DB or
 * delivery-layer throws propagate to the caller for recordRitualFailure.
 */
export async function runNoVerdictReminder(
  deps: NoVerdictReminderDeps = {},
): Promise<NoVerdictReminderResult> {
  const brief = getResolvablePendingBriefing();
  if (!brief) return { sent: false, reason: "no_pending_brief" };

  // getResolvablePendingBriefing doesn't filter expiry (promote.ts expires
  // lazily) — an already-expired brief can't be usefully ruled on.
  const now = deps.now?.() ?? new Date();
  if (new Date(brief.expiresAt).getTime() <= now.getTime()) {
    return { sent: false, reason: "expired", briefingId: brief.briefingId };
  }

  if (getLastRemindedBriefingId() === brief.briefingId) {
    return {
      sent: false,
      reason: "already_reminded",
      briefingId: brief.briefingId,
    };
  }

  const send =
    deps.send ??
    (async (text: string) => {
      const router = getRouter();
      if (!router) return { sent: 0, failed: 0 };
      return router.sendBriefingToOwner(text);
    });

  const { sent } = await send(
    composeReminder(brief.surface, brief.deliveredAt),
  );
  if (sent === 0) {
    console.error(
      `[briefing] no-verdict reminder reached zero operator channels (${brief.briefingId}) — check WHATSAPP_OWNER_JID / TELEGRAM_OWNER_CHAT_ID`,
    );
    return {
      sent: false,
      reason: "zero_delivery",
      briefingId: brief.briefingId,
    };
  }

  recordRemindedBriefingId(brief.briefingId);
  return { sent: true, reason: "sent", briefingId: brief.briefingId };
}
