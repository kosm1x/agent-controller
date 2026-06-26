/**
 * Briefing delivery — V8.1 Phase 8 (spec §12 Phase 8 item 1, §6 Trigger 2).
 *
 * `deliverBriefing` renders a persisted pending briefing into Spanish markdown
 * and sends it to the operator's owner channels (Telegram + WhatsApp +
 * owner-only email) via the messaging router, then stamps `delivered_at` so
 * the promote-on-reply hook (`src/briefing/promote.ts`) can resolve it.
 *
 * GATED: the morning-surface trigger calls `deliverBriefing` only when
 * `V81_BRIEF_DELIVERY_ENABLED=true`. Until Phase 9 activation the flag is off —
 * briefings are generated and persisted (`pending`) but never delivered, so
 * Phase 8 ships zero operator-facing change. Phase 9 flips the flag after a
 * shadow run, per the spec's Phase 8 (build) / Phase 9 (activate) split.
 */

import { getRouter } from "../messaging/index.js";
import { createLogger } from "../lib/logger.js";
import { renderBriefing } from "./render.js";
import { getProposedBriefing, markBriefingDelivered } from "./storage.js";
import { isV82DeliveryEnabled } from "../lib/v8-2/flags.js";
import { getJudgmentsForBriefing } from "../lib/v8-2/judgments-store.js";
import { renderStrategicSection } from "../lib/v8-2/judgment-render.js";

const log = createLogger("briefing:delivery");

/** True when operator-facing briefing delivery is activated (Phase 9 flips it). */
export function isBriefingDeliveryEnabled(): boolean {
  return process.env.V81_BRIEF_DELIVERY_ENABLED === "true";
}

export interface DeliverResult {
  delivered: boolean;
  reason?: "not-found" | "not-pending" | "no-router" | "send-failed";
}

/**
 * Render and deliver one pending briefing to the operator. Only a `pending`
 * briefing is delivered (a promoted/discarded/superseded one is skipped).
 * Never throws — a send failure returns `{ delivered: false }`.
 */
export async function deliverBriefing(
  briefingId: string,
): Promise<DeliverResult> {
  const row = getProposedBriefing(briefingId);
  if (!row) return { delivered: false, reason: "not-found" };
  if (row.status !== "pending") {
    return { delivered: false, reason: "not-pending" };
  }

  const router = getRouter();
  if (!router) {
    log.warn({ briefingId }, "no messaging router — briefing not delivered");
    return { delivered: false, reason: "no-router" };
  }

  // V8.2 delivery (flag-gated, default off): surface the shadow strategic
  // judgments attached to this brief. The §9 drop-vs-surface filter lives in
  // `renderStrategicSection`; a brief with no deliverable judgments yields null,
  // so the operator-facing text is byte-identical to the V8.1-only brief.
  // Wrapped: the `judgments` read is synchronous SQLite and could throw (e.g.
  // SQLITE_BUSY under a concurrent admin write) — a V8.2 hiccup must NEVER sink
  // the V8.1 brief, so any error degrades to V8.1-only (the never-throws
  // contract on this function).
  let strategicSection: string | undefined;
  if (isV82DeliveryEnabled()) {
    try {
      strategicSection =
        renderStrategicSection(getJudgmentsForBriefing(briefingId)) ??
        undefined;
    } catch (err) {
      log.error(
        { err, briefingId },
        "v8.2 strategic section failed — delivering V8.1-only brief",
      );
    }
  }

  const text = renderBriefing(row.briefing, strategicSection);
  let tally: { sent: number; failed: number };
  try {
    tally = await router.sendBriefingToOwner(text);
  } catch (err) {
    log.error({ err, briefingId }, "briefing send threw");
    return { delivered: false, reason: "send-failed" };
  }

  // `sendBriefingToOwner` error-isolates each channel and never rejects, so a
  // total failure surfaces as `sent === 0` — NOT a throw. delivered_at must
  // reflect a send that actually reached a channel (the promote-on-reply hook
  // gates on it), so a zero-reach delivery is a failure (audit W3).
  if (tally.sent === 0) {
    log.error(
      { briefingId, failed: tally.failed },
      "briefing reached no channel — not marking delivered",
    );
    return { delivered: false, reason: "send-failed" };
  }

  // Stamp delivered_at LAST — only now that at least one channel succeeded.
  markBriefingDelivered(briefingId);
  log.info(
    { briefingId, sent: tally.sent, failed: tally.failed },
    "briefing delivered to operator",
  );
  return { delivered: true };
}
