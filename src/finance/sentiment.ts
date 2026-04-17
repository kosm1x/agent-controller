/**
 * F6.5 Sentiment adapters — Fear & Greed (alternative.me + CoinMarketCap)
 * and Binance funding rates. All public/free endpoints (CMC has an
 * optional paid key that unlocks historical depth).
 *
 * Snapshot builder combines into a composite reading with interpretation.
 */

import { getConfig } from "../config.js";
import { getDatabase } from "../db/index.js";
import { RateLimitedError, redactApiKeys, type Provider } from "./types.js";
import { canCall, recordCall } from "./rate-limit.js";
import { recordBudget } from "./budget.js";

const ALT_ME_URL = "https://api.alternative.me/fng/?limit=1";
const CMC_PUBLIC_URL =
  "https://api.coinmarketcap.com/data-api/v3/fear-greed/chart?limit=1";
const CMC_PRO_URL =
  "https://pro-api.coinmarketcap.com/v3/fear-and-greed/historical?limit=1";
const BINANCE_PREMIUM_INDEX = "https://fapi.binance.com/fapi/v1/premiumIndex";

export type SentimentIndicator =
  | "fear_greed"
  | "funding_rate"
  | "liquidation"
  | "stablecoin_flow";

export interface SentimentReading {
  source: string;
  indicator: SentimentIndicator;
  symbol?: string;
  value: number;
  valueText?: string;
  observedAt: string;
}

// ---------------------------------------------------------------------------
// Fear & Greed (alternative.me)
// ---------------------------------------------------------------------------

interface AltMeResponse {
  data?: {
    value?: string | number;
    value_classification?: string;
    timestamp?: string | number;
    time_until_update?: string;
  }[];
}

export async function fetchAltMeFearGreed(
  fetchImpl: typeof fetch = fetch,
): Promise<SentimentReading | null> {
  const body = await makeRequest<AltMeResponse>(
    fetchImpl,
    ALT_ME_URL,
    "alternative_me",
    "fng",
  );
  const entry = body?.data?.[0];
  if (!entry) return null;
  const value = toNumber(entry.value);
  if (value === null) return null;
  const observedAt = timestampToIso(entry.timestamp);
  return {
    source: "alternative_me",
    indicator: "fear_greed",
    value,
    valueText: entry.value_classification,
    observedAt,
  };
}

// ---------------------------------------------------------------------------
// Fear & Greed (CoinMarketCap)
// ---------------------------------------------------------------------------

interface CmcPublicResponse {
  data?: {
    dataList?: { score?: number; name?: string; timestamp?: string }[];
  };
}

interface CmcProResponse {
  data?: {
    value?: number;
    value_classification?: string;
    timestamp?: string;
  }[];
}

