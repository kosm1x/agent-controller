/**
 * F6 — Polymarket read adapter (Gamma + CLOB).
 *
 * Fetches active markets + events + trade history. No auth required.
 * Persists market metadata to `prediction_markets` for F7 consumption.
 *
 * Endpoints (as of 2026-04):
 *   Gamma markets:  https://gamma-api.polymarket.com/markets?closed=false&limit=100
 *   Gamma events:   https://gamma-api.polymarket.com/events?closed=false&limit=50
 *   Gamma by slug:  https://gamma-api.polymarket.com/markets/{slug}
 *   CLOB trades:    https://clob.polymarket.com/trades?market={market_id}&limit=100
 *
 * Kalshi + SEC EDGAR deferred per impl plan §1 — scope fences.
 */

import { getDatabase } from "../db/index.js";
import { RateLimitedError, redactApiKeys } from "./types.js";
import { canCall, recordCall } from "./rate-limit.js";
import { recordBudget } from "./budget.js";

const GAMMA_BASE = "https://gamma-api.polymarket.com";
const CLOB_BASE = "https://clob.polymarket.com";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PredictionMarketOutcome {
  id: string;
  label: string;
  price: number; // 0..1
}

export interface PredictionMarket {
  source: "polymarket" | "kalshi";
  marketId: string;
  slug?: string;
  question: string;
  category?: string;
  resolutionDate?: string;
  outcomes: PredictionMarketOutcome[];
  volumeUsd?: number;
  liquidityUsd?: number;
  isNegRisk: boolean;
  eventId?: string;
}

export interface PolymarketTrade {
  id: string;
  marketId: string;
  makerAddress: string;
  takerAddress: string;
  side: "BUY" | "SELL";
  size: number; // USDC
  price: number; // 0..1
  timestamp: string;
  outcomeTokenId?: string;
}

// ---------------------------------------------------------------------------
// Raw Gamma API shapes (loose — we validate the fields we use)
// ---------------------------------------------------------------------------

interface RawGammaMarket {
  id?: string | number;
  conditionId?: string;
  question?: string;
  slug?: string;
  category?: string;
  endDate?: string;
  closed?: boolean;
  outcomes?: string; // JSON-encoded array of labels
  outcomePrices?: string; // JSON-encoded array of prices
  clobTokenIds?: string; // JSON-encoded array of token ids
  volume?: string | number;
  liquidity?: string | number;
  negRisk?: boolean;
  eventId?: string | number;
}

interface RawGammaEvent {
  id: string | number;
  title?: string;
  slug?: string;
  markets?: RawGammaMarket[];
  negRisk?: boolean;
}

interface RawClobTrade {
  id: string;
  market: string;
  maker_address: string;
  taker_address: string;
  side: "BUY" | "SELL";
  size: string | number;
  price: string | number;
  timestamp: string | number;
  asset_id?: string;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class PolymarketAdapter {
  readonly provider = "polymarket" as const;

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly gammaBase: string = GAMMA_BASE,
    private readonly clobBase: string = CLOB_BASE,
  ) {}

  static create(fetchImpl: typeof fetch = fetch): PolymarketAdapter {
    return new PolymarketAdapter(fetchImpl);
  }

  async fetchActiveMarkets(
    opts: { limit?: number; category?: string; offset?: number } = {},
  ): Promise<PredictionMarket[]> {
    const params = new URLSearchParams();
    params.set("closed", "false");
    params.set("limit", String(Math.min(opts.limit ?? 50, 100)));
    if (opts.offset) params.set("offset", String(opts.offset));
    if (opts.category) params.set("category", opts.category);
    const url = `${this.gammaBase}/markets?${params.toString()}`;
    const body = await this.request<RawGammaMarket[]>(url, "gamma/markets");
    if (!Array.isArray(body)) {
      throw new Error("Polymarket Gamma: expected array response");
    }
    return body
      .map(normalizeGammaMarket)
      .filter((m) => m !== null) as PredictionMarket[];
  }

  async fetchEventGroup(eventId: string): Promise<PredictionMarket[]> {
    const url = `${this.gammaBase}/events/${encodeURIComponent(eventId)}`;
    const body = await this.request<RawGammaEvent>(url, "gamma/events");
    if (!body.markets || !Array.isArray(body.markets)) return [];
    const isNegRisk = body.negRisk === true;
    return body.markets
      .map(normalizeGammaMarket)
      .filter((m) => m !== null)
      .map((m) => ({
        ...(m as PredictionMarket),
        eventId: String(body.id),
        isNegRisk: m!.isNegRisk || isNegRisk,
      }));
  }

  async fetchMarketBySlug(slug: string): Promise<PredictionMarket | null> {
    const url = `${this.gammaBase}/markets?slug=${encodeURIComponent(slug)}`;
    const body = await this.request<RawGammaMarket[]>(
      url,
      "gamma/market-by-slug",
    );
    if (!Array.isArray(body) || body.length === 0) return null;
    return normalizeGammaMarket(body[0]);
  }

