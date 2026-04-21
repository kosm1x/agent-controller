/**
 * seo_telemetry — unified performance + search telemetry for a URL.
 *
 * Two independent engines, each graceful-degrades:
 *   1. PageSpeed Insights (public API, GOOGLE_PAGESPEED_KEY optional)
 *      → Core Web Vitals (LCP/INP/CLS) + Lighthouse scores (perf/seo/a11y/best).
 *   2. Google Search Console (OAuth via existing getAccessToken())
 *      → 28-day query-level clicks/impressions/CTR/position, top 100 by clicks.
 *
 * Persists a snapshot to `seo_telemetry_snapshots` for time-series tracking.
 * Part of v7.3 Phase 2.
 */

import type { Tool } from "../types.js";
import { getDatabase, writeWithRetry } from "../../db/index.js";
import { validateOutboundUrl } from "../../lib/url-safety.js";
import { getAccessToken } from "../../google/auth.js";

const PSI_URL = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
const GSC_URL = "https://searchconsole.googleapis.com/webmasters/v3";
const FETCH_TIMEOUT_MS = 30_000;

interface PSIResult {
  strategy: "mobile" | "desktop";
  perf_score?: number;
  seo_score?: number;
  accessibility_score?: number;
  best_practices_score?: number;
  lcp_ms?: number;
  inp_ms?: number;
  cls?: number;
  fcp_ms?: number;
  ttfb_ms?: number;
  error?: string;
}

