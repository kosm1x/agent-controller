/**
 * Alert delivery — formats and sends pending alerts via Telegram.
 *
 * FLASH + PRIORITY → immediate Telegram broadcast.
 * ROUTINE → stored only (consumed by morning briefing digest).
 */

import {
  getUndeliveredAlerts,
  markDelivered,
  type AlertTier,
} from "./alert-router.js";

/**
 * Deliver pending FLASH and PRIORITY alerts via the provided broadcast function.
 * Returns the number of alerts delivered.
 */
export async function deliverPendingAlerts(
  broadcastFn: (text: string) => Promise<void>,
): Promise<number> {
  const tiers: AlertTier[] = ["FLASH", "PRIORITY"];
  let delivered = 0;

  for (const tier of tiers) {
    const alerts = getUndeliveredAlerts(tier);
    if (alerts.length === 0) continue;

    // Batch alerts of same tier into one message
    const lines: string[] = [];
    const tierLabel = tier === "FLASH" ? "🚨 FLASH" : "⚠️ PRIORITY";
    lines.push(`<b>${tierLabel} — Intel Depot</b>\n`);

    for (const alert of alerts) {
      lines.push(`${alert.title}`);
      if (alert.body) {
        lines.push(`<i>${truncate(alert.body, 200)}</i>`);
      }
      lines.push("");
    }

    try {
      await broadcastFn(lines.join("\n"));

      // Mark all as delivered
      for (const alert of alerts) {
        markDelivered(alert.id, "telegram");
        delivered++;
      }
    } catch (err) {
      console.warn(
        `[intel-delivery] Failed to deliver ${tier} alerts:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return delivered;
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "..." : text;
}