  async fetchRecentTrades(
    marketId: string,
    opts: { limit?: number } = {},
  ): Promise<PolymarketTrade[]> {
    const params = new URLSearchParams();
    params.set("market", marketId);
    params.set("limit", String(Math.min(opts.limit ?? 100, 500)));
    const url = `${this.clobBase}/trades?${params.toString()}`;
    const body = await this.request<RawClobTrade[]>(url, "clob/trades");
    if (!Array.isArray(body)) return [];
    return body.map(normalizeTrade);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async request<T>(url: string, endpoint: string): Promise<T> {
    if (!canCall("polymarket")) {
      throw new RateLimitedError("polymarket");
    }
    const start = Date.now();
    recordCall("polymarket");
    let res: Response;
    try {
      res = await this.fetchImpl(url);
    } catch (err) {
      recordBudget({
        provider: "polymarket",
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
        provider: "polymarket",
        endpoint,
        status: "rate_limited",
        responseTimeMs,
      });
      throw new RateLimitedError("polymarket");
    }
    if (!res.ok) {
      recordBudget({
        provider: "polymarket",
        endpoint,
        status: "error",
        responseTimeMs,
      });
      throw new Error(
        redactApiKeys(`Polymarket ${res.status}: ${await res.text()}`),
      );
    }
    let body: T;
    try {
      body = (await res.json()) as T;
    } catch (err) {
      recordBudget({
        provider: "polymarket",
        endpoint,
        status: "error",
        responseTimeMs,
      });
      throw new Error(
        `Polymarket: unparseable JSON (${err instanceof Error ? err.message : "unknown"})`,
      );
    }
    recordBudget({
      provider: "polymarket",
      endpoint,
      status: "success",
      responseTimeMs,
    });
    return body;
  }
}

// ---------------------------------------------------------------------------
// Normalizers
// ---------------------------------------------------------------------------

function normalizeGammaMarket(raw: RawGammaMarket): PredictionMarket | null {
  if (!raw.question || !(raw.conditionId || raw.slug)) return null;
  const marketId = String(raw.conditionId ?? raw.slug);
  const outcomes = parseOutcomes(
    raw.outcomes,
    raw.outcomePrices,
    raw.clobTokenIds,
  );
  return {
    source: "polymarket",
    marketId,
    slug: raw.slug,
    question: raw.question,
    category: raw.category,
    resolutionDate: raw.endDate,
    outcomes,
    volumeUsd: toNumber(raw.volume),
    liquidityUsd: toNumber(raw.liquidity),
    isNegRisk: raw.negRisk === true,
    eventId: raw.eventId !== undefined ? String(raw.eventId) : undefined,
  };
}

function parseOutcomes(
  labelsJson?: string,
  pricesJson?: string,
  tokensJson?: string,
): PredictionMarketOutcome[] {
  if (!labelsJson) return [];
  let labels: string[] = [];
  let prices: string[] = [];
  let tokens: string[] = [];
  try {
    labels = JSON.parse(labelsJson);
    if (pricesJson) prices = JSON.parse(pricesJson);
    if (tokensJson) tokens = JSON.parse(tokensJson);
  } catch {
    return [];
  }
  return labels.map((label, i) => ({
    id: tokens[i] ?? `${i}`,
    label,
    price: prices[i] !== undefined ? parseFloat(prices[i]) : 0,
  }));
}

function normalizeTrade(raw: RawClobTrade): PolymarketTrade {
  const tsRaw = raw.timestamp;
  const timestamp =
    typeof tsRaw === "number"
      ? new Date(tsRaw * 1000).toISOString()
      : /^\d+$/.test(String(tsRaw))
        ? new Date(parseInt(String(tsRaw), 10) * 1000).toISOString()
        : String(tsRaw);
  return {
    id: String(raw.id),
    marketId: raw.market,
    makerAddress: raw.maker_address,
    takerAddress: raw.taker_address,
    side: raw.side,
    size: toNumber(raw.size) ?? 0,
    price: toNumber(raw.price) ?? 0,
    timestamp,
    outcomeTokenId: raw.asset_id,
  };
}

function toNumber(v: string | number | undefined): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = typeof v === "string" ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : undefined;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function persistMarkets(markets: PredictionMarket[]): number {
  if (markets.length === 0) return 0;
  const db = getDatabase();
  const upsert = db.prepare(
    `INSERT INTO prediction_markets
      (source, market_id, slug, question, category, resolution_date,
       outcome_tokens, volume_usd, liquidity_usd, is_neg_risk, event_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source, market_id) DO UPDATE SET
       slug            = excluded.slug,
       question        = excluded.question,
       category        = excluded.category,
       resolution_date = excluded.resolution_date,
       outcome_tokens  = excluded.outcome_tokens,
       volume_usd      = excluded.volume_usd,
       liquidity_usd   = excluded.liquidity_usd,
       is_neg_risk     = excluded.is_neg_risk,
       event_id        = excluded.event_id,
       fetched_at      = datetime('now')`,
  );
  let written = 0;
  const tx = db.transaction((ms: PredictionMarket[]) => {
    for (const m of ms) {
      upsert.run(
        m.source,
        m.marketId,
        m.slug ?? null,
        m.question,
        m.category ?? null,
        m.resolutionDate ?? null,
        JSON.stringify(m.outcomes),
        m.volumeUsd ?? null,
        m.liquidityUsd ?? null,
        m.isNegRisk ? 1 : 0,
        m.eventId ?? null,
      );
      written++;
    }
  });
  tx(markets);
  return written;
}
