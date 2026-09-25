/**
 * Adapter contract tests — verify each adapter produces valid Signal[] shapes
 * and reports every failure by throwing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { usgsAdapter } from "./usgs.js";
import { nwsAdapter } from "./nws.js";
import { gdeltAdapter } from "./gdelt.js";
import { frankfurterAdapter } from "./frankfurter.js";
import { cisaKevAdapter } from "./cisa-kev.js";
import { coingeckoAdapter } from "./coingecko.js";
import { treasuryAdapter } from "./treasury.js";
import { googleNewsAdapter } from "./google-news.js";
import { getAllAdapters } from "./index.js";
import { contentHash } from "../signal-store.js";
import type { CollectorAdapter } from "../types.js";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Shared contract tests
// ---------------------------------------------------------------------------

function testAdapterContract(
  adapter: CollectorAdapter,
  format: "json" | "xml" = "json",
): void {
  describe(`${adapter.source} adapter contract`, () => {
    beforeEach(() => {
      mockFetch.mockReset();
    });

    it("has required metadata", () => {
      expect(adapter.source).toBeTruthy();
      expect(adapter.domain).toBeTruthy();
      expect(adapter.defaultInterval).toBeGreaterThanOrEqual(0);
    });

    // A failure must reach the scheduler as a throw: `[]` is recorded as a
    // successful poll, which hid a dead GDELT source for a month.
    it("throws on HTTP error, with the status and the start of the body", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => "upstream exploded",
      });
      await expect(adapter.collect()).rejects.toThrow(
        "HTTP 500 — upstream exploded",
      );
    });

    it("throws on network error", async () => {
      mockFetch.mockRejectedValue(new Error("network error"));
      await expect(adapter.collect()).rejects.toThrow("network error");
    });

    it("throws on timeout", async () => {
      mockFetch.mockRejectedValue(new DOMException("aborted", "AbortError"));
      await expect(adapter.collect()).rejects.toThrow("aborted");
      expect(mockFetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    });

    it("keeps an upstream error page to one bounded line", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 502,
        text: async () => `<html>\n<h1>Bad\tGateway</h1>\n${"x".repeat(500)}`,
      });
      const err: Error = await adapter.collect().catch((e) => e);
      expect(err.message).toMatch(
        /^HTTP 502 — <html> <h1>Bad Gateway<\/h1> x+$/,
      );
      expect(err.message.length).toBe("HTTP 502 — ".length + 200);
    });

    it(`throws on a 200 whose body is not ${format === "xml" ? "a feed" : "JSON"}`, async () => {
      const body = "Queries containing OR'd terms must be…";
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => JSON.parse(body),
        text: async () => body,
        arrayBuffer: async () => new TextEncoder().encode(body).buffer,
      });
      await expect(adapter.collect()).rejects.toThrow(
        format === "xml" ? /not an RSS\/Atom feed/ : /JSON/,
      );
    });
  });
}

// Run contract tests for all adapters
testAdapterContract(usgsAdapter);
testAdapterContract(nwsAdapter);
testAdapterContract(gdeltAdapter);
testAdapterContract(frankfurterAdapter);
testAdapterContract(cisaKevAdapter);
testAdapterContract(coingeckoAdapter);
testAdapterContract(treasuryAdapter);
testAdapterContract(googleNewsAdapter, "xml");

// ---------------------------------------------------------------------------
// USGS-specific
// ---------------------------------------------------------------------------

describe("usgs adapter", () => {
  beforeEach(() => mockFetch.mockReset());

  it("produces numeric + event signals from earthquake data", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        type: "FeatureCollection",
        metadata: { count: 3 },
        features: [
          {
            id: "us7000abc",
            properties: {
              mag: 5.2,
              place: "10km NE of Tokyo",
              time: 1712150400000,
              url: "https://earthquake.usgs.gov/earthquakes/eventpage/us7000abc",
              title: "M 5.2 - 10km NE of Tokyo",
            },
            geometry: { coordinates: [139.8, 35.7, 10] },
          },
          {
            id: "us7000def",
            properties: { mag: 2.1, place: "5km S of LA", time: 1712150500000 },
            geometry: { coordinates: [-118.2, 34.0, 5] },
          },
        ],
      }),
    });

    const signals = await usgsAdapter.collect();
    expect(signals.length).toBeGreaterThanOrEqual(2); // count + M5+ event

    // Count signal
    const count = signals.find((s) => s.key === "quakes_5plus");
    expect(count).toBeDefined();
    expect(count!.signalType).toBe("numeric");
    expect(count!.valueNumeric).toBe(1); // only 1 quake >= 5

    // Event signal (M5.2 quake)
    const event = signals.find((s) => s.key.startsWith("quake_us7000abc"));
    expect(event).toBeDefined();
    expect(event!.signalType).toBe("event");
    expect(event!.valueNumeric).toBe(5.2);
    expect(event!.geoLat).toBe(35.7);
    expect(event!.geoLon).toBe(139.8);
    expect(event!.contentHash).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// NWS-specific
// ---------------------------------------------------------------------------

describe("nws adapter", () => {
  beforeEach(() => mockFetch.mockReset());

  it("produces warning count + alert signals", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        features: [
          {
            id: "urn:oid:2.49.0.1.840.0.alert1",
            properties: {
              event: "Tornado Warning",
              severity: "Extreme",
              certainty: "Observed",
              urgency: "Immediate",
              headline: "Tornado Warning for Dallas County",
              description: "...",
              onset: "2026-04-03T15:00:00-05:00",
              expires: "2026-04-03T16:00:00-05:00",
              areaDesc: "Dallas County, TX",
            },
          },
          {
            id: "urn:oid:2.49.0.1.840.0.alert2",
            properties: {
              event: "Wind Advisory",
              severity: "Minor",
              certainty: "Likely",
              urgency: "Expected",
              headline: "Wind Advisory for Cook County",
              description: "...",
              onset: "2026-04-03T12:00:00-05:00",
              expires: "2026-04-03T18:00:00-05:00",
              areaDesc: "Cook County, IL",
            },
          },
        ],
      }),
    });

    const signals = await nwsAdapter.collect();
    const count = signals.find((s) => s.key === "active_warnings");
    expect(count).toBeDefined();
    expect(count!.valueNumeric).toBe(1); // only Extreme/Severe count

    const alert = signals.find((s) => s.signalType === "alert");
    expect(alert).toBeDefined();
    expect(alert!.valueText).toContain("Tornado");
  });
});

// ---------------------------------------------------------------------------
// Frankfurter-specific
// ---------------------------------------------------------------------------

describe("frankfurter adapter", () => {
  beforeEach(() => mockFetch.mockReset());

  it("produces one signal per currency pair", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        base: "USD",
        date: "2026-04-03",
        rates: { MXN: 17.25, EUR: 0.92, GBP: 0.79 },
      }),
    });

    const signals = await frankfurterAdapter.collect();
    expect(signals).toHaveLength(3);

    const mxn = signals.find((s) => s.key === "MXN");
    expect(mxn).toBeDefined();
    expect(mxn!.valueNumeric).toBe(17.25);
    expect(mxn!.source).toBe("frankfurter");
    expect(mxn!.domain).toBe("financial");
  });
});

// ---------------------------------------------------------------------------
// GDELT-specific
// ---------------------------------------------------------------------------

describe("gdelt adapter", () => {
  beforeEach(() => mockFetch.mockReset());

  it("produces article count + individual article signals", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        articles: [
          {
            url: "https://example.com/article1",
            title: "Conflict in Region X",
            seendate: "20260403T120000Z",
            domain: "example.com",
            language: "English",
            sourcecountry: "US",
          },
        ],
      }),
    });

    const signals = await gdeltAdapter.collect();
    const count = signals.find((s) => s.key === "conflict_articles");
    expect(count).toBeDefined();
    expect(count!.valueNumeric).toBe(1);

    const article = signals.find((s) => s.signalType === "article");
    expect(article).toBeDefined();
    expect(article!.valueText).toContain("Conflict");
  });

  // GDELT answers an unparenthesized OR query with HTTP 200 and a plain-text
  // error, which left the source at 0 signals from 2026-08-18 to 2026-09-21.
  it("parenthesizes the OR'd query terms", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
    await gdeltAdapter.collect();
    const url = decodeURIComponent(String(mockFetch.mock.calls[0][0]));
    expect(url).toContain("query=(conflict OR crisis OR sanctions)&");
  });
});

// ---------------------------------------------------------------------------
// CISA KEV-specific
// ---------------------------------------------------------------------------

describe("cisa-kev adapter", () => {
  beforeEach(() => mockFetch.mockReset());

  it("produces vuln count + individual CVE signals", async () => {
    const today = new Date().toISOString().slice(0, 10);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        title: "CISA KEV Catalog",
        catalogVersion: "2026.04.03",
        dateReleased: today,
        count: 1200,
        vulnerabilities: [
          {
            cveID: "CVE-2026-1234",
            vendorProject: "Apache",
            product: "Struts",
            vulnerabilityName: "RCE in Struts",
            dateAdded: today,
            shortDescription: "Remote code execution vulnerability",
            requiredAction: "Apply update",
            dueDate: "2026-04-10",
            knownRansomwareCampaignUse: "Known",
          },
        ],
      }),
    });

    const signals = await cisaKevAdapter.collect();
    const count = signals.find((s) => s.key === "new_vulns");
    expect(count).toBeDefined();
    expect(count!.valueNumeric).toBeGreaterThanOrEqual(1);

    const cve = signals.find((s) => s.key === "CVE-2026-1234");
    expect(cve).toBeDefined();
    expect(cve!.signalType).toBe("alert");
    expect(cve!.metadata).toHaveProperty("ransomware");
  });
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// CoinGecko-specific
// ---------------------------------------------------------------------------

describe("coingecko adapter", () => {
  beforeEach(() => mockFetch.mockReset());

  it("produces one signal per crypto", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        bitcoin: { usd: 67500, usd_24h_change: 2.1 },
        ethereum: { usd: 3200, usd_24h_change: -0.5 },
      }),
    });

    const signals = await coingeckoAdapter.collect();
    expect(signals).toHaveLength(2);
    const btc = signals.find((s) => s.key === "bitcoin");
    expect(btc).toBeDefined();
    expect(btc!.valueNumeric).toBe(67500);
    expect(btc!.domain).toBe("financial");
  });
});

// ---------------------------------------------------------------------------
// Treasury-specific
// ---------------------------------------------------------------------------

describe("treasury adapter", () => {
  beforeEach(() => mockFetch.mockReset());

  it("extracts 10Y Treasury Note rate", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            record_date: "2026-04-02",
            avg_interest_rate_amt: "4.250",
            security_desc: "Treasury Notes",
          },
        ],
      }),
    });

    const signals = await treasuryAdapter.collect();
    expect(signals).toHaveLength(1);
    expect(signals[0].key).toBe("10Y");
    expect(signals[0].valueNumeric).toBe(4.25);
  });
});

// ---------------------------------------------------------------------------
// Google News-specific
// ---------------------------------------------------------------------------

describe("google-news adapter", () => {
  beforeEach(() => mockFetch.mockReset());

  const xmlResponse = (body: string | Uint8Array, contentType?: string) =>
    new Response(body, {
      headers: contentType ? { "content-type": contentType } : {},
    });
  const item = (n: number, pubDate = "Fri, 25 Sep 2026 13:53:48 GMT") =>
    `<item><title>Headline ${n} &amp; more - Outlet</title><link>https://news.google.com/rss/articles/A${n}?oc=5</link><guid isPermaLink="false">A${n}</guid><pubDate>${pubDate}</pubDate><description>&lt;a href="https://news.google.com/rss/articles/A${n}?oc=5" target="_blank"&gt;Headline ${n}&lt;/a&gt;&amp;nbsp;&amp;nbsp;&lt;font color="#6f6f6f"&gt;Outlet&lt;/font&gt;</description><source url="https://outlet.example">Outlet</source></item>`;
  const feed = (items: string) =>
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>"breaking OR crisis OR emergency" - Google News</title><link>https://news.google.com/search</link><description>Google News</description>${items}</channel></rss>`;

  it("fetches the Google feed directly, not through a proxy", async () => {
    mockFetch.mockResolvedValue(xmlResponse(feed(item(1))));
    await googleNewsAdapter.collect();
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(
      "https://news.google.com/rss/search?q=breaking+OR+crisis+OR+emergency&hl=en-US&gl=US&ceid=US:en",
    );
    expect(init.headers.Accept).toContain("application/rss+xml");
  });

  // Same Signal the rss2json path produced for this item (rss2json handed
  // back the decoded title/link/description; pubDate is now the feed's own
  // RFC 822 string, so the timestamp no longer depends on the host TZ).
  it("produces the same article signal as the rss2json path", async () => {
    mockFetch.mockResolvedValue(xmlResponse(feed(item(1))));
    const signals = await googleNewsAdapter.collect();
    expect(signals).toEqual([
      {
        source: "google_news",
        domain: "news",
        signalType: "article",
        key: "news_article",
        valueText: "Headline 1 & more - Outlet",
        contentHash: contentHash(
          "https://news.google.com/rss/articles/A1?oc=5",
        ),
        sourceTimestamp: "2026-09-25T13:53:48.000Z",
        metadata: {
          url: "https://news.google.com/rss/articles/A1?oc=5",
          description:
            '<a href="https://news.google.com/rss/articles/A1?oc=5" target="_blank">Headline 1</a>&nbsp;&nbsp;<font color="#6f6f6f">Outlet</font>',
        },
      },
    ]);
  });

  it("caps at 10 articles, trims descriptions to 200 chars, tolerates a bad date", async () => {
    const items = Array.from({ length: 12 }, (_, i) =>
      item(i, i === 0 ? "not a date" : undefined),
    ).join("");
    const long = `<item><title>L</title><link>https://x.example/l</link><description>${"d".repeat(500)}</description></item>`;
    mockFetch.mockResolvedValue(xmlResponse(feed(items + long)));
    const signals = await googleNewsAdapter.collect();
    expect(signals).toHaveLength(10);
    expect(signals[0].sourceTimestamp).toBeUndefined();

    mockFetch.mockResolvedValue(xmlResponse(feed(long)));
    const [one] = await googleNewsAdapter.collect();
    expect((one.metadata as { description: string }).description).toHaveLength(
      200,
    );
    expect(one.sourceTimestamp).toBeUndefined();
  });

  it("decodes a non-UTF-8 feed by its declared charset", async () => {
    // "Café España" in ISO-8859-1: é = 0xE9, ñ = 0xF1
    const latin1 = Uint8Array.from(
      Buffer.from(
        feed(
          "<item><title>Caf\u00e9 Espa\u00f1a</title><link>https://x.example/1</link></item>",
        ).replace('encoding="UTF-8"', 'encoding="ISO-8859-1"'),
        "latin1",
      ),
    );
    mockFetch.mockResolvedValue(xmlResponse(latin1));
    const [signal] = await googleNewsAdapter.collect();
    expect(signal.valueText).toBe("Café España");
  });

  it("throws on a 200 that is an HTML page, not a feed", async () => {
    mockFetch.mockResolvedValue(
      xmlResponse("<!DOCTYPE html>\n<html><body>Sorry…</body></html>"),
    );
    await expect(googleNewsAdapter.collect()).rejects.toThrow(
      "not an RSS/Atom feed — <!DOCTYPE html> <html><body>Sorry…",
    );
  });

  it("refuses a body over the 5 MB feed cap", async () => {
    mockFetch.mockResolvedValue(
      new Response(feed(item(1)), {
        headers: { "content-length": String(6 * 1024 * 1024) },
      }),
    );
    await expect(googleNewsAdapter.collect()).rejects.toThrow(
      "feed larger than 5242880 bytes",
    );
  });

  it("throws on a feed with no items", async () => {
    mockFetch.mockResolvedValue(xmlResponse(feed("")));
    await expect(googleNewsAdapter.collect()).rejects.toThrow(
      "feed has no items",
    );
  });
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe("adapter registry", () => {
  it("returns all 8 adapters", () => {
    const adapters = getAllAdapters();
    expect(adapters).toHaveLength(8);
    const sources = adapters.map((a) => a.source);
    expect(sources).toContain("usgs");
    expect(sources).toContain("nws");
    expect(sources).toContain("gdelt");
    expect(sources).toContain("frankfurter");
    expect(sources).toContain("cisa_kev");
    expect(sources).toContain("coingecko");
    expect(sources).toContain("treasury");
    expect(sources).toContain("google_news");
  });
});
