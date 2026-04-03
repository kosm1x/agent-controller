/**
 * NWS Alerts adapter — fetches active weather alerts from weather.gov.
 * No auth required (User-Agent header recommended). Polling: 5 minutes.
 */

import type { CollectorAdapter, Signal } from "../types.js";
import { contentHash } from "../signal-store.js";

const FEED_URL = "https://api.weather.gov/alerts/active?status=actual";
const TIMEOUT_MS = 10_000;

interface NWSAlert {
  id: string;
  properties: {
    event: string;
    severity: string;
    certainty: string;
    urgency: string;
    headline: string;
    description: string;
    onset: string;
    expires: string;
    areaDesc: string;
  };
}

interface NWSResponse {
  features: NWSAlert[];
}

export const nwsAdapter: CollectorAdapter = {
  source: "nws",
  domain: "weather",
  defaultInterval: 5 * 60_000,

  async collect(): Promise<Signal[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const res = await fetch(FEED_URL, {
        signal: controller.signal,
        headers: {
          Accept: "application/geo+json",
          "User-Agent": "mission-control/1.0 (intel-depot)",
        },
      });
      if (!res.ok) return [];

      const data = (await res.json()) as NWSResponse;
      const signals: Signal[] = [];

      // Warning count metric (for delta engine)
      const warnings = data.features.filter(
        (f) =>
          f.properties.severity === "Extreme" ||
          f.properties.severity === "Severe",
      );
      signals.push({
        source: "nws",
        domain: "weather",
        signalType: "numeric",
        key: "active_warnings",
        valueNumeric: warnings.length,
        metadata: { total_alerts: data.features.length },
      });

      // Individual extreme/severe alerts
      for (const f of warnings.slice(0, 20)) {
        signals.push({
          source: "nws",
          domain: "weather",
          signalType: "alert",
          key: `nws_${f.properties.event.replace(/\s+/g, "_").toLowerCase()}`,
          valueText: f.properties.headline,
          contentHash: contentHash(f.id),
          sourceTimestamp: f.properties.onset,
          metadata: {
            event: f.properties.event,
            severity: f.properties.severity,
            urgency: f.properties.urgency,
            area: f.properties.areaDesc?.slice(0, 200),
            expires: f.properties.expires,
          },
        });
      }

      return signals;
    } catch {
      return [];
    } finally {
      clearTimeout(timeout);
    }
  },
};
