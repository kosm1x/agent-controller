/**
 * F8.1a — Prediction-Market Alpha tools.
 *
 * pm_alpha_run     (write) — runs the PM alpha pipeline, persists weights.
 * pm_alpha_latest  (read)  — latest run summary.
 *
 * Both deferred, both in the new `pm_alpha` scope group. Input sources:
 *   prediction_markets — F6 Polymarket metadata (seed precursor required)
 *   sentiment_readings — F6.5 F&G + funding
 *   whale_trades       — F6 Polymarket whale flow (may be empty)
 */

import type { Tool } from "../types.js";
import { getDatabase } from "../../db/index.js";
import type { PredictionMarket } from "../../finance/prediction-markets.js";
import type { SentimentReading } from "../../finance/sentiment.js";
import { queryRecentWhales } from "../../finance/whales.js";
import {
  PM_ALPHA_DEFAULTS,
  runPmAlpha,
  type PmAlphaConfig,
  type PmTokenResult,
} from "../../finance/pm-alpha.js";
import {
  persistPmAlphaRun,
  readLatestPmAlphaRun,
} from "../../finance/pm-alpha-persist.js";

// ---------------------------------------------------------------------------
// Input loaders
// ---------------------------------------------------------------------------

function loadActiveMarkets(limit = 100): PredictionMarket[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      `SELECT source, market_id, slug, question, category, resolution_date,
              outcome_tokens, volume_usd, liquidity_usd, is_neg_risk, event_id
         FROM prediction_markets
         ORDER BY fetched_at DESC
         LIMIT ?`,
    )
    .all(limit) as Array<{
    source: "polymarket" | "kalshi" | "manual";
    market_id: string;
    slug: string | null;
    question: string;
    category: string | null;
    resolution_date: string | null;
    outcome_tokens: string | null;
    volume_usd: number | null;
    liquidity_usd: number | null;
    is_neg_risk: number;
    event_id: string | null;
  }>;

  const out: PredictionMarket[] = [];
  for (const r of rows) {
    // 'manual' source isn't in the PredictionMarket type union; skip.
    if (r.source !== "polymarket" && r.source !== "kalshi") continue;
    let outcomes: PredictionMarket["outcomes"] = [];
    if (r.outcome_tokens) {
      try {
        const parsed: unknown = JSON.parse(r.outcome_tokens);
        if (Array.isArray(parsed)) {
          for (const entry of parsed) {
            if (
              entry &&
              typeof entry === "object" &&
              typeof (entry as Record<string, unknown>).label === "string" &&
              typeof (entry as Record<string, unknown>).price === "number"
            ) {
              const e = entry as { id?: string; label: string; price: number };
              outcomes.push({
                id: typeof e.id === "string" ? e.id : "",
                label: e.label,
                price: e.price,
              });
            }
          }
        }
      } catch {
        outcomes = [];
      }
    }
    out.push({
      source: r.source,
      marketId: r.market_id,
      slug: r.slug ?? undefined,
      question: r.question,
      category: r.category ?? undefined,
      resolutionDate: r.resolution_date ?? undefined,
      outcomes,
      volumeUsd: r.volume_usd ?? undefined,
      liquidityUsd: r.liquidity_usd ?? undefined,
      isNegRisk: r.is_neg_risk === 1,
      eventId: r.event_id ?? undefined,
    });
  }
  return out;
}

function loadLatestSentimentReadings(limit = 10): SentimentReading[] {
  // Audit W7 round 1 + round 2: filter to fear_greed — the only indicator
  // the v1 alpha model actually reads (`latestFearGreed`). Other indicators
  // can be added to the WHERE clause when tilt expands to consume them.
  const db = getDatabase();
  const rows = db
    .prepare(
      `SELECT source, indicator, symbol, value, value_text, observed_at
         FROM sentiment_readings
         WHERE indicator = 'fear_greed'
         ORDER BY observed_at DESC
         LIMIT ?`,
    )
    .all(limit) as Array<{
    source: string;
    indicator: string;
    symbol: string | null;
    value: number;
    value_text: string | null;
    observed_at: string;
  }>;
  return rows.map((r) => ({
    source: r.source,
    indicator: r.indicator as SentimentReading["indicator"],
    symbol: r.symbol ?? undefined,
    value: r.value,
    valueText: r.value_text ?? undefined,
    observedAt: r.observed_at,
  }));
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmt(n: number | null | undefined, digits = 4): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}

