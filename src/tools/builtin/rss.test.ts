import { describe, it, expect, vi, beforeEach } from "vitest";
import { rssReadTool } from "./rss.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
});

describe("rss_read", () => {
  it("has consistent name", () => {
    expect(rssReadTool.name).toBe("rss_read");
    expect(rssReadTool.definition.function.name).toBe("rss_read");
  });

  it("requires url parameter", async () => {
    const result = JSON.parse(await rssReadTool.execute({}));
    expect(result.error).toContain("url is required");
  });

  it("parses RSS feed", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: "ok",
        feed: {
          title: "BBC News",
          description: "BBC World News",
          link: "https://www.bbc.co.uk/news",
        },
        items: [
          {
            title: "Breaking News",
            link: "https://bbc.co.uk/news/1",
            pubDate: "2026-03-17 10:00:00",
            description: "Something happened",
            author: "BBC",
          },
          {
            title: "Other News",
            link: "https://bbc.co.uk/news/2",
            pubDate: "2026-03-17 09:00:00",
            description: "Something else happened",
            author: "",
          },
        ],
      }),
    });

    const result = JSON.parse(
      await rssReadTool.execute({
        url: "https://feeds.bbci.co.uk/news/rss.xml",
      }),
    );

    expect(result.feed.title).toBe("BBC News");
    expect(result.items).toHaveLength(2);
    expect(result.items[0].title).toBe("Breaking News");
    expect(result.total).toBe(2);
  });

  it("handles RSS parse error", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: "error",
        message: "Invalid URL",
      }),
    });

    const result = JSON.parse(
      await rssReadTool.execute({ url: "https://not-a-feed.com" }),
    );
    expect(result.error).toContain("Invalid URL");
  });

  it("handles HTTP error", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 429 });
    const result = JSON.parse(
      await rssReadTool.execute({ url: "https://example.com/feed.xml" }),
    );
    expect(result.error).toContain("429");
  });
});
