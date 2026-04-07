/**
 * intel_baseline — Statistical baselines and z-scores for a metric.
 * Shows rolling mean/stddev and whether current value is anomalous.
 */

import type { Tool } from "../types.js";
import { getBaselines, computeZScore } from "../../intel/baselines.js";
import { getSnapshot } from "../../intel/signal-store.js";

export const intelBaselineTool: Tool = {
  name: "intel_baseline",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "intel_baseline",
      description: `Get statistical baselines and anomaly z-scores for a specific Intelligence Depot metric.

USE WHEN:
- User asks "is the VIX behaving unusually?", "el peso está fuera de rango?"
- Checking if a metric is within normal range
- Understanding statistical context for a signal value

DO NOT USE WHEN:
- User wants current signal values (use intel_query)
- User wants alert history (use intel_alert_history)
- Not enough data has accumulated (baselines need 2+ data points)

Available metrics include: usgs/quakes_5plus, nws/active_warnings, gdelt/conflict_articles,
frankfurter/MXN, cisa_kev/new_vulns, coingecko/bitcoin, treasury/10Y.`,
      parameters: {
        type: "object",
        properties: {
          source: {
            type: "string",
            description:
              "Signal source: usgs, nws, gdelt, frankfurter, cisa_kev, coingecko, treasury",
          },
          key: {
            type: "string",
            description:
              "Metric key: quakes_5plus, active_warnings, conflict_articles, MXN, new_vulns, bitcoin, 10Y",
          },
        },
        required: ["source", "key"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const source = args.source as string;
    const key = args.key as string;

    if (!source || !key) {
      return "Error: source and key are required.";
    }

    const baselines = getBaselines(source, key);
    const snapshot = getSnapshot(source, key);

    if (baselines.length === 0) {
      return `No baselines available for ${source}/${key}. Baselines require at least 2 data points — data may still be accumulating.`;
    }

    const lines: string[] = [`📊 Baseline — ${source}/${key}`, ""];

    if (snapshot) {
      lines.push(
        `Current value: ${snapshot.last_value_numeric ?? "N/A"} (as of ${snapshot.snapshot_at})`,
      );
      lines.push(`Observations: ${snapshot.run_count}`);
      lines.push("");
    }

    for (const b of baselines) {
      const zScore =
        snapshot?.last_value_numeric !== null &&
        snapshot?.last_value_numeric !== undefined
          ? computeZScore(snapshot.last_value_numeric, b)
          : null;

      const zLabel =
        zScore !== null
          ? Math.abs(zScore) > 3
            ? `⚠️ ANOMALY (z=${zScore})`
            : Math.abs(zScore) > 2
              ? `📌 Unusual (z=${zScore})`
              : `✅ Normal (z=${zScore})`
          : "N/A";

      lines.push(`Window ${b.window}:`);
      lines.push(
        `  Mean: ${b.mean.toFixed(4)} | StdDev: ${b.stddev.toFixed(4)} | Range: [${b.min_val ?? "?"}, ${b.max_val ?? "?"}]`,
      );
      lines.push(`  Samples: ${b.sample_count} | Z-score: ${zLabel}`);
      lines.push("");
    }

    return lines.join("\n");
  },
};
