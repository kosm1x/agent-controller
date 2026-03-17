/**
 * RSS feed reader tool — rss2json API (free, no auth for basic usage).
 *
 * Parses RSS/Atom feeds into structured JSON.
 * Returns feed metadata and recent items.
 */

import type { Tool } from "../types.js";

const API_URL = "https://api.rss2json.com/v1/api.json";
const TIMEOUT_MS = 10_000;
const MAX_ITEMS = 20;

export const rssReadTool: Tool = {
  name: "rss_read",
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

    const params = new URLSearchParams({
      rss_url: feedUrl,
      count: String(count),
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(`${API_URL}?${params}`, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });

      if (!response.ok) {
        return JSON.stringify({
          error: `RSS API error: ${response.status}`,
        });
      }

      const data = (await response.json()) as RssResponse;

      if (data.status !== "ok") {
        return JSON.stringify({
          error: `RSS parse error: ${data.message ?? "unknown"}`,
          feed_url: feedUrl,
        });
      }

      const items = (data.items ?? []).slice(0, count).map((item) => ({
        title: item.title,
        link: item.link,
        date: item.pubDate,
        description: item.description?.slice(0, 300) ?? "",
        author: item.author ?? "",
      }));

      return JSON.stringify({
        feed: {
          title: data.feed?.title ?? "",
          description: data.feed?.description ?? "",
          url: data.feed?.link ?? feedUrl,
        },
        items,
        total: items.length,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ error: `RSS fetch failed: ${message}` });
    } finally {
      clearTimeout(timeout);
    }
  },
};

interface RssResponse {
  status: string;
  message?: string;
  feed?: {
    title: string;
    description: string;
    link: string;
  };
  items?: Array<{
    title: string;
    link: string;
    pubDate: string;
    description?: string;
    author?: string;
  }>;
}
