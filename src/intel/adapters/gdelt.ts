/**
 * GDELT adapter — fetches recent conflict/crisis articles from GDELT API v2.
 * No auth required. Polling: 15 minutes.
 */

import type { CollectorAdapter, Signal } from "../types.js";
import { contentHash } from "../signal-store.js";

const API_URL =
  "https://api.gdeltproject.org/api/v2/doc/doc?query=conflict%20OR%20crisis%20OR%20sanctions&mode=ArtList&format=json&maxrecords=50";
const TIMEOUT_MS = 15_000;

interface GDELTArticle {
  url: string;
  title: string;
  seendate: string;
  domain: string;
  language: string;
  sourcecountry: string;
  socialimage?: string;
}

interface GDELTResponse {
  articles?: GDELTArticle[];
}

export const gdeltAdapter: CollectorAdapter = {
  source: "gdelt",
  domain: "geopolitical",
  defaultInterval: 15 * 60_000,

  async collect(): Promise<Signal[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const res = await fetch(API_URL, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return [];

      const data = (await res.json()) as GDELTResponse;
      const articles = data.articles ?? [];
      const signals: Signal[] = [];

      // Article count metric (for delta engine)
      signals.push({
        source: "gdelt",
        domain: "geopolitical",
        signalType: "numeric",
        key: "conflict_articles",
        valueNumeric: articles.length,
      });

      // Individual articles (top 15)
      for (const a of articles.slice(0, 15)) {
        signals.push({
          source: "gdelt",
          domain: "geopolitical",
          signalType: "article",
          key: "gdelt_article",
          valueText: a.title,
          contentHash: contentHash(a.url),
          sourceTimestamp: a.seendate
            ? new Date(
                a.seendate.replace(
                  /(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/,
                  "$1-$2-$3T$4:$5:$6Z",
                ),
              ).toISOString()
            : undefined,
          metadata: {
            url: a.url,
            source_domain: a.domain,
            country: a.sourcecountry,
            language: a.language,
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
