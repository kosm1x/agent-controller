/**
 * seo_telemetry snapshot write on the real `seo_telemetry_snapshots` table.
 *
 * seo-telemetry.test.ts stubs `prepare`, so it never runs the INSERT. The
 * write swallows its own errors (the tool must still answer), so a wrong
 * column would show only as a missing row and a missing `snapshot_id`: the
 * cases read the row back. URL checks, OAuth and `fetch` are stubbed; the
 * `fetch` stub answers only the two API endpoints and throws on anything
 * else, and OAuth rejects unless a case answers it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";

vi.mock("../../lib/url-safety.js", () => ({
  validateOutboundUrl: vi.fn(() => null),
  validateOutboundUrlResolved: vi.fn(async () => null),
}));

vi.mock("../../google/auth.js", () => ({
  getAccessToken: vi.fn(async () => {
    throw new Error("unexpected getAccessToken call");
  }),
}));

import { closeDatabase, initDatabase } from "../../db/index.js";
import { getAccessToken } from "../../google/auth.js";
import { seoTelemetryTool } from "./seo-telemetry.js";

const PSI_BODY = {
  lighthouseResult: {
    categories: {
      performance: { score: 0.81 },
      seo: { score: 0.93 },
    },
    audits: {
      "largest-contentful-paint": { numericValue: 2400 },
      "interaction-to-next-paint": { numericValue: 150 },
      "cumulative-layout-shift": { numericValue: 0.042 },
    },
  },
};

const GSC_BODY = {
  rows: [
    {
      keys: ["synthetic query a", "https://site.example/"],
      clicks: 40,
      impressions: 1000,
      ctr: 0.04,
      position: 2.5,
    },
    {
      keys: ["synthetic query b", "https://site.example/b"],
      clicks: 10,
      impressions: 1000,
      ctr: 0.01,
      position: 7.5,
    },
  ],
};

/** Answers only the PageSpeed and Search Console endpoints. */
function stubApis(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("https://www.googleapis.com/pagespeedonline/")) {
        return new Response(JSON.stringify(PSI_BODY), { status: 200 });
      }
      if (url.startsWith("https://searchconsole.googleapis.com/")) {
        return new Response(JSON.stringify(GSC_BODY), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function rows(): Array<Record<string, unknown>> {
  return db
    .prepare("SELECT * FROM seo_telemetry_snapshots ORDER BY id")
    .all() as Array<Record<string, unknown>>;
}

describe("seo_telemetry persists a snapshot", () => {
  it("writes the mobile PageSpeed figures, the Search Console totals and the raw output, and returns the row id", async () => {
    vi.mocked(getAccessToken).mockResolvedValueOnce("synthetic-token");
    stubApis();

    const out = JSON.parse(
      await seoTelemetryTool.execute({ url: "https://site.example/" }),
    );

    const written = rows();
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      url: "https://site.example/",
      psi_lcp_ms: 2400,
      psi_inp_ms: 150,
      psi_cls: 0.042,
      psi_perf_score: 81,
      psi_seo_score: 93,
      gsc_clicks_28d: 50,
      gsc_impressions_28d: 2000,
      gsc_ctr_28d: 0.025,
    });
    expect(
      (JSON.parse(written[0].gsc_top_queries as string) as Array<{ query: string }>).map(
        (q) => q.query,
      ),
    ).toEqual(["synthetic query a", "synthetic query b"]);
    const raw = JSON.parse(written[0].raw as string);
    expect(raw.url).toBe("https://site.example/");
    expect(raw.psi.mobile.perf_score).toBe(81);
    expect(written[0].captured_at).toEqual(expect.any(String));
    expect(out.snapshot_id).toBe(written[0].id);
  });

  it("writes nulls for an engine that was not requested", async () => {
    stubApis();

    const out = JSON.parse(
      await seoTelemetryTool.execute({
        url: "https://site.example/",
        include: ["psi"],
      }),
    );

    const written = rows();
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      url: "https://site.example/",
      psi_perf_score: 81,
      gsc_clicks_28d: null,
      gsc_impressions_28d: null,
      gsc_ctr_28d: null,
      gsc_top_queries: null,
    });
    expect(out.snapshot_id).toBe(written[0].id);
  });
});
