/**
 * intel_query — Query the Intelligence Depot signal store.
 * Returns recent signals filtered by domain, source, or time range.
 */

import type { Tool } from "../types.js";
import { getRecentSignals } from "../../intel/signal-store.js";

export const intelQueryTool: Tool = {
  name: "intel_query",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "intel_query",
      description: `Query the Intelligence Depot for recent signals across multiple domains.

USE WHEN:
- User asks "qué señales hay hoy?", "what happened overnight?", "any alerts?"
- User asks about specific domains: markets, earthquakes, cyber threats, geopolitical events
- Morning briefing needs signal summary
- User asks about a specific data source (USGS, GDELT, CoinGecko, etc.)

DO NOT USE WHEN:
- User wants a web search for general information (use web_search)
- User asks about topics not covered by signal sources
- User wants historical analysis beyond 7 days

Returns pre-formatted text summary of recent signals with severity levels.
Available domains: financial, weather, geopolitical, cyber, news.
Available sources: usgs, nws, gdelt, frankfurter, cisa_kev, coingecko, treasury, google_news.

AFTER QUERYING: Report which sources returned data and the time window covered. Don't extrapolate beyond what the signals show.`,
      parameters: {
        type: "object",
        properties: {
          domain: {
            type: "string",
            description:
              "Filter by domain: financial, weather, geopolitical, cyber, news. Omit for all domains.",
            enum: ["financial", "weather", "geopolitical", "cyber", "news"],
          },
          source: {
            type: "string",
            description:
              "Filter by source: usgs, nws, gdelt, frankfurter, cisa_kev, coingecko, treasury, google_news. Omit for all sources.",
            enum: [
              "usgs",
              "nws",
              "gdelt",
              "frankfurter",
              "cisa_kev",
              "coingecko",
              "treasury",
              "google_news",
            ],
          },
          hours: {
            type: "number",
            description: "Time range in hours (default: 24, max: 168)",
          },
          limit: {
            type: "number",
            description: "Max signals to return (default: 20, max: 50)",
          },
        },
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const hours = Math.min(Math.max(Number(args.hours) || 24, 1), 168);
    const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 50);
    const source = args.source as string | undefined;
    const domain = args.domain as string | undefined;

    const signals = getRecentSignals(hours, source, domain, limit);

    if (signals.length === 0) {
      return `No signals found in the last ${hours}h${source ? ` for source=${source}` : ""}${domain ? ` domain=${domain}` : ""}.`;
    }

    const lines: string[] = [
      `📡 Intelligence Depot — ${signals.length} signals (last ${hours}h)`,
      "",
    ];

    for (const s of signals) {
      const val =
        s.value_numeric !== null
          ? String(s.value_numeric)
          : (s.value_text?.slice(0, 100) ?? "");
      lines.push(
        `[${s.source}/${s.domain}] ${s.key}: ${val} (${s.signal_type}, ${s.collected_at})`,
      );
    }

    return lines.join("\n");
  },
};
