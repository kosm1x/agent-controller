/**
 * GDELT adapter — reads the published 15-minute event files from
 * data.gdeltproject.org (static host). The API host (api.gdeltproject.org)
 * rate-limits this VPS's IP with HTTP 429 even for trivial queries, so the
 * API is no longer used.
 *
 * Flow: lastupdate.txt -> latest export.CSV.zip -> tab-separated events.
 */

import { inflateRawSync } from "node:zlib";
import type { CollectorAdapter, Signal } from "../types.js";
import { contentHash } from "../signal-store.js";
import { httpError } from "./http-error.js";

export const GDELT_LASTUPDATE_URL =
  "https://data.gdeltproject.org/gdeltv2/lastupdate.txt";
export const GDELT_TIMEOUT_MS = 30_000;
const MAX_ZIP_BYTES = 20 * 1024 * 1024;
const MAX_EVENTS = 15;
// GDELT 2.0 export columns (0-indexed, 61 columns)
const COL = {
  quadClass: 29,
  goldstein: 30,
  mentions: 31,
  tone: 34,
  geoName: 52,
  lat: 56,
  lon: 57,
  url: 60,
} as const;
const COLUMNS = 61;

/** Extract the first entry of a zip archive (deflate or stored). */
export function unzipFirstEntry(buf: Buffer): string {
  if (buf.length < 30 || buf.readUInt32LE(0) !== 0x04034b50) {
    throw new Error("not a zip archive");
  }
  const flags = buf.readUInt16LE(6);
  const method = buf.readUInt16LE(8);
  const compSize = buf.readUInt32LE(18);
  const start = 30 + buf.readUInt16LE(26) + buf.readUInt16LE(28);
  // Bit 3: sizes live in a data descriptor; take the rest and let inflate stop.
  const end = flags & 8 || compSize === 0 ? buf.length : start + compSize;
  const data = buf.subarray(start, end);
  if (method === 0) return data.toString("utf8");
  if (method === 8) return inflateRawSync(data).toString("utf8");
  throw new Error(`unsupported zip method ${method}`);
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GDELT_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw await httpError(res);
    return res;
  } finally {
    clearTimeout(timeout);
  }
}

export const gdeltAdapter: CollectorAdapter = {
  source: "gdelt",
  domain: "geopolitical",
  defaultInterval: 15 * 60_000,

  async collect(): Promise<Signal[]> {
    const listing = await (await fetchWithTimeout(GDELT_LASTUPDATE_URL)).text();
    const exportLine = listing
      .split("\n")
      .find((l) => l.includes(".export.CSV.zip"));
    const exportUrl = exportLine?.trim().split(/\s+/)[2];
    if (!exportUrl) {
      throw new Error(
        `no export file in lastupdate.txt — ${listing.slice(0, 100).replace(/\s+/g, " ")}`,
      );
    }
    const zipRes = await fetchWithTimeout(exportUrl.replace(/^http:/, "https:"));
    const zip = Buffer.from(await zipRes.arrayBuffer());
    if (zip.length > MAX_ZIP_BYTES) throw new Error("export zip too large");

    const rows = unzipFirstEntry(zip)
      .split("\n")
      .map((l) => l.split("\t"))
      .filter((c) => c.length === COLUMNS);
    if (rows.length === 0) throw new Error("export has no valid event rows");

    const goldstein = rows.map((c) => parseFloat(c[COL.goldstein]));
    const tone = rows.map((c) => parseFloat(c[COL.tone]));
    const avg = (xs: number[]): number | undefined => {
      const v = xs.filter((x) => Number.isFinite(x));
      return v.length
        ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100
        : undefined;
    };

    const signals: Signal[] = [
      {
        source: "gdelt",
        domain: "geopolitical",
        signalType: "numeric",
        key: "events_count",
        valueNumeric: rows.length,
      },
    ];
    const g = avg(goldstein);
    if (g !== undefined) {
      signals.push({
        source: "gdelt",
        domain: "geopolitical",
        signalType: "numeric",
        key: "goldstein_avg",
        valueNumeric: g,
      });
    }
    const t = avg(tone);
    if (t !== undefined) {
      signals.push({
        source: "gdelt",
        domain: "geopolitical",
        signalType: "numeric",
        key: "avg_tone",
        valueNumeric: t,
      });
    }

    // Material-conflict events (QuadClass 4), most-mentioned first, one per URL.
    const seen = new Set<string>();
    const conflict = rows
      .filter((c) => c[COL.quadClass] === "4" && /^https?:\/\//.test(c[COL.url]))
      .sort((a, b) => Number(b[COL.mentions]) - Number(a[COL.mentions]));
    for (const c of conflict) {
      if (signals.length >= 3 + MAX_EVENTS) break;
      const url = c[COL.url].trim();
      if (seen.has(url)) continue;
      seen.add(url);
      const lat = parseFloat(c[COL.lat]);
      const lon = parseFloat(c[COL.lon]);
      signals.push({
        source: "gdelt",
        domain: "geopolitical",
        signalType: "event",
        key: "gdelt_event",
        valueText: c[COL.geoName] || url,
        contentHash: contentHash(url),
        geoLat: Number.isFinite(lat) ? lat : undefined,
        geoLon: Number.isFinite(lon) ? lon : undefined,
        metadata: {
          url,
          goldstein: parseFloat(c[COL.goldstein]),
          tone: parseFloat(c[COL.tone]),
          mentions: Number(c[COL.mentions]),
        },
      });
    }
    return signals;
  },
};
