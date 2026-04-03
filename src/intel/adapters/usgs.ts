/**
 * USGS Earthquake adapter — fetches recent earthquakes from USGS GeoJSON feed.
 * No auth required. Polling: 5 minutes.
 */

import type { CollectorAdapter, Signal } from "../types.js";
import { contentHash } from "../signal-store.js";

const FEED_URL =
  "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson";
const TIMEOUT_MS = 10_000;

interface USGSFeature {
  id: string;
  properties: {
    mag: number;
    place: string;
    time: number;
    url: string;
    type: string;
    title: string;
    alert?: string;
    tsunami?: number;
  };
  geometry: {
    coordinates: [number, number, number]; // [lon, lat, depth]
  };
}

interface USGSResponse {
  type: string;
  metadata: { count: number };
  features: USGSFeature[];
}

export const usgsAdapter: CollectorAdapter = {
  source: "usgs",
  domain: "weather",
  defaultInterval: 5 * 60_000,

  async collect(): Promise<Signal[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const res = await fetch(FEED_URL, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return [];

      const data = (await res.json()) as USGSResponse;
      const signals: Signal[] = [];

      // Count of M5+ earthquakes (for delta engine metric)
      const m5plus = data.features.filter((f) => f.properties.mag >= 5).length;
      signals.push({
        source: "usgs",
        domain: "weather",
        signalType: "numeric",
        key: "quakes_5plus",
        valueNumeric: m5plus,
        metadata: { total: data.metadata.count },
      });

      // Individual significant earthquakes (M4+)
      for (const f of data.features) {
        if (f.properties.mag < 4) continue;
        const [lon, lat] = f.geometry.coordinates;
        signals.push({
          source: "usgs",
          domain: "weather",
          signalType: "event",
          key: `quake_${f.id}`,
          valueNumeric: f.properties.mag,
          valueText: f.properties.title,
          geoLat: lat,
          geoLon: lon,
          contentHash: contentHash(f.id),
          sourceTimestamp: new Date(f.properties.time).toISOString(),
          metadata: {
            place: f.properties.place,
            url: f.properties.url,
            tsunami: f.properties.tsunami,
            alert: f.properties.alert,
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
