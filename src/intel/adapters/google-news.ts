/**
 * Google News RSS adapter — breaking news headlines.
 * No auth required; the feed is fetched directly and parsed locally (the
 * rss2json proxy it used to go through failed in bursts). Polling: 30 minutes.
 */

import type { CollectorAdapter, Signal } from "../types.js";
import { contentHash } from "../signal-store.js";
import { httpError } from "./http-error.js";
import {
  decodeFeedBody,
  parseFeed,
  readCappedBody,
} from "../../lib/feed-parse.js";

const RSS_URL =
  "https://news.google.com/rss/search?q=breaking+OR+crisis+OR+emergency&hl=en-US&gl=US&ceid=US:en";
const TIMEOUT_MS = 10_000;
const MAX_ARTICLES = 10;

export const googleNewsAdapter: CollectorAdapter = {
  source: "google_news",
  domain: "news",
  defaultInterval: 30 * 60_000,

  async collect(): Promise<Signal[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const res = await fetch(RSS_URL, {
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
      const feed = parseFeed(body);
      if (!feed) {
        throw new Error(
          `not an RSS/Atom feed — ${body.slice(0, 200).replace(/\s+/g, " ").trim().slice(0, 100)}`,
        );
      }
      if (feed.items.length === 0) {
        throw new Error("feed has no items");
      }

      const signals: Signal[] = [];

      for (const item of feed.items.slice(0, MAX_ARTICLES)) {
        const ts = item.pubDate ? new Date(item.pubDate) : undefined;
        signals.push({
          source: "google_news",
          domain: "news",
          signalType: "article",
          key: "news_article",
          valueText: item.title,
          contentHash: contentHash(item.link),
          sourceTimestamp:
            ts && !Number.isNaN(ts.getTime()) ? ts.toISOString() : undefined,
          metadata: {
            url: item.link,
            description: item.description.slice(0, 200),
          },
        });
      }

      return signals;
    } finally {
      clearTimeout(timeout);
    }
  },
};
