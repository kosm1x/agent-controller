import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../lib/url-safety.js", () => ({
  validateOutboundUrl: vi.fn(),
}));

vi.mock("../../google/auth.js", () => ({
  getAccessToken: vi.fn(),
}));

const mockDbRun = vi.fn().mockReturnValue({ lastInsertRowid: 1 });
const mockDbPrepare = vi.fn().mockReturnValue({ run: mockDbRun });
vi.mock("../../db/index.js", () => ({
  getDatabase: () => ({ prepare: mockDbPrepare }),
  writeWithRetry: (fn: () => unknown) => fn(),
}));

import { seoTelemetryTool, _testonly } from "./seo-telemetry.js";
import { getAccessToken } from "../../google/auth.js";

beforeEach(() => {
  vi.restoreAllMocks();
  mockDbRun.mockReturnValue({ lastInsertRowid: 1 });
  mockDbPrepare.mockReturnValue({ run: mockDbRun });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("dateOffset", () => {
  it("returns YYYY-MM-DD format", () => {
    const d = _testonly.dateOffset(-1);
    expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("seo_telemetry — PSI engine", () => {
  it("parses Lighthouse response into flat fields", async () => {
    const psiResponse = {
      lighthouseResult: {
        categories: {
          performance: { score: 0.85 },
          seo: { score: 0.92 },
          accessibility: { score: 0.78 },
          "best-practices": { score: 0.9 },
        },
        audits: {
          "largest-contentful-paint": { numericValue: 2100 },
          "interaction-to-next-paint": { numericValue: 180 },
          "cumulative-layout-shift": { numericValue: 0.05 },
          "first-contentful-paint": { numericValue: 900 },
          "server-response-time": { numericValue: 240 },
        },
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify(psiResponse), { status: 200 }),
      ),
    );
    const r = await _testonly.fetchPsi("https://example.com", "mobile");
    expect(r.perf_score).toBe(85);
    expect(r.seo_score).toBe(92);
    expect(r.lcp_ms).toBe(2100);
    expect(r.inp_ms).toBe(180);
    expect(r.cls).toBe(0.05);
  });

  it("returns error field on HTTP failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("429", { status: 429 })),
    );
    const r = await _testonly.fetchPsi("https://example.com", "mobile");
    expect(r.error).toBe("HTTP 429");
  });
});

describe("seo_telemetry — GSC engine", () => {
  it("returns auth error when getAccessToken throws", async () => {
    vi.mocked(getAccessToken).mockRejectedValue(new Error("No refresh token"));
    const r = await _testonly.fetchGsc("https://example.com/page");
    expect(r.error).toMatch(/auth unavailable/i);
    expect(r.total_clicks).toBe(0);
  });

  it("returns 403 error with actionable hint when site not verified", async () => {
    vi.mocked(getAccessToken).mockResolvedValue("fake-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("forbidden", { status: 403 })),
    );
    const r = await _testonly.fetchGsc("https://example.com/");
    expect(r.error).toContain("HTTP 403");
    expect(r.error).toContain("webmasters.readonly");
  });

  it("aggregates rows into totals + top_queries", async () => {
    vi.mocked(getAccessToken).mockResolvedValue("fake-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              rows: [
                {
                  keys: ["claude code", "https://example.com/"],
                  clicks: 50,
                  impressions: 1000,
                  ctr: 0.05,
                  position: 3.2,
                },
                {
                  keys: ["jarvis", "https://example.com/blog"],
                  clicks: 30,
                  impressions: 800,
                  ctr: 0.0375,
                  position: 5.1,
                },
              ],
            }),
            { status: 200 },
          ),
      ),
    );
    const r = await _testonly.fetchGsc("https://example.com/");
    expect(r.total_clicks).toBe(80);
    expect(r.total_impressions).toBe(1800);
    expect(r.top_queries).toHaveLength(2);
    expect(r.top_queries[0].query).toBe("claude code");
  });
});

describe("seo_telemetry — graceful degradation", () => {
  it("returns PSI result even when GSC auth fails", async () => {
    vi.mocked(getAccessToken).mockRejectedValue(new Error("No token"));
    let fetchCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        fetchCalls++;
        return new Response(
          JSON.stringify({
            lighthouseResult: {
              categories: { performance: { score: 0.5 } },
              audits: {},
            },
          }),
          { status: 200 },
        );
      }),
    );
    const raw = await seoTelemetryTool.execute({
      url: "https://example.com/",
    });
    const out = JSON.parse(raw);
    expect(out.psi).toBeDefined();
    expect(out.gsc.error).toBeDefined();
    expect(fetchCalls).toBe(2); // mobile + desktop (GSC never fires because auth failed first)
  });

  it("rejects empty url parameter", async () => {
    const raw = await seoTelemetryTool.execute({});
    expect(raw).toContain("url parameter is required");
  });

  it("rejects SSRF-unsafe URLs when validateOutboundUrl returns an error", async () => {
    const { validateOutboundUrl } = await import("../../lib/url-safety.js");
    vi.mocked(validateOutboundUrl).mockReturnValueOnce(
      "Blocked private/reserved IP: 127.0.0.1",
    );
    const raw = await seoTelemetryTool.execute({
      url: "http://127.0.0.1/",
    });
    expect(raw).toContain("URL rejected");
    expect(raw).toContain("127.0.0.1");
  });
});
