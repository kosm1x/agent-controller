/**
 * intel_status — Intelligence Depot health dashboard.
 * Shows per-source health, signal counts, and active alerts.
 */

import type { Tool } from "../types.js";
import { getCollectorHealth, isRunning } from "../../intel/scheduler.js";
import { getSignalCounts } from "../../intel/signal-store.js";
import { getRecentAlerts } from "../../intel/alert-router.js";

export const intelStatusTool: Tool = {
  name: "intel_status",
  definition: {
    type: "function",
    function: {
      name: "intel_status",
      description: `Get Intelligence Depot health status: collector health, signal counts, active alerts.

USE WHEN:
- User asks "cómo está el depot?", "intel status", "are signals flowing?"
- Diagnosing why signal data might be missing
- Checking if collectors are running and healthy

DO NOT USE WHEN:
- User wants actual signal data (use intel_query)
- User wants alert history (use intel_alert_history)`,
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },

  async execute(): Promise<string> {
    const running = isRunning();
    const healths = getCollectorHealth();
    const counts = getSignalCounts(24);
    const alerts = getRecentAlerts(24);

    const lines: string[] = [
      `📡 Intelligence Depot — ${running ? "RUNNING" : "STOPPED"}`,
      "",
      "Collectors:",
    ];

    for (const h of healths) {
      const status =
        h.consecutiveFailures > 0
          ? `❌ ${h.consecutiveFailures} failures`
          : "✅ healthy";
      lines.push(
        `  ${h.source}: ${status} | last: ${h.lastSuccess ?? "never"} | total: ${h.totalSignals}`,
      );
    }

    lines.push("", "Signals (last 24h):");
    if (counts.length === 0) {
      lines.push("  No signals collected yet.");
    } else {
      for (const c of counts) {
        lines.push(`  ${c.source}: ${c.count}`);
      }
    }

    lines.push("", `Alerts (last 24h): ${alerts.length}`);
    for (const a of alerts.slice(0, 5)) {
      lines.push(
        `  [${a.tier}] ${a.title} (${a.delivered_at ? "delivered" : "pending"})`,
      );
    }

    return lines.join("\n");
  },
};
