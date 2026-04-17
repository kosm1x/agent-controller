/**
 * Alpha Vantage adapter — primary finance data provider.
 *
 * Premium tier $49.99/mo. 75 req/min. Rate limiter ceiling set to 60/min (80%).
 * Endpoints used:
 *   - TIME_SERIES_DAILY_ADJUSTED — daily OHLCV with split/div adjustment
 *   - TIME_SERIES_INTRADAY — 1/5/15/60 min bars
 *   - FX_DAILY — FX pair daily bars
 *   - GLOBAL_QUOTE — current snapshot
 *   - NEWS_SENTIMENT — ticker sentiment (25 cost units)
 *   - Macro: FEDERAL_FUNDS_RATE, TREASURY_YIELD, CPI, UNEMPLOYMENT, REAL_GDP, NONFARM_PAYROLL
 *
 * Timestamps normalized to America/New_York ISO via timezone.ts.
 */

import { getConfig } from "../../config.js";
import {
  RateLimitedError,
  redactApiKeys,
  type IntradayInterval,
  type MacroAdapter,
  type MacroPoint,
  type MarketBar,
  type MarketDataAdapter,
  type FetchOpts,
} from "../types.js";
import {
  fromAlphaVantageDaily,
  fromAlphaVantageIntraday,
} from "../timezone.js";
import { canCall, recordCall } from "../rate-limit.js";
import { recordBudget } from "../budget.js";

const BASE_URL = "https://www.alphavantage.co/query";

/**
 * The AV "Note" field signals premium-tier throttling; "Information" signals
 * free-tier throttling. Either way, treat as rate-limited.
 */
interface AvEnvelope {
  Note?: string;
  Information?: string;
  "Error Message"?: string;
}

