/**
 * GDELT adapter — fetches recent conflict/crisis articles from GDELT API v2.
 * No auth required. Polling: 15 minutes, last hour newest-first.
 * Timeouts are generous because since 2026-09-23 GDELT's TLS handshake alone
 * takes 10-13 s from this VPS (undici's default 10 s connect timeout failed it)
 * and successful responses take 13-20 s.
 */

import { Agent } from "undici";
import type { CollectorAdapter, Signal } from "../types.js";
import { contentHash } from "../signal-store.js";
import { httpError } from "./http-error.js";

const API_URL =
  "https://api.gdeltproject.org/api/v2/doc/doc?query=(conflict%20OR%20crisis%20OR%20sanctions)&mode=ArtList&format=json&maxrecords=50&timespan=1h&sort=DateDesc";
export const GDELT_TIMEOUT_MS = 45_000;
export const GDELT_CONNECT_TIMEOUT_MS = 30_000;
const dispatcher = new Agent({ connectTimeout: GDELT_CONNECT_TIMEOUT_MS });

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
    const timeout = setTimeout(() => controller.abort(), GDELT_TIMEOUT_MS);

    try {
      const res = await fetch(API_URL, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
        dispatcher,
        // undici 7's Agent type != Node's bundled undici-types Dispatcher;
        // runtime contract is identical (same pattern as lib/url-safety.ts).
      } as unknown as RequestInit);
      if (!res.ok) throw await httpError(res);

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
    } finally {
      clearTimeout(timeout);
    }
  },
};
