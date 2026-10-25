/**
 * Geopolitical RSS adapter — conflict/crisis headlines from several public
 * feeds. Replaces the GDELT API article search (blocked by HTTP 429 for this
 * VPS's IP). One feed failing is tolerated; all feeds failing throws.
 */

import type { CollectorAdapter, Signal } from "../types.js";
import { contentHash } from "../signal-store.js";
import { httpError } from "./http-error.js";
import { errMsg } from "../../lib/err-msg.js";
import {
  decodeFeedBody,
  parseFeed,
  readCappedBody,
} from "../../lib/feed-parse.js";

export const GEO_FEEDS: { name: string; url: string; filter: boolean }[] = [
  {
    name: "google_news",
    url: "https://news.google.com/rss/search?q=(conflict+OR+crisis+OR+sanctions)+when:1h&hl=en-US&gl=US&ceid=US:en",
    filter: false,
  },
  { name: "bbc", url: "https://feeds.bbci.co.uk/news/world/rss.xml", filter: true },
  {
    name: "aljazeera",
    url: "https://www.aljazeera.com/xml/rss/all.xml",
    filter: true,
  },
  { name: "dw", url: "https://rss.dw.com/rdf/rss-en-world", filter: true },
  {
    name: "france24",
    url: "https://www.france24.com/en/rss",
    filter: true,
  },
];
const KEYWORDS =
  /conflict|crisis|sanction|war\b|attack|strike|missile|ceasefire|troops|military|invasion|hostage|protest|coup|refugee|humanitarian/i;
const TIMEOUT_MS = 10_000;
const MAX_PER_FEED = 10;
const MAX_ARTICLES = 40;

async function readFeed(
  feed: (typeof GEO_FEEDS)[number],
): Promise<Signal[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(feed.url, {
      signal: controller.signal,
      headers: {
        Accept: "application/rss+xml, application/xml;q=0.9, */*;q=0.8",
        "User-Agent": "mission-control/1.0 (intel-depot)",
      },
    });
    if (!res.ok) throw await httpError(res);
    const body = decodeFeedBody(
      await readCappedBody(res),
      res.headers?.get("content-type"),
    );
    const parsed = parseFeed(body);
    if (!parsed) throw new Error("not an RSS/Atom feed");
    const out: Signal[] = [];
    for (const item of parsed.items) {
      if (out.length >= MAX_PER_FEED) break;
      if (!item.link || !item.title) continue;
      if (feed.filter && !KEYWORDS.test(`${item.title} ${item.description}`)) {
        continue;
      }
      const ts = item.pubDate ? new Date(item.pubDate) : undefined;
      out.push({
        source: "geo_rss",
        domain: "geopolitical",
        signalType: "article",
        key: "geo_article",
        valueText: item.title,
        contentHash: contentHash(item.link),
        sourceTimestamp:
          ts && !Number.isNaN(ts.getTime()) ? ts.toISOString() : undefined,
        metadata: { url: item.link, feed: feed.name },
      });
    }
    return out;
  } finally {
    clearTimeout(timeout);
  }
}

export const geoRssAdapter: CollectorAdapter = {
  source: "geo_rss",
  domain: "geopolitical",
  defaultInterval: 15 * 60_000,

  async collect(): Promise<Signal[]> {
    const results = await Promise.allSettled(GEO_FEEDS.map(readFeed));
    const ok = results.filter(
      (r): r is PromiseFulfilledResult<Signal[]> => r.status === "fulfilled",
    );
    if (ok.length === 0) {
      const first = results.find(
        (r): r is PromiseRejectedResult => r.status === "rejected",
      );
      throw first?.reason instanceof Error
        ? first.reason
        : new Error("all geopolitical feeds failed");
    }
    results.forEach((r, i) => {
      if (r.status === "rejected") {
        console.warn(
          `[intel] geo_rss feed failed: ${new URL(GEO_FEEDS[i].url).host}: ${errMsg(r.reason)}`,
        );
      }
    });
    const seen = new Set<string>();
    const articles: Signal[] = [];
    for (const s of ok.flatMap((r) => r.value)) {
      if (!s.contentHash || seen.has(s.contentHash)) continue;
      seen.add(s.contentHash);
      articles.push(s);
    }
    return [
      {
        source: "geo_rss",
        domain: "geopolitical",
        signalType: "numeric",
        key: "conflict_articles",
        valueNumeric: articles.length,
      },
      ...articles.slice(0, MAX_ARTICLES),
    ];
  },
};