export class AlphaVantageAdapter implements MarketDataAdapter, MacroAdapter {
  readonly provider = "alpha_vantage" as const;

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (!apiKey) {
      throw new Error(
        "ALPHAVANTAGE_API_KEY is required for the AlphaVantage adapter",
      );
    }
  }

  static fromConfig(fetchImpl: typeof fetch = fetch): AlphaVantageAdapter {
    const key = getConfig().alphaVantageApiKey;
    if (!key) {
      throw new Error(
        "ALPHAVANTAGE_API_KEY is not set. Finance tools require this credential.",
      );
    }
    return new AlphaVantageAdapter(key, fetchImpl);
  }

  async fetchDaily(symbol: string, opts: FetchOpts): Promise<MarketBar[]> {
    const outputSize = opts.lookback > 100 ? "full" : "compact";
    const body = await this.request<Record<string, unknown>>(
      "TIME_SERIES_DAILY_ADJUSTED",
      { symbol, outputsize: outputSize },
    );
    const series = body["Time Series (Daily)"] as
      | Record<string, Record<string, string>>
      | undefined;
    if (!series) {
      throw new Error(
        `AV daily: unexpected shape, keys=${Object.keys(body).join(",")}`,
      );
    }
    const entries = Object.entries(series)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .slice(-opts.lookback);
    return entries.map(([date, row]) => ({
      symbol,
      timestamp: fromAlphaVantageDaily(date),
      open: parseFloat(row["1. open"]),
      high: parseFloat(row["2. high"]),
      low: parseFloat(row["3. low"]),
      close: parseFloat(row["4. close"]),
      adjustedClose: parseFloat(row["5. adjusted close"]),
      volume: parseInt(row["6. volume"], 10),
      provider: this.provider,
      interval: "daily" as const,
    }));
  }

  async fetchIntraday(
    symbol: string,
    interval: IntradayInterval,
    opts: FetchOpts,
  ): Promise<MarketBar[]> {
    const outputSize = opts.lookback > 100 ? "full" : "compact";
    const body = await this.request<Record<string, unknown>>(
      "TIME_SERIES_INTRADAY",
      { symbol, interval, outputsize: outputSize },
    );
    const key = `Time Series (${interval})`;
    const series = body[key] as
      | Record<string, Record<string, string>>
      | undefined;
    if (!series) {
      throw new Error(`AV intraday: missing "${key}" in response`);
    }
    const entries = Object.entries(series)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .slice(-opts.lookback);
    return entries.map(([ts, row]) => ({
      symbol,
      timestamp: fromAlphaVantageIntraday(ts),
      open: parseFloat(row["1. open"]),
      high: parseFloat(row["2. high"]),
      low: parseFloat(row["3. low"]),
      close: parseFloat(row["4. close"]),
      volume: parseInt(row["5. volume"], 10),
      provider: this.provider,
      interval,
    }));
  }

  async fetchFxDaily(
    from: string,
    to: string,
    opts: FetchOpts,
  ): Promise<MarketBar[]> {
    const outputSize = opts.lookback > 100 ? "full" : "compact";
    const body = await this.request<Record<string, unknown>>("FX_DAILY", {
      from_symbol: from,
      to_symbol: to,
      outputsize: outputSize,
    });
    const series = body["Time Series FX (Daily)"] as
      | Record<string, Record<string, string>>
      | undefined;
    if (!series) {
      throw new Error(`AV FX daily: missing "Time Series FX (Daily)"`);
    }
    const entries = Object.entries(series)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .slice(-opts.lookback);
    const pair = `${from}${to}`;
    return entries.map(([date, row]) => ({
      symbol: pair,
      timestamp: fromAlphaVantageDaily(date),
      open: parseFloat(row["1. open"]),
      high: parseFloat(row["2. high"]),
      low: parseFloat(row["3. low"]),
      close: parseFloat(row["4. close"]),
      volume: 0, // FX has no volume on AV endpoint
      provider: this.provider,
      interval: "daily" as const,
    }));
  }

  async fetchQuote(symbol: string): Promise<MarketBar> {
    const body = await this.request<{
      "Global Quote"?: Record<string, string>;
    }>("GLOBAL_QUOTE", { symbol });
    const q = body["Global Quote"];
    if (!q || !q["01. symbol"]) {
      throw new Error(`AV quote: empty response for ${symbol}`);
    }
    return {
      symbol: q["01. symbol"],
      timestamp: fromAlphaVantageDaily(q["07. latest trading day"]),
      open: parseFloat(q["02. open"]),
      high: parseFloat(q["03. high"]),
      low: parseFloat(q["04. low"]),
      close: parseFloat(q["05. price"]),
      volume: parseInt(q["06. volume"], 10),
      provider: this.provider,
      interval: "daily",
    };
  }

  async fetchMacro(series: string): Promise<MacroPoint[]> {
    // Macro endpoints: each is its own function name on AV.
    // Operator preplan D4 uses canonical series IDs; map to AV function.
    const functionMap: Record<string, string> = {
      FEDFUNDS: "FEDERAL_FUNDS_RATE",
      CPI: "CPI",
      UNEMPLOYMENT: "UNEMPLOYMENT",
      NONFARM: "NONFARM_PAYROLL",
      GDP: "REAL_GDP",
      TREASURY_2Y: "TREASURY_YIELD",
      TREASURY_10Y: "TREASURY_YIELD",
    };
    const avFunction = functionMap[series] ?? series;
    const params: Record<string, string> = {};
    if (avFunction === "TREASURY_YIELD") {
      params.maturity = series === "TREASURY_2Y" ? "2year" : "10year";
    }
    const body = await this.request<{
      data?: { date: string; value: string }[];
    }>(avFunction, params);
    if (!body.data) {
      throw new Error(`AV macro ${avFunction}: missing data array`);
    }
    return body.data
      .filter((d) => d.value !== "." && !Number.isNaN(parseFloat(d.value)))
      .map((d) => ({
        series,
        date: d.date, // AV macro series are date-only, keep raw
        value: parseFloat(d.value),
        provider: this.provider,
      }));
  }

  async fetchNewsSentiment(
    tickers: string[],
    opts: { limit?: number } = {},
  ): Promise<Record<string, unknown>> {
    const params: Record<string, string> = {
      tickers: tickers.join(","),
      limit: String(opts.limit ?? 50),
    };
    // NEWS_SENTIMENT costs 25 units per AV pricing — track separately
    return await this.request("NEWS_SENTIMENT", params, { costUnits: 25 });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async request<T>(
    avFunction: string,
    params: Record<string, string>,
    opts: { costUnits?: number } = {},
  ): Promise<T> {
    if (!canCall("alpha_vantage")) {
      throw new RateLimitedError("alpha_vantage");
    }
    const start = Date.now();
    recordCall("alpha_vantage");

    const url = new URL(BASE_URL);
    url.searchParams.set("function", avFunction);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
    url.searchParams.set("apikey", this.apiKey);

    let res: Response;
    try {
      res = await this.fetchImpl(url.toString());
    } catch (err) {
      recordBudget({
        provider: "alpha_vantage",
        endpoint: avFunction,
        status: "error",
        responseTimeMs: Date.now() - start,
        costUnits: opts.costUnits,
      });
      throw new Error(
        redactApiKeys(err instanceof Error ? err.message : String(err)),
      );
    }

    const responseTimeMs = Date.now() - start;

    if (res.status === 429) {
      recordBudget({
        provider: "alpha_vantage",
        endpoint: avFunction,
        status: "rate_limited",
        responseTimeMs,
        costUnits: opts.costUnits,
      });
      throw new RateLimitedError("alpha_vantage");
    }
    if (!res.ok) {
      recordBudget({
        provider: "alpha_vantage",
        endpoint: avFunction,
        status: "error",
        responseTimeMs,
        costUnits: opts.costUnits,
      });
      throw new Error(
        redactApiKeys(`AV ${avFunction} ${res.status}: ${await res.text()}`),
      );
    }

    // W4: guard JSON parse so parse errors still record a budget row
    let body: T & AvEnvelope;
    try {
      body = (await res.json()) as T & AvEnvelope;
    } catch (err) {
      recordBudget({
        provider: "alpha_vantage",
        endpoint: avFunction,
        status: "error",
        responseTimeMs,
        costUnits: opts.costUnits,
      });
      throw new Error(
        `AV ${avFunction}: unparseable JSON (${err instanceof Error ? err.message : "unknown"})`,
      );
    }

    // AV signals throttling via Note / Information field with 200 OK
    if (body.Note || body.Information) {
      recordBudget({
        provider: "alpha_vantage",
        endpoint: avFunction,
        status: "rate_limited",
        responseTimeMs,
        costUnits: opts.costUnits,
      });
      throw new RateLimitedError("alpha_vantage");
    }
    if (body["Error Message"]) {
      recordBudget({
        provider: "alpha_vantage",
        endpoint: avFunction,
        status: "error",
        responseTimeMs,
        costUnits: opts.costUnits,
      });
      throw new Error(`AV ${avFunction}: ${body["Error Message"]}`);
    }

    recordBudget({
      provider: "alpha_vantage",
      endpoint: avFunction,
      status: "success",
      responseTimeMs,
      costUnits: opts.costUnits,
    });
    return body;
  }
}