interface GSCQueryRow {
  query: string;
  page?: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

interface GSCResult {
  site_url: string;
  start_date: string;
  end_date: string;
  total_clicks: number;
  total_impressions: number;
  avg_ctr: number;
  avg_position: number;
  top_queries: GSCQueryRow[];
  error?: string;
}

async function fetchPsi(
  url: string,
  strategy: "mobile" | "desktop",
): Promise<PSIResult> {
  const key = process.env.GOOGLE_PAGESPEED_KEY ?? "";
  const params = new URLSearchParams({ url, strategy });
  if (key) params.set("key", key);
  const result: PSIResult = { strategy };
  try {
    const res = await fetch(`${PSI_URL}?${params}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      result.error = `HTTP ${res.status}`;
      return result;
    }
    const data = (await res.json()) as {
      lighthouseResult?: {
        categories?: Record<string, { score?: number }>;
        audits?: Record<string, { numericValue?: number }>;
      };
    };
    const cats = data.lighthouseResult?.categories ?? {};
    const audits = data.lighthouseResult?.audits ?? {};
    const pct = (v?: number) =>
      typeof v === "number" ? Math.round(v * 100) : undefined;
    result.perf_score = pct(cats.performance?.score);
    result.seo_score = pct(cats.seo?.score);
    result.accessibility_score = pct(cats.accessibility?.score);
    result.best_practices_score = pct(cats["best-practices"]?.score);
    result.lcp_ms = Math.round(
      audits["largest-contentful-paint"]?.numericValue ?? 0,
    );
    result.inp_ms = Math.round(
      audits["interaction-to-next-paint"]?.numericValue ?? 0,
    );
    result.cls =
      audits["cumulative-layout-shift"]?.numericValue !== undefined
        ? Math.round(audits["cumulative-layout-shift"]!.numericValue! * 1000) /
          1000
        : undefined;
    result.fcp_ms = Math.round(
      audits["first-contentful-paint"]?.numericValue ?? 0,
    );
    result.ttfb_ms = Math.round(
      audits["server-response-time"]?.numericValue ?? 0,
    );
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }
  return result;
}

/**
 * Format a YYYY-MM-DD date offset from today in Pacific time (GSC's reporting
 * timezone). Using UTC (or the service's local TZ, America/Mexico_City) can
 * surface partial "today" data for queries issued late in the day.
 */
function dateOffset(days: number): string {
  const now = Date.now() + days * 24 * 3600 * 1000;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(new Date(now));
}

async function fetchGsc(
  url: string,
  siteUrlOverride?: string,
): Promise<GSCResult> {
  // Default: URL-property form ({origin}/). Operators with a GSC Domain
  // property (sc-domain:example.com) must pass that string explicitly as
  // site_url — Domain properties have no protocol/host form we could derive.
  const siteUrl = siteUrlOverride ?? `${new URL(url).origin}/`;
  const startDate = dateOffset(-28);
  const endDate = dateOffset(-1);
  const result: GSCResult = {
    site_url: siteUrl,
    start_date: startDate,
    end_date: endDate,
    total_clicks: 0,
    total_impressions: 0,
    avg_ctr: 0,
    avg_position: 0,
    top_queries: [],
  };
  let token: string;
  try {
    token = await getAccessToken();
  } catch (err) {
    result.error = `GSC auth unavailable: ${err instanceof Error ? err.message : err}`;
    return result;
  }
  try {
    const endpoint = `${GSC_URL}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        startDate,
        endDate,
        dimensions: ["query", "page"],
        rowLimit: 100,
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      result.error = `HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`;
      if (res.status === 403) {
        result.error +=
          " (check that webmasters.readonly scope is granted and the site is verified in GSC)";
      }
      return result;
    }
    const data = (await res.json()) as {
      rows?: Array<{
        keys: string[];
        clicks: number;
        impressions: number;
        ctr: number;
        position: number;
      }>;
    };
    const rows = data.rows ?? [];
    for (const r of rows) {
      result.total_clicks += r.clicks;
      result.total_impressions += r.impressions;
    }
    if (result.total_impressions > 0) {
      result.avg_ctr =
        Math.round((result.total_clicks / result.total_impressions) * 10000) /
        10000;
    }
    if (rows.length > 0) {
      result.avg_position =
        Math.round(
          (rows.reduce((s, r) => s + r.position, 0) / rows.length) * 100,
        ) / 100;
    }
    result.top_queries = rows.slice(0, 25).map((r) => ({
      query: r.keys[0],
      page: r.keys[1],
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: Math.round(r.ctr * 10000) / 10000,
      position: Math.round(r.position * 100) / 100,
    }));
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }
  return result;
}

function persistSnapshot(
  url: string,
  psi: PSIResult | undefined,
  gsc: GSCResult | undefined,
  raw: unknown,
): number | null {
  try {
    return writeWithRetry(() => {
      const db = getDatabase();
      const info = db
        .prepare(
          `INSERT INTO seo_telemetry_snapshots
             (url, psi_lcp_ms, psi_inp_ms, psi_cls, psi_perf_score, psi_seo_score,
              gsc_clicks_28d, gsc_impressions_28d, gsc_ctr_28d, gsc_top_queries, raw)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          url,
          psi?.lcp_ms ?? null,
          psi?.inp_ms ?? null,
          psi?.cls ?? null,
          psi?.perf_score ?? null,
          psi?.seo_score ?? null,
          gsc?.total_clicks ?? null,
          gsc?.total_impressions ?? null,
          gsc?.avg_ctr ?? null,
          gsc ? JSON.stringify(gsc.top_queries.slice(0, 10)) : null,
          JSON.stringify(raw),
        );
      return typeof info.lastInsertRowid === "bigint"
        ? Number(info.lastInsertRowid)
        : (info.lastInsertRowid as number);
    });
  } catch (err) {
    console.warn(
      `[seo_telemetry] persist failed: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}

export const seoTelemetryTool: Tool = {
  name: "seo_telemetry",
  deferred: true,
  riskTier: "low",
  definition: {
    type: "function",
    function: {
      name: "seo_telemetry",
      description: `Fetch SEO performance + search telemetry for a URL. Combines PageSpeed Insights (Core Web Vitals, Lighthouse scores) + Google Search Console (28-day clicks / impressions / CTR / position per query).

USE WHEN: user asks "pagespeed for…", "core web vitals", "how's my page performing", "search console data", "why isn't X ranking", "lighthouse score".

DEGRADES GRACEFULLY: if PSI fails (network / rate limit), returns just GSC. If GSC fails (not OAuth'd, site not verified), returns just PSI. Both failures surface errors inline, not as a thrown exception.

NOT FOR: on-page audits (use seo_page_audit), keyword research (seo_keyword_research), or robots.txt (seo_robots_audit).`,
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description:
              "Full URL (https://…). Used for PSI; GSC queries the URL's origin.",
          },
          include: {
            type: "array",
            items: { type: "string", enum: ["psi", "gsc"] },
            description: "Which engines to run. Default: both.",
          },
          site_url: {
            type: "string",
            description:
              "Optional Search Console property identifier. Pass `sc-domain:example.com` for a GSC Domain property, or a URL form like `https://example.com/` for a URL property. When omitted, derived as `{origin}/` from the `url` argument (URL property only).",
          },
        },
        required: ["url"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const url = String(args.url ?? "").trim();
    if (!url) {
      return JSON.stringify({ error: "url parameter is required" });
    }
    const urlError = validateOutboundUrl(url);
    if (urlError) {
      return JSON.stringify({ error: `URL rejected: ${urlError}` });
    }
    const include = Array.isArray(args.include)
      ? (args.include as string[])
      : ["psi", "gsc"];
    const wantPsi = include.includes("psi");
    const wantGsc = include.includes("gsc");
    const siteUrlOverride =
      typeof args.site_url === "string" && args.site_url.trim()
        ? args.site_url.trim()
        : undefined;

    const out: Record<string, unknown> = { url };
    let psiMobile: PSIResult | undefined;
    let gsc: GSCResult | undefined;

    // Run PSI (mobile + desktop in parallel) and GSC concurrently.
    const tasks: Promise<unknown>[] = [];
    if (wantPsi) {
      tasks.push(
        Promise.all([fetchPsi(url, "mobile"), fetchPsi(url, "desktop")]).then(
          ([m, d]) => {
            psiMobile = m;
            out.psi = { mobile: m, desktop: d };
          },
        ),
      );
    }
    if (wantGsc) {
      tasks.push(
        fetchGsc(url, siteUrlOverride).then((g) => {
          gsc = g;
          out.gsc = g;
        }),
      );
    }
    await Promise.all(tasks);

    const snapshotId = persistSnapshot(url, psiMobile, gsc, out);
    if (snapshotId !== null) out.snapshot_id = snapshotId;
    return JSON.stringify(out);
  },
};

export const _testonly = { fetchPsi, fetchGsc, dateOffset };
