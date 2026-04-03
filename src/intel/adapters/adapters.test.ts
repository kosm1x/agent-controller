/**
 * Adapter contract tests — verify each adapter produces valid Signal[] shapes
 * and handles errors gracefully.
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

function testAdapterContract(adapter: CollectorAdapter): void {
  describe(`${adapter.source} adapter contract`, () => {
    beforeEach(() => {
      mockFetch.mockReset();
    });

    it("has required metadata", () => {
      expect(adapter.source).toBeTruthy();
      expect(adapter.domain).toBeTruthy();
      expect(adapter.defaultInterval).toBeGreaterThanOrEqual(0);
    });

    it("returns empty array on HTTP error", async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 500 });
      const signals = await adapter.collect();
      expect(signals).toEqual([]);
    });

    it("returns empty array on network error", async () => {
      mockFetch.mockRejectedValue(new Error("network error"));
      const signals = await adapter.collect();
      expect(signals).toEqual([]);
    });

    it("returns empty array on timeout", async () => {
      mockFetch.mockRejectedValue(new DOMException("aborted", "AbortError"));
      const signals = await adapter.collect();
      expect(signals).toEqual([]);
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
testAdapterContract(googleNewsAdapter);

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

  it("produces article signals from RSS feed", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        status: "ok",
        items: [
          {
            title: "Breaking: Major Event",
            link: "https://example.com/article1",
            pubDate: "2026-04-03T12:00:00Z",
            description: "Details of the event...",
          },
        ],
      }),
    });

    const signals = await googleNewsAdapter.collect();
    expect(signals).toHaveLength(1);
    expect(signals[0].signalType).toBe("article");
    expect(signals[0].valueText).toContain("Breaking");
    expect(signals[0].domain).toBe("news");
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
