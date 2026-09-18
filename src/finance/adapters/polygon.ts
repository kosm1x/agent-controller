/**
 * Polygon.io / Massive adapter — finance fallback data provider.
 *
 * Free tier: 5 req/min, 2y historical, REST. Rate limiter ceiling: 4/min (80%).
 * Host: api.massive.com (primary, post-2026 rebrand). Legacy alias api.polygon.io.
 *
 * Scope: daily + intraday + weekly (2026-09-18: weekly had stayed on Alpha
 * Vantage after the 07-14 cutover and nothing refreshed it). No FX (AV handles
 * that). No macro (FRED only).
 * F10 will add WebSocket real-time for crypto.
 */

import { getConfig } from "../../config.js";
import {
  RateLimitedError,
  redactApiKeys,
  type IntradayInterval,
  type MarketBar,
  type MarketDataAdapter,
  type FetchOpts,
} from "../types.js";
import { fromAlphaVantageDaily, fromPolygonUnixMs } from "../timezone.js";
import { toNyDate } from "../market-calendar.js";
import { weekEndKey } from "../weekly-periods.js";
import { canCall, recordCall } from "../rate-limit.js";
import { recordBudget } from "../budget.js";
import { errMsg } from "../../lib/err-msg.js";

interface PolygonAggResponse {
  ticker?: string;
  resultsCount?: number;
  results?: PolygonAggBar[];
  status?: string;
  next_url?: string;
  error?: string;
  message?: string;
}

interface PolygonAggBar {
  v: number; // volume
  o: number; // open
  h: number; // high
  l: number; // low
  c: number; // close
  t: number; // unix ms UTC
  n?: number; // trade count
}

/** Weeks one weekly call returns: the free tier clamps any older `from` to 2y, silently. */
export const POLYGON_WEEKLY_MAX_BARS = 104;

