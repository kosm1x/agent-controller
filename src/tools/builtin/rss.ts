/**
 * RSS feed reader tool — fetches the feed directly and parses it locally
 * (src/lib/feed-parse.ts). Formerly went through the rss2json proxy, which
 * failed in bursts on feeds the host itself fetched fine.
 *
 * Parses RSS/Atom feeds into structured JSON.
 * Returns feed metadata and recent items.
 */

import type { Tool } from "../types.js";
import { errMsg } from "../../lib/err-msg.js";
import {
  decodeFeedBody,
  parseFeed,
  readCappedBody,
} from "../../lib/feed-parse.js";
import { safeFetch, validateOutboundUrl } from "../../lib/url-safety.js";

const TIMEOUT_MS = 10_000;
const MAX_ITEMS = 20;

/** rss2json's date format ("YYYY-MM-DD HH:MM:SS", UTC), kept so output is unchanged. */
function formatDate(raw: string): string {
  const d = new Date(raw);
  return Number.isNaN(d.getTime())
    ? raw
    : d.toISOString().replace("T", " ").slice(0, 19);
}

export const rssReadTool: Tool = {
  name: "rss_read",
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "rss_read",
      description: `Read and parse an RSS or Atom feed into structured JSON.

USE WHEN:
- User asks to check news from a specific source
- Monitoring RSS feeds for updates
- Need recent articles or posts from a website
- User provides an RSS/Atom feed URL

DO NOT USE WHEN:
- General web search (use web_search)
- Reading a specific web page (use web_read)
- You don't have a feed URL (search for one first with web_search)

Returns feed title, description, and list of recent items with title, link, date, and description.
Common feeds: BBC (https://feeds.bbci.co.uk/news/rss.xml), Reuters, TechCrunch, etc.`,
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "RSS or Atom feed URL",
          },
          count: {
            type: "number",
            description: `Max items to return (default: 10, max: ${MAX_ITEMS})`,
          },
        },
        required: ["url"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const feedUrl = args.url as string;
    if (!feedUrl) {
      return JSON.stringify({ error: "url is required" });
    }

    const count = Math.min(
      Math.max((args.count as number) ?? 10, 1),
      MAX_ITEMS,
    );

    // SSRF protection — the URL is model-supplied and fetched from this host.
    const urlError = validateOutboundUrl(feedUrl);
    if (urlError) {
      return JSON.stringify({ error: urlError, feed_url: feedUrl });
    }

    try {
      const res = await safeFetch(feedUrl, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          Accept:
            "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.8",
          "User-Agent": "mission-control/1.0 (rss_read)",
        },
      });
      if (!res.ok) {
        void res.body?.cancel().catch(() => {});
        return JSON.stringify({
          error: `RSS fetch failed: HTTP ${res.status}`,
          feed_url: feedUrl,
        });
      }

      const feed = parseFeed(
        decodeFeedBody(
          await readCappedBody(res),
          res.headers?.get("content-type"),
        ),
      );
      if (!feed) {
        const type = res.headers?.get("content-type") ?? "unknown type";
        return JSON.stringify({
          error: `RSS parse error: not an RSS/Atom feed (${type})`,
          feed_url: feedUrl,
        });
      }

      const items = feed.items.slice(0, count).map((item) => ({
        title: item.title,
        link: item.link,
        date: formatDate(item.pubDate),
        description: item.description.slice(0, 300),
        author: item.author,
      }));

      return JSON.stringify({
        feed: {
          title: feed.title,
          description: feed.description,
          url: feed.link || feedUrl,
        },
        items,
        total: items.length,
      });
    } catch (err) {
      const cause = err instanceof Error ? err.cause : undefined;
      const detail = cause instanceof Error ? ` (${cause.message})` : "";
      return JSON.stringify({
        error: `RSS fetch failed: ${errMsg(err)}${detail}`,
      });
    }
  },
};