export async function fetchCmcFearGreed(
  fetchImpl: typeof fetch = fetch,
): Promise<SentimentReading | null> {
  const proKey = getConfig().cmcProApiKey;
  if (proKey) {
    const body = await makeRequest<CmcProResponse>(
      fetchImpl,
      CMC_PRO_URL,
      "coinmarketcap",
      "fng-pro",
      { "X-CMC_PRO_API_KEY": proKey },
    );
    const entry = body?.data?.[0];
    if (!entry || typeof entry.value !== "number") return null;
    return {
      source: "cmc_fng",
      indicator: "fear_greed",
      value: entry.value,
      valueText: entry.value_classification,
      observedAt: entry.timestamp ?? new Date().toISOString(),
    };
  }
  // Public fallback
  const body = await makeRequest<CmcPublicResponse>(
    fetchImpl,
    CMC_PUBLIC_URL,
    "coinmarketcap",
    "fng-public",
  );
  const entry = body?.data?.dataList?.[0];
  if (!entry || typeof entry.score !== "number") return null;
  return {
    source: "cmc_fng",
    indicator: "fear_greed",
    value: entry.score,
    valueText: entry.name,
    observedAt: entry.timestamp ?? new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Binance funding rate (perps)
// ---------------------------------------------------------------------------

interface BinancePremiumIndexResponse {
  symbol?: string;
  lastFundingRate?: string | number;
  markPrice?: string | number;
  nextFundingTime?: number;
  time?: number;
}

export async function fetchBinanceFunding(
  symbol: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SentimentReading | null> {
  const url = `${BINANCE_PREMIUM_INDEX}?symbol=${encodeURIComponent(symbol)}`;
  const body = await makeRequest<BinancePremiumIndexResponse>(
    fetchImpl,
    url,
    "binance",
    "premiumIndex",
  );
  const rate = toNumber(body.lastFundingRate);
  if (rate === null) return null;
  return {
    source: "binance_funding",
    indicator: "funding_rate",
    symbol,
    value: rate,
    observedAt: body.time
      ? new Date(body.time).toISOString()
      : new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Composite snapshot
// ---------------------------------------------------------------------------

export interface SentimentSnapshot {
  fearGreed: {
    value: number;
    classification: string;
    sources: { source: string; value: number; classification?: string }[];
  } | null;
  fundingRates: { symbol: string; rate: number; annualizedPct: number }[];
  interpretation: string;
  degradedSources: string[];
}

const DEFAULT_FUNDING_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];

export async function getSentimentSnapshot(
  fetchImpl: typeof fetch = fetch,
): Promise<SentimentSnapshot> {
  const degraded: string[] = [];

  const [altMe, cmc] = await Promise.all([
    fetchAltMeFearGreed(fetchImpl).catch((err) => {
      degraded.push(
        `alternative_me: ${err instanceof Error ? err.message : err}`,
      );
      return null;
    }),
    fetchCmcFearGreed(fetchImpl).catch((err) => {
      degraded.push(
        `coinmarketcap: ${err instanceof Error ? err.message : err}`,
      );
      return null;
    }),
  ]);

  const fgSources: {
    source: string;
    value: number;
    classification?: string;
  }[] = [];
  if (altMe)
    fgSources.push({
      source: altMe.source,
      value: altMe.value,
      classification: altMe.valueText,
    });
  if (cmc)
    fgSources.push({
      source: cmc.source,
      value: cmc.value,
      classification: cmc.valueText,
    });

  let fearGreed: SentimentSnapshot["fearGreed"] = null;
  if (fgSources.length > 0) {
    const avg =
      fgSources.reduce((acc, r) => acc + r.value, 0) / fgSources.length;
    fearGreed = {
      value: avg,
      classification: classifyFearGreed(avg),
      sources: fgSources,
    };
  }

  const fundingResults = await Promise.all(
    DEFAULT_FUNDING_SYMBOLS.map((s) =>
      fetchBinanceFunding(s, fetchImpl).catch((err) => {
        degraded.push(
          `binance ${s}: ${err instanceof Error ? err.message : err}`,
        );
        return null;
      }),
    ),
  );
  const fundingRates = fundingResults
    .filter((r): r is SentimentReading => r !== null)
    .map((r) => ({
      symbol: r.symbol ?? "unknown",
      rate: r.value,
      annualizedPct: r.value * 3 * 365 * 100, // 3 funding periods/day × 365 days
    }));

  return {
    fearGreed,
    fundingRates,
    interpretation: buildInterpretation(fearGreed, fundingRates),
    degradedSources: degraded,
  };
}

function classifyFearGreed(value: number): string {
  if (value <= 24) return "Extreme Fear";
  if (value <= 44) return "Fear";
  if (value <= 54) return "Neutral";
  if (value <= 74) return "Greed";
  return "Extreme Greed";
}

function buildInterpretation(
  fg: SentimentSnapshot["fearGreed"],
  fundings: SentimentSnapshot["fundingRates"],
): string {
  const parts: string[] = [];
  if (fg) {
    if (fg.value <= 24)
      parts.push("crowd in extreme fear (contrarian bullish signal)");
    else if (fg.value <= 44) parts.push("crowd fearful");
    else if (fg.value <= 54) parts.push("crowd neutral");
    else if (fg.value <= 74) parts.push("crowd greedy");
    else parts.push("crowd in extreme greed (contrarian bearish signal)");
  }
  if (fundings.length > 0) {
    const avg = fundings.reduce((a, b) => a + b.rate, 0) / fundings.length;
    if (avg > 0.0001)
      parts.push("funding positive (longs pay shorts — crowd biased long)");
    else if (avg < -0.0001)
      parts.push("funding negative (shorts pay longs — crowd biased short)");
    else parts.push("funding balanced");
  }
  return parts.length > 0 ? parts.join("; ") : "no sentiment data available";
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function persistSentimentReadings(readings: SentimentReading[]): number {
  if (readings.length === 0) return 0;
  const db = getDatabase();
  // SQLite's UNIQUE constraint treats NULL as distinct, so `INSERT OR IGNORE`
  // alone doesn't dedup readings whose `symbol` is NULL (e.g., fear_greed).
  // Explicit check-then-insert covers the NULL-symbol case.
  const existsWithSymbol = db.prepare(
    `SELECT 1 FROM sentiment_readings
     WHERE source=? AND indicator=? AND symbol=? AND observed_at=? LIMIT 1`,
  );
  const existsNullSymbol = db.prepare(
    `SELECT 1 FROM sentiment_readings
     WHERE source=? AND indicator=? AND symbol IS NULL AND observed_at=? LIMIT 1`,
  );
  const insert = db.prepare(
    `INSERT INTO sentiment_readings
      (source, indicator, symbol, value, value_text, observed_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  let inserted = 0;
  const tx = db.transaction((all: SentimentReading[]) => {
    for (const r of all) {
      const present = r.symbol
        ? existsWithSymbol.get(r.source, r.indicator, r.symbol, r.observedAt)
        : existsNullSymbol.get(r.source, r.indicator, r.observedAt);
      if (present) continue;
      insert.run(
        r.source,
        r.indicator,
        r.symbol ?? null,
        r.value,
        r.valueText ?? null,
        r.observedAt,
      );
      inserted++;
    }
  });
  tx(readings);
  return inserted;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function makeRequest<T>(
  fetchImpl: typeof fetch,
  url: string,
  provider: Provider,
  endpoint: string,
  headers: Record<string, string> = {},
): Promise<T> {
  if (!canCall(provider)) {
    throw new RateLimitedError(provider);
  }
  const start = Date.now();
  recordCall(provider);
  let res: Response;
  try {
    res = await fetchImpl(url, { headers });
  } catch (err) {
    recordBudget({
      provider,
      endpoint,
      status: "error",
      responseTimeMs: Date.now() - start,
    });
    throw new Error(
      redactApiKeys(err instanceof Error ? err.message : String(err)),
    );
  }
  const responseTimeMs = Date.now() - start;
  if (res.status === 429) {
    recordBudget({
      provider,
      endpoint,
      status: "rate_limited",
      responseTimeMs,
    });
    throw new RateLimitedError(provider);
  }
  if (!res.ok) {
    recordBudget({
      provider,
      endpoint,
      status: "error",
      responseTimeMs,
    });
    throw new Error(
      redactApiKeys(`${provider} ${res.status}: ${await res.text()}`),
    );
  }
  let body: T;
  try {
    body = (await res.json()) as T;
  } catch (err) {
    recordBudget({
      provider,
      endpoint,
      status: "error",
      responseTimeMs,
    });
    throw new Error(
      `${provider}: unparseable JSON (${err instanceof Error ? err.message : "unknown"})`,
    );
  }
  recordBudget({
    provider,
    endpoint,
    status: "success",
    responseTimeMs,
  });
  return body;
}

function toNumber(v: string | number | null | undefined): number | null {
  if (v === undefined || v === null) return null;
  const n = typeof v === "string" ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : null;
}

function timestampToIso(ts: string | number | undefined): string {
  if (typeof ts === "number") return new Date(ts * 1000).toISOString();
  if (typeof ts === "string" && /^\d+$/.test(ts)) {
    return new Date(parseInt(ts, 10) * 1000).toISOString();
  }
  if (typeof ts === "string") return ts;
  return new Date().toISOString();
}