export class PolygonAdapter implements MarketDataAdapter {
  readonly provider = "polygon" as const;

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (!apiKey) {
      throw new Error("POLYGON_API_KEY is required for the Polygon adapter");
    }
  }

  static fromConfig(fetchImpl: typeof fetch = fetch): PolygonAdapter {
    const cfg = getConfig();
    if (!cfg.polygonApiKey) {
      throw new Error(
        "POLYGON_API_KEY is not set. Finance fallback requires this credential.",
      );
    }
    return new PolygonAdapter(cfg.polygonApiKey, cfg.polygonBaseUrl, fetchImpl);
  }

  async fetchDaily(symbol: string, opts: FetchOpts): Promise<MarketBar[]> {
    return this.fetchAggregates(symbol, 1, "day", opts.lookback, "daily");
  }

  /**
   * Week bars arrive stamped Sunday 00:00 ET for the Mon–Fri that FOLLOWS
   * (verified live 2026-09-18: the 04-12 bar closes at AV's Fri 04-17 close).
   * They are re-keyed to that Friday's 16:00 ET close — the key AV weekly rows
   * carry — and the week still in progress is dropped: `INSERT OR IGNORE`
   * would freeze a partial bar under the finished week's key.
   *
   * Always FETCHES the full window, whatever `lookback` asks for — it is one
   * call either way; the data layer asks for all of it, so older gaps heal and
   * a post-split re-basing replaces every stored week at once.
   */
  async fetchWeekly(symbol: string, opts: FetchOpts): Promise<MarketBar[]> {
    const raw = await this.fetchAggregates(
      symbol,
      1,
      "week",
      POLYGON_WEEKLY_MAX_BARS + 2,
      "weekly",
    );
    const today = toNyDate(new Date());
    const bars: MarketBar[] = [];
    for (const b of raw) {
      const monday = new Date(b.timestamp.slice(0, 10) + "T12:00:00Z");
      monday.setUTCDate(monday.getUTCDate() + 1);
      const week = weekEndKey(monday.toISOString());
      if (week >= today) continue;
      bars.push({ ...b, timestamp: fromAlphaVantageDaily(week) });
    }
    return bars.slice(-opts.lookback);
  }

  async fetchIntraday(
    symbol: string,
    interval: IntradayInterval,
    opts: FetchOpts,
  ): Promise<MarketBar[]> {
    const [multiplier, timespan] = mapInterval(interval);
    return this.fetchAggregates(
      symbol,
      multiplier,
      timespan,
      opts.lookback,
      interval,
    );
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async fetchAggregates(
    symbol: string,
    multiplier: number,
    timespan: string,
    lookback: number,
    interval: "daily" | "weekly" | IntradayInterval,
  ): Promise<MarketBar[]> {
    if (!canCall("polygon")) {
      throw new RateLimitedError("polygon");
    }
    const start = Date.now();
    recordCall("polygon");

    // Build window. `lookback` counts BARS (trading sessions), the URL takes
    // CALENDAR dates: ~252 sessions per 365 days, so a 1:1 window comes back
    // ~30 % short (lookback 40 → 33 bars → market_signals skipped every
    // symbol as "insufficient bars", 2026-09-17). ×1.5 + 7 covers weekends
    // and holiday clusters. An hour bar is 60 minutes, not `multiplier` (1).
    const now = new Date();
    const to = formatDate(now);
    const fromDate = new Date(now);
    const minutesPerBar = timespan === "hour" ? multiplier * 60 : multiplier;
    const sessionsNeeded =
      timespan === "day"
        ? lookback
        : Math.ceil((lookback * minutesPerBar) / 390);
    fromDate.setDate(
      fromDate.getDate() -
        (timespan === "week"
          ? lookback * 7
          : Math.ceil(sessionsNeeded * 1.5) + 7),
    );
    const from = formatDate(fromDate);

    // limit caps BASE aggregates (1-minute bars for hour / N-minute spans), not
    // returned bars — lookback + 50 yielded ~2 hour bars. 50000 is the maximum.
    const url =
      `${this.baseUrl}/aggs/ticker/${encodeURIComponent(symbol)}/range/` +
      `${multiplier}/${timespan}/${from}/${to}?adjusted=true&sort=desc&limit=50000` +
      `&apiKey=${encodeURIComponent(this.apiKey)}`;

    let res: Response;
    try {
      res = await this.fetchImpl(url);
    } catch (err) {
      recordBudget({
        provider: "polygon",
        endpoint: `aggs/${timespan}`,
        status: "error",
        responseTimeMs: Date.now() - start,
      });
      throw new Error(
        redactApiKeys(errMsg(err)),
      );
    }

    const responseTimeMs = Date.now() - start;

    if (res.status === 429) {
      recordBudget({
        provider: "polygon",
        endpoint: `aggs/${timespan}`,
        status: "rate_limited",
        responseTimeMs,
      });
      throw new RateLimitedError("polygon");
    }
    if (!res.ok) {
      recordBudget({
        provider: "polygon",
        endpoint: `aggs/${timespan}`,
        status: "error",
        responseTimeMs,
      });
      throw new Error(
        redactApiKeys(`Polygon ${res.status}: ${await res.text()}`),
      );
    }

    // W4: wrap JSON parse so parse errors still record a budget row
    let body: PolygonAggResponse;
    try {
      body = (await res.json()) as PolygonAggResponse;
    } catch (err) {
      recordBudget({
        provider: "polygon",
        endpoint: `aggs/${timespan}`,
        status: "error",
        responseTimeMs,
      });
      throw new Error(
        `Polygon: unparseable JSON (${err instanceof Error ? err.message : "unknown"})`,
      );
    }
    if (body.status === "ERROR" || body.error) {
      recordBudget({
        provider: "polygon",
        endpoint: `aggs/${timespan}`,
        status: "error",
        responseTimeMs,
      });
      throw new Error(
        redactApiKeys(`Polygon: ${body.error ?? body.message ?? "unknown"}`),
      );
    }

    recordBudget({
      provider: "polygon",
      endpoint: `aggs/${timespan}`,
      status: "success",
      responseTimeMs,
    });

    // Requested newest-first (a capped response then loses the OLDEST bars,
    // never the newest — williams-entry-radar 2026-W37); callers want ascending.
    const results = (body.results ?? [])
      .slice()
      .sort((a, b) => a.t - b.t)
      .slice(-lookback);
    return results.map((r) => ({
      symbol,
      timestamp: fromPolygonUnixMs(r.t),
      open: r.o,
      high: r.h,
      low: r.l,
      close: r.c,
      volume: Math.round(r.v),
      provider: this.provider,
      interval,
    }));
  }
}

function mapInterval(interval: IntradayInterval): [number, string] {
  switch (interval) {
    case "1min":
      return [1, "minute"];
    case "5min":
      return [5, "minute"];
    case "15min":
      return [15, "minute"];
    case "60min":
      return [1, "hour"];
  }
}

function formatDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
