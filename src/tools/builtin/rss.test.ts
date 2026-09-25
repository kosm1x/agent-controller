import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { rssReadTool } from "./rss.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
});

const BBC = `<?xml version="1.0" encoding="UTF-8"?><rss xmlns:dc="http://purl.org/dc/elements/1.1/" version="2.0">
  <channel>
    <title><![CDATA[BBC News]]></title>
    <description><![CDATA[BBC World News]]></description>
    <link>https://www.bbc.co.uk/news</link>
    <image><title>BBC News</title><url>https://x/img.gif</url></image>
    <item>
      <title><![CDATA[Breaking News]]></title>
      <link>https://bbc.co.uk/news/1</link>
      <pubDate>Tue, 17 Mar 2026 10:00:00 GMT</pubDate>
      <description><![CDATA[Something happened]]></description>
      <dc:creator>BBC</dc:creator>
    </item>
    <item>
      <title>Other News</title>
      <link>https://bbc.co.uk/news/2</link>
      <pubDate>Tue, 17 Mar 2026 09:00:00 GMT</pubDate>
      <description>Something else happened</description>
    </item>
  </channel>
</rss>`;

const xml = (body: string, init: ResponseInit = {}) =>
  new Response(body, {
    status: 200,
    headers: { "content-type": "application/rss+xml" },
    ...init,
  });

const run = async (args: Record<string, unknown>) =>
  JSON.parse(await rssReadTool.execute(args));

describe("rss_read", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it("has consistent name", () => {
    expect(rssReadTool.name).toBe("rss_read");
    expect(rssReadTool.definition.function.name).toBe("rss_read");
  });

  it("requires url parameter", async () => {
    const result = await run({});
    expect(result.error).toContain("url is required");
  });

  it("fetches the feed directly and keeps the rss2json-era output shape", async () => {
    mockFetch.mockResolvedValueOnce(xml(BBC));

    const result = await run({ url: "https://feeds.bbci.co.uk/news/rss.xml" });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe(
      "https://feeds.bbci.co.uk/news/rss.xml",
    );
    expect(result).toEqual({
      feed: {
        title: "BBC News",
        description: "BBC World News",
        url: "https://www.bbc.co.uk/news",
      },
      items: [
        {
          title: "Breaking News",
          link: "https://bbc.co.uk/news/1",
          date: "2026-03-17 10:00:00",
          description: "Something happened",
          author: "BBC",
        },
        {
          title: "Other News",
          link: "https://bbc.co.uk/news/2",
          date: "2026-03-17 09:00:00",
          description: "Something else happened",
          author: "",
        },
      ],
      total: 2,
    });
  });

  it("parses an Atom feed", async () => {
    mockFetch.mockResolvedValueOnce(
      xml(
        `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Release notes from node</title><link rel="alternate" href="https://github.com/nodejs/node/releases"/><entry><title>v24.0.0</title><link rel="alternate" href="https://github.com/nodejs/node/releases/tag/v24.0.0"/><updated>2026-09-23T18:21:37Z</updated><content type="html">&lt;p&gt;${"x".repeat(400)}&lt;/p&gt;</content><author><name>aduh95</name></author></entry></feed>`,
      ),
    );
    const result = await run({
      url: "https://github.com/nodejs/node/releases.atom",
    });
    expect(result.feed).toEqual({
      title: "Release notes from node",
      description: "",
      url: "https://github.com/nodejs/node/releases",
    });
    expect(result.items[0]).toMatchObject({
      title: "v24.0.0",
      link: "https://github.com/nodejs/node/releases/tag/v24.0.0",
      date: "2026-09-23 18:21:37",
      author: "aduh95",
    });
    expect(result.items[0].description).toHaveLength(300);
  });

  it("honours count and falls back to the feed URL when the feed has no link", async () => {
    const items = Array.from(
      { length: 30 },
      (_, i) => `<item><title>n${i}</title><pubDate>garbled</pubDate></item>`,
    ).join("");
    mockFetch.mockResolvedValue(
      xml(`<rss><channel><title>T</title>${items}</channel></rss>`),
    );
    const three = await run({ url: "https://example.com/feed", count: 3 });
    expect(three.total).toBe(3);
    expect(three.items[0].date).toBe("garbled");
    expect(three.feed.url).toBe("https://example.com/feed");

    mockFetch.mockResolvedValue(
      xml(`<rss><channel><title>T</title>${items}</channel></rss>`),
    );
    expect(
      (await run({ url: "https://example.com/feed", count: 99 })).total,
    ).toBe(20);
  });

  it("decodes an ISO-8859-1 feed by its Content-Type charset", async () => {
    const body = Buffer.from(
      "<rss><channel><title>Noticias</title><item><title>Caf\u00e9 Espa\u00f1a</title><description>a\u00f1o</description></item></channel></rss>",
      "latin1",
    );
    mockFetch.mockResolvedValueOnce(
      new Response(body, {
        headers: { "content-type": "application/rss+xml; charset=ISO-8859-1" },
      }),
    );
    const result = await run({ url: "https://example.es/rss" });
    expect(result.items[0].title).toBe("Café España");
    expect(result.items[0].description).toBe("año");
  });

  it("reports a non-feed page as an RSS parse error", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response("<!DOCTYPE html><html><body>Not here</body></html>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );
    const result = await run({ url: "https://not-a-feed.com" });
    expect(result.error).toBe(
      "RSS parse error: not an RSS/Atom feed (text/html; charset=utf-8)",
    );
    expect(result.feed_url).toBe("https://not-a-feed.com");
  });

  it("handles HTTP error", async () => {
    mockFetch.mockResolvedValueOnce(new Response("slow down", { status: 429 }));
    const result = await run({ url: "https://example.com/feed.xml" });
    expect(result.error).toContain("429");
  });

  it("reports a network failure", async () => {
    mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));
    const result = await run({ url: "https://example.com/feed.xml" });
    expect(result.error).toBe("RSS fetch failed: fetch failed");
  });

  it("blocks private / internal URLs before fetching (SSRF)", async () => {
    for (const url of [
      "http://127.0.0.1/feed",
      "http://localhost:8080/rss",
      "http://169.254.169.254/latest/meta-data/",
      "file:///etc/passwd",
    ]) {
      const result = await run({ url });
      expect(result.error).toMatch(/Blocked/);
      expect(result.feed_url).toBe(url);
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("refuses a redirect hop to an internal address", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1:8080/feed" },
      }),
    );
    const result = await run({ url: "https://example.com/feed.xml" });
    expect(result.error).toMatch(/^RSS fetch failed: fetch failed \(Blocked/);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("refuses an oversized feed (declared or streamed)", async () => {
    mockFetch.mockResolvedValueOnce(
      xml("<rss/>", { headers: { "content-length": String(6 * 1024 * 1024) } }),
    );
    expect((await run({ url: "https://example.com/big" })).error).toMatch(
      /feed larger than 5242880 bytes/,
    );

    const chunk = new Uint8Array(1024 * 1024).fill(0x20);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 8) controller.enqueue(chunk);
        else controller.close();
      },
    });
    mockFetch.mockResolvedValueOnce(new Response(stream, { status: 200 }));
    expect((await run({ url: "https://example.com/big" })).error).toMatch(
      /feed larger than 5242880 bytes/,
    );
    expect(sent).toBeLessThan(8);
  });
});