/**
 * Render a UTC ISO timestamp as an America/New_York YYYY-MM-DD date.
 * Audit W5 round 2: the operator lives in MX; NY wall-clock date matches
 * the market-hours context we care about. Previously `.slice(0,10)` on the
 * UTC ISO string could drift by one day during evening runs.
 */
function renderNyDate(isoUtc: string): string {
  const d = new Date(isoUtc);
  if (Number.isNaN(d.getTime())) return isoUtc.slice(0, 10);
  return d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

function formatTopTokens(tokens: PmTokenResult[], n = 5): string[] {
  const active = tokens
    .filter((t) => !t.excluded && Math.abs(t.weight) > 1e-9)
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
    .slice(0, n);
  return active.map((t) => {
    const slug = (t.slug ?? t.marketId).slice(0, 28).padEnd(28);
    return `  ${slug} ${t.outcome.padEnd(4)} px=${fmt(t.marketPrice, 3)} edge=${fmt(t.edge, 4)} w=${fmt(t.weight, 5)}`;
  });
}

// ---------------------------------------------------------------------------
// pm_alpha_run
// ---------------------------------------------------------------------------

function parseConfigOverride(raw: string): PmAlphaConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `override_config: invalid JSON — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`override_config: must be a JSON object`);
  }
  const obj = parsed as Record<string, unknown>;
  const out: PmAlphaConfig = {};
  const numericKeys: Array<keyof PmAlphaConfig> = [
    "whaleWeight",
    "sentimentWeight",
    "kellyScale",
    "maxWeightPerToken",
    "maxTotalExposure",
    "minLiquidityUsd",
    "minDaysToResolution",
    "maxDaysToResolution",
    "minPriceBound",
    "maxPriceBound",
  ];
  for (const k of numericKeys) {
    if (k in obj) {
      const v = obj[k];
      if (typeof v !== "number" || !Number.isFinite(v)) {
        throw new Error(`override_config.${k} must be a finite number`);
      }
      (out as Record<string, number>)[k] = v;
    }
  }
  return out;
}

export const pmAlphaRunTool: Tool = {
  name: "pm_alpha_run",
  deferred: true,
  riskTier: "low",
  definition: {
    type: "function",
    function: {
      name: "pm_alpha_run",
      description: `Runs the F8.1a Prediction-Market Alpha pipeline — combines Polymarket midpoint + sentiment tilt + (optional) whale flow into per-token Kelly-fraction weights. Filters out extreme-price, low-liquidity, near-resolution, and far-resolution markets. Persists to \`pm_signal_weights\`. Takes ~1-2s.

USE WHEN operator asks to "run pm alpha", "polymarket alpha weights", "compute prediction-market signals", "mercados predicción", "pondera los mercados de predicción".
NOT WHEN equity alpha (use \`alpha_run\`) or paper trading (use \`paper_rebalance\` — F8.1b).

Output: run_id, nMarkets, nActive, totalExposure (Σ|weight|), top 5 by |weight|. Does NOT auto-trade. No F7.5 ship_gate at v1 (deferred to F8.1c).

Prerequisite: \`prediction_markets\` + \`sentiment_snapshot\` tools must have populated \`prediction_markets\` and \`sentiment_readings\` tables. Errors clearly when inputs are empty.`,
      parameters: {
        type: "object",
        properties: {
          override_config: {
            type: "string",
            description:
              'Optional JSON object overriding defaults. Shape: {"kellyScale":0.1,"maxWeightPerToken":0.01,"maxTotalExposure":0.2,"minLiquidityUsd":5000,"minDaysToResolution":1,"maxDaysToResolution":90}. Omit for defaults.',
          },
          market_limit: {
            type: "number",
            description:
              "Cap on how many most-recent markets to load. Default 100, max 500.",
          },
        },
        required: [],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const rawOverride = args.override_config;
    let config: PmAlphaConfig | undefined;
    if (typeof rawOverride === "string" && rawOverride.trim().length > 0) {
      try {
        config = parseConfigOverride(rawOverride);
      } catch (err) {
        return `pm_alpha_run: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    const marketLimit =
      typeof args.market_limit === "number" &&
      args.market_limit >= 1 &&
      args.market_limit <= 500
        ? Math.floor(args.market_limit)
        : 100;

    const markets = loadActiveMarkets(marketLimit);
    if (markets.length === 0) {
      return `pm_alpha_run: no prediction_markets rows available. Seed via \`prediction_markets\` tool first.`;
    }
    const sentiment = loadLatestSentimentReadings(10);
    // Audit W1 round 1: lift the whale-row cap so a 7-day window isn't
    // silently truncated to 20 trades.
    const whales = queryRecentWhales({ hours: 24 * 7, limit: 2000 });

    // Audit W5 round 1 + round 2: store a UTC instant (Date.parse-safe for
    // downstream daysBetween) + a separate NY-local wall-clock date string
    // for display. Avoids both the hardcoded-offset bug AND the evening-UTC
    // date drift in operator-facing output.
    const asOf = new Date().toISOString();

    const result = runPmAlpha({
      markets,
      sentimentReadings: sentiment,
      whaleTrades: whales,
      asOf,
      config,
    });

    persistPmAlphaRun(result);

    const lines: string[] = [];
    lines.push(
      `pm_alpha_run: run_id=${result.runId}  asOf=${renderNyDate(asOf)}  duration=${result.durationMs}ms`,
    );
    lines.push(
      `  nMarkets=${result.nMarkets}  nActive=${result.nActive}  totalExposure=${fmt(result.totalExposure, 4)}  maxExposure=${fmt(PM_ALPHA_DEFAULTS.maxTotalExposure, 2)}`,
    );
    lines.push(
      `  sentiment_readings=${sentiment.length}  whale_trades=${whales.length}`,
    );
    const top = formatTopTokens(result.tokens);
    if (top.length > 0) {
      lines.push(`  top ${top.length} by |weight|:`);
      for (const l of top) lines.push(l);
    } else {
      lines.push(`  (no active tokens above threshold — edges too small)`);
    }
    const excluded = result.tokens.filter((t) => t.excluded);
    if (excluded.length > 0) {
      const byReason = new Map<string, number>();
      for (const t of excluded) {
        const k = t.excludeReason ?? "unknown";
        byReason.set(k, (byReason.get(k) ?? 0) + 1);
      }
      const parts = Array.from(byReason.entries()).map(([k, v]) => `${k}=${v}`);
      lines.push(`  exclusions: ${parts.join(", ")}`);
    }
    return lines.join("\n");
  },
};

// ---------------------------------------------------------------------------
// pm_alpha_latest
// ---------------------------------------------------------------------------

export const pmAlphaLatestTool: Tool = {
  name: "pm_alpha_latest",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "pm_alpha_latest",
      description: `Returns the most-recent \`pm_alpha_run\` summary: run_id, timestamp, N markets, N active, total exposure, top 5 tokens by |weight|. No side effects. Used by F8.1b \`paper_rebalance\` as the pre-trade check.`,
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },

  async execute(): Promise<string> {
    const result = readLatestPmAlphaRun();
    if (!result) {
      return `pm_alpha_latest: no runs found. Invoke \`pm_alpha_run\` first.`;
    }
    const lines: string[] = [];
    lines.push(
      `pm_alpha_latest: run_id=${result.runId}  asOf=${renderNyDate(result.runTimestamp)}`,
    );
    lines.push(
      `  nMarkets=${result.nMarkets}  nActive=${result.nActive}  totalExposure=${fmt(result.totalExposure, 4)}`,
    );
    const top = formatTopTokens(result.tokens);
    if (top.length > 0) {
      lines.push(`  top ${top.length} by |weight|:`);
      for (const l of top) lines.push(l);
    } else {
      lines.push(`  (no active tokens)`);
    }
    return lines.join("\n");
  },
};

export const pmAlphaTools: Tool[] = [pmAlphaRunTool, pmAlphaLatestTool];
