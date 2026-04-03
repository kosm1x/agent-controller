/**
 * Google News RSS adapter — breaking news headlines.
 * No auth required (uses rss2json free API). Polling: 30 minutes.
 */

import type { CollectorAdapter, Signal } from "../types.js";
import { contentHash } from "../signal-store.js";

const RSS_URL =
  "https://news.google.com/rss/search?q=breaking+OR+crisis+OR+emergency&hl=en-US&gl=US&ceid=US:en";
const RSS2JSON_API = "https://api.rss2json.com/v1/api.json";
const TIMEOUT_MS = 10_000;
const MAX_ARTICLES = 10;

interface RssItem {
  title: string;
  link: string;
  pubDate: string;
  description?: string;
  author?: string;
}

interface RssResponse {
  status: string;
  items?: RssItem[];
}

export const googleNewsAdapter: CollectorAdapter = {
  source: "google_news",
  domain: "news",
  defaultInterval: 30 * 60_000,

  async collect(): Promise<Signal[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const params = new URLSearchParams({
        rss_url: RSS_URL,
        count: String(MAX_ARTICLES),
      });

      const res = await fetch(`${RSS2JSON_API}?${params}`, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return [];

      const data = (await res.json()) as RssResponse;
      if (data.status !== "ok" || !data.items) return [];

      const signals: Signal[] = [];

      for (const item of data.items.slice(0, MAX_ARTICLES)) {
        signals.push({
          source: "google_news",
          domain: "news",
          signalType: "article",
          key: "news_article",
          valueText: item.title,
          contentHash: contentHash(item.link),
          sourceTimestamp: item.pubDate
            ? new Date(item.pubDate).toISOString()
            : undefined,
          metadata: {
            url: item.link,
            description: item.description?.slice(0, 200),
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
