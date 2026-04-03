/**
 * intel_alert_history — Recent Intelligence Depot alerts.
 * Filterable by tier and time range.
 */

import type { Tool } from "../types.js";
import { getRecentAlerts, type AlertTier } from "../../intel/alert-router.js";

export const intelAlertHistoryTool: Tool = {
  name: "intel_alert_history",
  definition: {
    type: "function",
    function: {
      name: "intel_alert_history",
      description: `Get recent Intelligence Depot alerts with tier, delivery status, and content.

USE WHEN:
- User asks "hubo alertas?", "any flash alerts?", "qué alertó el depot?"
- Reviewing overnight or recent alert activity
- Checking if specific tier alerts fired

DO NOT USE WHEN:
- User wants raw signal data (use intel_query)
- User wants to search the web for news (use web_search)

Tiers: FLASH (critical, immediate), PRIORITY (high, same day), ROUTINE (moderate, digest).`,
      parameters: {
        type: "object",
        properties: {
          tier: {
            type: "string",
            description:
              "Filter by tier: FLASH, PRIORITY, ROUTINE. Omit for all.",
            enum: ["FLASH", "PRIORITY", "ROUTINE"],
          },
          hours: {
            type: "number",
            description: "Time range in hours (default: 48, max: 168)",
          },
          limit: {
            type: "number",
            description: "Max alerts to return (default: 10, max: 30)",
          },
        },
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const hours = Math.min(Math.max(Number(args.hours) || 48, 1), 168);
    const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 30);
    const tier = args.tier as AlertTier | undefined;

    const alerts = getRecentAlerts(hours, tier, limit);

    if (alerts.length === 0) {
      return `No ${tier ?? ""} alerts in the last ${hours}h.`;
    }

    const lines: string[] = [
      `🔔 Alert History — ${alerts.length} alerts (last ${hours}h)`,
      "",
    ];

    for (const a of alerts) {
      const delivery = a.delivered_at
        ? `✅ ${a.delivered_via} at ${a.delivered_at}`
        : "⏳ pending";
      lines.push(`[${a.tier}] ${a.title}`);
      lines.push(`  ${a.body.slice(0, 150)}`);
      lines.push(`  Delivery: ${delivery} | Created: ${a.created_at}`);
      lines.push("");
    }

    return lines.join("\n");
  },
};
