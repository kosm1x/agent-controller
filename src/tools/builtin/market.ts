/**
 * F1 finance tools — market_quote, market_history, market_watchlist_*,
 * market_budget_stats.
 *
 * All deferred: true (loaded only when `finance` scope activates).
 * Output pre-formatted for LLM consumption per feedback_preformat_over_prompt.
 */

import type { Tool } from "../types.js";
import { getDataLayer } from "../../finance/data-layer.js";
import type { AssetClass, MacroPoint, MarketBar } from "../../finance/types.js";
import { budgetSummary } from "../../finance/budget.js";
import { currentWindow, ceilings } from "../../finance/rate-limit.js";
import {
  sma,
  ema,
  rsi,
  macd,
  bollingerBands,
  vwap,
  atr,
  roc,
  williamsR,
  latest,
} from "../../finance/indicators.js";
import {
  classifyRegime,
  type MacroSeriesBundle,
  type MacroRegime,
} from "../../finance/macro.js";
import {
  detectAllSignals,
  persistSignals,
  type Signal,
  type SignalType,
} from "../../finance/signals.js";

// ---------------------------------------------------------------------------
// market_quote
// ---------------------------------------------------------------------------

export const marketQuoteTool: Tool = {
  name: "market_quote",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "market_quote",
      description: `Current price snapshot for a single ticker (last close, intraday high/low, volume).

USE WHEN:
- User asks "how is SPY?", "cotiza AAPL", "precio actual de NVDA"
- Need a one-shot quote, not a time series (for history use market_history)

NOT WHEN:
- User wants historical bars (use market_history)
- User wants indicators/signals (not yet — F2/F3)

Source: Alpha Vantage GLOBAL_QUOTE. ~15-min delayed during US market hours.

Input: symbol (ticker). Examples: SPY, AAPL, TSLA, BRK.B.
Output: formatted single-line summary (symbol, price, change %, timestamp, source).`,
      parameters: {
        type: "object",
        properties: {
          symbol: {
            type: "string",
            description:
              "Ticker symbol. Equity/ETF: SPY, AAPL. Use market_watchlist_list to see tracked symbols.",
          },
        },
        required: ["symbol"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const symbol = (args.symbol as string | undefined)?.trim()?.toUpperCase();
    if (!symbol) return JSON.stringify({ error: "symbol is required" });
    try {
      const bar = await getDataLayer().getQuote(symbol);
      return formatQuote(bar);
    } catch (err) {
      return `No pude obtener cotización de ${symbol}: ${err instanceof Error ? err.message : err}`;
    }
  },
};

function formatQuote(bar: MarketBar): string {
  return `${bar.symbol}: $${bar.close.toFixed(2)} (OHLC today: O ${bar.open.toFixed(2)} · H ${bar.high.toFixed(2)} · L ${bar.low.toFixed(2)}) · vol ${bar.volume.toLocaleString()} · @ ${bar.timestamp} · source: ${bar.provider}`;
}

// ---------------------------------------------------------------------------
// market_history
// ---------------------------------------------------------------------------

export const marketHistoryTool: Tool = {
  name: "market_history",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "market_history",
      description: `Historical OHLCV bars for a ticker. Pre-formatted as a compact table.

USE WHEN:
- User asks for price history, chart, trend analysis
- Need data for follow-up reasoning (recent highs/lows, moving averages by eye)

Default: daily, 60 bars. Override interval for intraday (1/5/15/60 min) or lookback for longer history.

Source: Alpha Vantage primary, Polygon fallback. Stored in NY market time.

Output: header + table of ≤lookback rows (date/time, O, H, L, C, V). If cached result is stale because both data providers were unreachable, includes a "STALE" notice.`,
      parameters: {
        type: "object",
        properties: {
          symbol: {
            type: "string",
            description: "Ticker. Equity/ETF: SPY. FX: EURUSD (6-letter).",
          },
          interval: {
            type: "string",
            enum: ["daily", "1min", "5min", "15min", "60min"],
            description:
              "Bar interval. Default 'daily'. Use intraday only for recent-day analysis — they cost more API budget.",
          },
          lookback: {
            type: "number",
            description:
              "Number of bars. Default 60. Max 500. Intraday lookback is limited by AV's 2-week intraday window.",
          },
        },
        required: ["symbol"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const symbol = (args.symbol as string | undefined)?.trim()?.toUpperCase();
    if (!symbol) return JSON.stringify({ error: "symbol is required" });
    const interval = (args.interval as string) ?? "daily";
    const lookbackRaw = Number(args.lookback ?? 60);
    const lookback = Math.min(500, Math.max(1, Math.round(lookbackRaw)));

    const layer = getDataLayer();
    try {
      const result =
        interval === "daily"
          ? await layer.getDaily(symbol, { lookback })
          : await layer.getIntraday(
              symbol,
              interval as "1min" | "5min" | "15min" | "60min",
              { lookback },
            );
      return formatHistory(symbol, interval, result.bars, {
        stale: result.stale,
        provider: result.provider,
      });
    } catch (err) {
      return `No pude obtener historial de ${symbol} (${interval}): ${err instanceof Error ? err.message : err}`;
    }
  },
};

function formatHistory(
  symbol: string,
  interval: string,
  bars: MarketBar[],
  meta: { stale?: boolean; provider: string },
): string {
  if (bars.length === 0)
    return `${symbol} (${interval}): sin datos disponibles.`;
  const lines: string[] = [];
  lines.push(
    `${symbol} — ${bars.length} bars (${interval}) · source: ${meta.provider}${meta.stale ? " · STALE (providers unreachable)" : ""}`,
  );
  lines.push(
    "timestamp                 open     high      low    close      volume",
  );
  for (const b of bars) {
    lines.push(
      `${b.timestamp.padEnd(25)} ${b.open.toFixed(2).padStart(8)} ${b.high.toFixed(2).padStart(8)} ${b.low.toFixed(2).padStart(8)} ${b.close.toFixed(2).padStart(8)} ${String(b.volume).padStart(11)}`,
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// market_watchlist_add / remove / list
// ---------------------------------------------------------------------------

export const marketWatchlistAddTool: Tool = {
  name: "market_watchlist_add",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "market_watchlist_add",
      description: `Add a ticker to the operator's watchlist.

USE WHEN:
- User says "agrega TSLA a mi watchlist", "add AAPL", "trackea NVDA"
- New symbol is being introduced into rotation

NOT WHEN:
- User wants a one-shot quote (use market_quote)
- User wants to rename/retag existing symbol (use add again — upserts)

Validation: symbol normalized to UPPERCASE; FX forced to 6-letter form (EURUSD);
rejects if projected daily API usage would exceed the Alpha Vantage tier ceiling.`,
      parameters: {
        type: "object",
        properties: {
          symbol: {
            type: "string",
            description:
              "Ticker. Equity/ETF: TSLA. FX: EURUSD. Macro: FEDFUNDS.",
          },
          asset_class: {
            type: "string",
            enum: ["equity", "etf", "fx", "commodity", "crypto", "macro"],
            description:
              "Asset class. Pick ETF for index funds (SPY, QQQ), equity for single stocks.",
          },
          name: {
            type: "string",
            description:
              "Human-readable name, e.g. 'Tesla Inc'. Optional — for display only.",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description:
              "Grouping tags: sector, theme, regime-sensitivity. Used later by F4 market tools for filtered scans.",
          },
          notes: {
            type: "string",
            description:
              "Operator note: 'core position', 'hedge leg', 'high-conviction'.",
          },
        },
        required: ["symbol", "asset_class"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const symbol = args.symbol as string | undefined;
    const assetClass = args.asset_class as AssetClass | undefined;
    if (!symbol || !assetClass) {
      return JSON.stringify({ error: "symbol and asset_class are required" });
    }
    try {
      const row = getDataLayer().addToWatchlist({
        symbol,
        assetClass,
        name: args.name as string | undefined,
        tags: args.tags as string[] | undefined,
        notes: args.notes as string | undefined,
      });
      const tagStr = row.tags.length ? ` [${row.tags.join(", ")}]` : "";
      return `OK: added ${row.symbol} (${row.assetClass})${tagStr}${row.notes ? ` — ${row.notes}` : ""}`;
    } catch (err) {
      return `ERROR: could not add — ${err instanceof Error ? err.message : err}`;
    }
  },
};

export const marketWatchlistRemoveTool: Tool = {
  name: "market_watchlist_remove",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "market_watchlist_remove",
      description: `Remove (deactivate) a ticker from the watchlist.

USE WHEN: "quita TSLA", "remove AAPL", "drop NVDA from watchlist".
Soft delete — row kept with active=0, can be re-added.`,
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Ticker to remove." },
        },
        required: ["symbol"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const symbol = (args.symbol as string | undefined)?.trim()?.toUpperCase();
    if (!symbol) return JSON.stringify({ error: "symbol is required" });
    const removed = getDataLayer().removeFromWatchlist(symbol);
    return removed
      ? `OK: removed ${symbol} from watchlist`
      : `${symbol} was not active in the watchlist.`;
  },
};

export const marketWatchlistListTool: Tool = {
  name: "market_watchlist_list",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "market_watchlist_list",
      description: `Show active watchlist grouped by asset_class.

USE WHEN: "muestra mi watchlist", "list watchlist", "what am I tracking".
Output: compact text table, no API calls.`,
      parameters: { type: "object", properties: {} },
    },
  },

  async execute(): Promise<string> {
    const rows = getDataLayer().listWatchlist();
    if (rows.length === 0) return "Watchlist vacía.";
    const byClass = new Map<string, typeof rows>();
    for (const r of rows) {
      const list = byClass.get(r.assetClass) ?? [];
      list.push(r);
      byClass.set(r.assetClass, list);
    }
    const lines: string[] = [`Watchlist — ${rows.length} símbolos`];
    for (const [cls, list] of byClass) {
      lines.push(`\n${cls} (${list.length}):`);
      for (const r of list) {
        const tagStr = r.tags.length ? ` [${r.tags.join(",")}]` : "";
        lines.push(
          `  ${r.symbol}${r.name ? ` — ${r.name}` : ""}${tagStr}${r.notes ? ` · ${r.notes}` : ""}`,
        );
      }
    }
    return lines.join("\n");
  },
};

// ---------------------------------------------------------------------------
// market_budget_stats
// ---------------------------------------------------------------------------

export const marketBudgetStatsTool: Tool = {
  name: "market_budget_stats",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "market_budget_stats",
      description: `API consumption stats for Alpha Vantage / Polygon / FRED.

USE WHEN: user asks about API usage, rate limits, budget status.
Output: last-60s window usage vs ceilings + last-hour summary.`,
      parameters: { type: "object", properties: {} },
    },
  },

  async execute(): Promise<string> {
    const window = currentWindow();
    const caps = ceilings();
    const hourly = budgetSummary();
    const lines: string[] = ["Finance API budget:"];
    for (const [provider, count] of Object.entries(window)) {
      const cap = caps[provider as keyof typeof caps];
      lines.push(
        `  ${provider}: ${count}/${cap ?? "∞"} calls in last 60s (${cap ? Math.round((count / cap) * 100) : 0}% of window)`,
      );
    }
    if (hourly.length) {
      lines.push("\nLast hour:");
      for (const h of hourly) {
        lines.push(
          `  ${h.provider}: ${h.calls} calls · ${Math.round(h.successRate * 100)}% success · ${h.costUnits} units`,
        );
      }
    }
    return lines.join("\n");
  },
};

// ---------------------------------------------------------------------------
// market_indicators (F2+F4)
// ---------------------------------------------------------------------------

type AllIndicatorName =
  | "sma"
  | "ema"
  | "rsi"
  | "macd"
  | "bollinger"
  | "vwap"
  | "atr"
  | "roc"
  | "williams";

const ALL_INDICATORS: AllIndicatorName[] = [
  "sma",
  "ema",
  "rsi",
  "macd",
  "bollinger",
  "vwap",
  "atr",
  "roc",
  "williams",
];

/** Daily default excludes VWAP (not meaningful outside intraday sessions). Audit W3+W6. */
const DAILY_DEFAULT_INDICATORS: AllIndicatorName[] = [
  "sma",
  "ema",
  "rsi",
  "macd",
  "bollinger",
  "atr",
  "roc",
  "williams",
];

export const marketIndicatorsTool: Tool = {
  name: "market_indicators",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "market_indicators",
      description: `Compute technical indicators over a symbol's recent price history.

USE WHEN:
- User asks for RSI, MACD, moving averages, Bollinger bands, or similar quant signals
- Need quick overbought/oversold / trend / momentum read on a ticker

NOT WHEN:
- User wants to scan the watchlist for symbols matching a condition (use market_scan)
- User wants raw historical bars (use market_history)

Output: pre-formatted summary of latest indicator values. Default interval=daily, lookback=100 bars, all 9 indicators.

VWAP is meaningful on intraday intervals (1min/5min/15min/60min); on daily bars it returns a cumulative value that is not the intraday-VWAP convention.`,
      parameters: {
        type: "object",
        properties: {
          symbol: {
            type: "string",
            description: "Ticker. Equity/ETF: SPY, AAPL.",
          },
          interval: {
            type: "string",
            enum: ["daily", "1min", "5min", "15min", "60min"],
            description: "Bar interval. Default 'daily'.",
          },
          lookback: {
            type: "number",
            description:
              "Number of bars to fetch before computing. Default 100. Must be >= 20 for Bollinger/SMA(20).",
          },
          indicators: {
            type: "array",
            items: {
              type: "string",
              enum: [
                "sma",
                "ema",
                "rsi",
                "macd",
                "bollinger",
                "vwap",
                "atr",
                "roc",
                "williams",
              ],
            },
            description: "Which indicators to compute. Default: all 9.",
          },
        },
        required: ["symbol"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const symbol = (args.symbol as string | undefined)?.trim()?.toUpperCase();
    if (!symbol) return JSON.stringify({ error: "symbol is required" });
    const interval = (args.interval as string) ?? "daily";
    // Audit W4 + R1: min 35 for MACD signal; finite-number guard.
    const rawLookback = Number(args.lookback ?? 100);
    const lookback = Number.isFinite(rawLookback)
      ? Math.min(500, Math.max(35, Math.round(rawLookback)))
      : 100;
    // Audit W3+W6: exclude VWAP from default on daily — cumulative VWAP
    // across multi-session daily bars is actively misleading.
    const defaultIndicators =
      interval === "daily" ? DAILY_DEFAULT_INDICATORS : ALL_INDICATORS;
    const which =
      (args.indicators as AllIndicatorName[] | undefined) ?? defaultIndicators;

    try {
      const layer = getDataLayer();
      const result =
        interval === "daily"
          ? await layer.getDaily(symbol, { lookback })
          : await layer.getIntraday(
              symbol,
              interval as "1min" | "5min" | "15min" | "60min",
              { lookback },
            );
      if (result.bars.length === 0) {
        return `${symbol}: no data available for ${interval}.`;
      }
      return formatIndicators(
        symbol,
        interval,
        result.bars,
        which,
        result.stale,
      );
    } catch (err) {
      return `No pude calcular indicadores de ${symbol}: ${err instanceof Error ? err.message : err}`;
    }
  },
};

function formatIndicators(
  symbol: string,
  interval: string,
  bars: MarketBar[],
  which: AllIndicatorName[],
  stale: boolean | undefined,
): string {
  const closes = bars.map((b) => b.close);
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);
  const volumes = bars.map((b) => b.volume);

  const lines: string[] = [
    `${symbol} (${interval}, ${bars.length} bars) — latest values${stale ? " [STALE]" : ""}:`,
  ];

  for (const name of which) {
    switch (name) {
      case "sma": {
        const v = latest(sma(closes, 20));
        lines.push(`  SMA(20)       = ${fmtValue(v)}`);
        break;
      }
      case "ema": {
        const v = latest(ema(closes, 20));
        lines.push(`  EMA(20)       = ${fmtValue(v)}`);
        break;
      }
      case "rsi": {
        const v = latest(rsi(closes, 14));
        const zone =
          v === null
            ? ""
            : v >= 70
              ? " (overbought)"
              : v <= 30
                ? " (oversold)"
                : " (neutral)";
        lines.push(`  RSI(14)       = ${fmtValue(v)}${zone}`);
        break;
      }
      case "macd": {
        const m = macd(closes);
        const ml = latest(m.macd);
        const sl = latest(m.signal);
        const hl = latest(m.histogram);
        const hint =
          hl === null ? "" : hl > 0 ? " (bullish bias)" : " (bearish bias)";
        lines.push(
          `  MACD(12,26,9) = ${fmtValue(ml)}, signal ${fmtValue(sl)}, hist ${fmtValue(hl)}${hint}`,
        );
        break;
      }
      case "bollinger": {
        const b = bollingerBands(closes, 20, 2);
        lines.push(
          `  Bollinger(20,2) = upper ${fmtValue(latest(b.upper))}, mid ${fmtValue(latest(b.middle))}, lower ${fmtValue(latest(b.lower))}`,
        );
        break;
      }
      case "vwap": {
        // Audit W6: on daily bars VWAP accumulates across sessions with no
        // reset — the value is not the chart-convention intraday VWAP.
        // Skip silently on daily (only emitted when user explicitly requests it).
        if (interval === "daily") {
          lines.push(
            `  VWAP          = (skipped on daily — cumulative across sessions, use intraday interval)`,
          );
        } else {
          const v = latest(vwap(highs, lows, closes, volumes));
          lines.push(`  VWAP          = ${fmtValue(v)}`);
        }
        break;
      }
      case "atr": {
        const v = latest(atr(highs, lows, closes, 14));
        lines.push(`  ATR(14)       = ${fmtValue(v)}`);
        break;
      }
      case "roc": {
        const v = latest(roc(closes, 10));
        const sign = v === null ? "" : v >= 0 ? "+" : "";
        lines.push(`  ROC(10)       = ${sign}${fmtValue(v)}%`);
        break;
      }
      case "williams": {
        const v = latest(williamsR(highs, lows, closes, 14));
        const zone =
          v === null
            ? ""
            : v <= -80
              ? " (oversold)"
              : v >= -20
                ? " (overbought)"
                : " (neutral)";
        lines.push(`  Williams %R(14) = ${fmtValue(v)}${zone}`);
        break;
      }
    }
  }
  return lines.join("\n");
}

function fmtValue(v: number | null): string {
  return v === null ? "null" : v.toFixed(2);
}

// ---------------------------------------------------------------------------
// market_scan (F4)
// ---------------------------------------------------------------------------

type SingleValueIndicatorName =
  | "sma"
  | "ema"
  | "rsi"
  | "macd_hist"
  | "roc"
  | "williams";
type ScanOperator = "lt" | "le" | "gt" | "ge" | "eq";

export const marketScanTool: Tool = {
  name: "market_scan",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "market_scan",
      description: `Scan the active watchlist for symbols matching an indicator threshold.

USE WHEN:
- User asks to find symbols meeting a condition (e.g., "what's oversold today?", "find symbols with RSI < 30", "which are above their 50-day SMA?")

NOT WHEN:
- User wants indicators on one specific symbol (use market_indicators)
- User wants to add/remove symbols from the watchlist (use market_watchlist_{add,remove,list})

The scan iterates the active watchlist, computes one indicator per symbol over recent bars, and filters by the operator+threshold. Cache-friendly: warm scans (after a morning data pull) cost zero API calls.

Output: pre-formatted match list with cache-hit summary.`,
      parameters: {
        type: "object",
        properties: {
          indicator: {
            type: "string",
            enum: ["sma", "ema", "rsi", "macd_hist", "roc", "williams"],
            description:
              "Single-value indicator to scan against. Excludes multi-output indicators like full MACD or Bollinger.",
          },
          operator: {
            type: "string",
            enum: ["lt", "le", "gt", "ge", "eq"],
            description: "Comparison: lt, le, gt, ge, eq.",
          },
          threshold: {
            type: "number",
            description:
              "Value to compare against. RSI [0,100], Williams [-100,0], ROC percentage, SMA/EMA absolute price.",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional: only scan watchlist entries whose tags include ANY of these. Empty = whole watchlist.",
          },
          interval: {
            type: "string",
            enum: ["daily", "60min"],
            description: "Bar interval. Default 'daily'.",
          },
          lookback: {
            type: "number",
            description: "Bars per symbol. Default 50.",
          },
        },
        required: ["indicator", "operator", "threshold"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const indicator = args.indicator as SingleValueIndicatorName | undefined;
    const operator = args.operator as ScanOperator | undefined;
    const threshold = Number(args.threshold);
    if (!indicator || !operator || !Number.isFinite(threshold)) {
      return JSON.stringify({
        error: "indicator, operator, threshold required",
      });
    }
    const interval = (args.interval as "daily" | "60min") ?? "daily";
    // Audit W4+R2: min 35 to ensure MACD signal has data; default raised to 60.
    const rawLookback = Number(args.lookback ?? 60);
    const lookback = Number.isFinite(rawLookback)
      ? Math.min(200, Math.max(35, Math.round(rawLookback)))
      : 60;
    const tagsFilter = (args.tags as string[] | undefined) ?? [];

    const layer = getDataLayer();
    const watchlist = layer.listWatchlist();
    if (watchlist.length === 0) {
      return "market_scan: watchlist is empty. Add symbols with market_watchlist_add first.";
    }
    const filtered = tagsFilter.length
      ? watchlist.filter((w) => w.tags.some((t) => tagsFilter.includes(t)))
      : watchlist;
    if (filtered.length === 0) {
      return `market_scan: no watchlist symbols match tags ${JSON.stringify(tagsFilter)}.`;
    }

    const matches: { symbol: string; value: number }[] = [];
    const skipped: { symbol: string; reason: string }[] = [];

    for (const entry of filtered) {
      try {
        const result =
          interval === "daily"
            ? await layer.getDaily(entry.symbol, { lookback })
            : await layer.getIntraday(entry.symbol, "60min", { lookback });
        if (result.bars.length < 20) {
          skipped.push({ symbol: entry.symbol, reason: "insufficient bars" });
          continue;
        }
        const value = computeSingleIndicator(indicator, result.bars);
        if (value === null) {
          skipped.push({ symbol: entry.symbol, reason: "indicator null" });
          continue;
        }
        if (matchesOp(value, operator, threshold)) {
          matches.push({ symbol: entry.symbol, value });
        }
      } catch (err) {
        skipped.push({
          symbol: entry.symbol,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return formatScanResult(
      indicator,
      operator,
      threshold,
      filtered.length,
      matches,
      skipped,
    );
  },
};

function computeSingleIndicator(
  name: SingleValueIndicatorName,
  bars: MarketBar[],
): number | null {
  const closes = bars.map((b) => b.close);
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);
  switch (name) {
    case "sma":
      return latest(sma(closes, 20));
    case "ema":
      return latest(ema(closes, 20));
    case "rsi":
      return latest(rsi(closes, 14));
    case "macd_hist":
      return latest(macd(closes).histogram);
    case "roc":
      return latest(roc(closes, 10));
    case "williams":
      return latest(williamsR(highs, lows, closes, 14));
  }
}

function matchesOp(
  value: number,
  op: ScanOperator,
  threshold: number,
): boolean {
  switch (op) {
    case "lt":
      return value < threshold;
    case "le":
      return value <= threshold;
    case "gt":
      return value > threshold;
    case "ge":
      return value >= threshold;
    case "eq":
      return Math.abs(value - threshold) < 1e-9;
  }
}

function formatScanResult(
  indicator: string,
  operator: string,
  threshold: number,
  scanned: number,
  matches: { symbol: string; value: number }[],
  skipped: { symbol: string; reason: string }[],
): string {
  const lines: string[] = [
    `market_scan: indicator=${indicator} operator=${operator} threshold=${threshold} (scanned ${scanned})`,
    `  Matches (${matches.length}):`,
  ];
  if (matches.length === 0) {
    lines.push("    (none)");
  } else {
    // Audit W2: order matches by relevance to the predicate.
    //   lt/le → ascending (deepest-below first)
    //   gt/ge → descending (highest-above first)
    //   eq    → ascending |delta| (closest-to-threshold first)
    if (operator === "gt" || operator === "ge") {
      matches.sort((a, b) => b.value - a.value);
    } else if (operator === "eq") {
      matches.sort(
        (a, b) => Math.abs(a.value - threshold) - Math.abs(b.value - threshold),
      );
    } else {
      matches.sort((a, b) => a.value - b.value);
    }
    for (const m of matches) {
      lines.push(`    ${m.symbol}: ${m.value.toFixed(2)}`);
    }
  }
  if (skipped.length > 0) {
    lines.push(`  Skipped (${skipped.length}):`);
    for (const s of skipped.slice(0, 5)) {
      lines.push(`    ${s.symbol}: ${s.reason}`);
    }
    if (skipped.length > 5)
      lines.push(`    ... and ${skipped.length - 5} more`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// macro_regime (F5)
// ---------------------------------------------------------------------------

export const macroRegimeTool: Tool = {
  name: "macro_regime",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "macro_regime",
      description: `Classify the current US macro regime from FRED + Alpha Vantage series.

USE WHEN:
- User asks about economic regime, recession risk, yield curve, inflation, fed policy
- Need macro context before interpreting market signals
- Morning briefing wants a regime snapshot

Regimes: expansion / tightening / recession_risk / recovery / mixed
Each classification includes: yield curve (10Y-2Y), fed funds, VIX, unemployment,
CPI YoY, M2 YoY, initial jobless claims, plus a reasons[] list and confidence (0..1).

Cost: one call pulls 8 macro series (FEDFUNDS + CPI + UNEMPLOYMENT + TREASURY_YIELD x2
via AV, VIXCLS + ICSA + M2SL via FRED). Cache-friendly on repeat queries via the
DataLayer macro cache (6-hour TTL).`,
      parameters: { type: "object", properties: {} },
    },
  },

  async execute(): Promise<string> {
    const layer = getDataLayer();
    const [
      fedFunds,
      cpi,
      unemployment,
      treasury2y,
      treasury10y,
      vixcls,
      icsa,
      m2,
    ] = await Promise.all([
      safeMacro(layer, "FEDFUNDS"),
      safeMacro(layer, "CPI"),
      safeMacro(layer, "UNEMPLOYMENT"),
      safeMacro(layer, "TREASURY_2Y"),
      safeMacro(layer, "TREASURY_10Y"),
      safeMacro(layer, "VIXCLS"),
      safeMacro(layer, "ICSA"),
      safeMacro(layer, "M2SL"),
    ]);
    const bundle: MacroSeriesBundle = {
      fedFunds,
      cpi,
      unemployment,
      treasury2y,
      treasury10y,
      vixcls,
      icsa,
      m2,
    };
    // Audit W4: count unavailable series so the user sees when the regime
    // classification is running on starved inputs.
    const emptyCount = Object.values(bundle).filter(
      (s: MacroPoint[]) => s.length === 0,
    ).length;
    const regime = classifyRegime(bundle);
    let header = formatRegime(regime);
    if (emptyCount >= 6) {
      header =
        `WARNING: ${emptyCount} of 8 macro series unavailable — regime classification unreliable.\n` +
        header;
    } else if (emptyCount >= 3) {
      header =
        `NOTE: ${emptyCount} of 8 macro series unavailable — treat regime with caution.\n` +
        header;
    }
    return header;
  },
};

async function safeMacro(
  layer: ReturnType<typeof getDataLayer>,
  series: string,
) {
  try {
    return await layer.getMacro(series);
  } catch {
    return [];
  }
}

function formatRegime(r: MacroRegime): string {
  const lines: string[] = [
    `Regime: ${r.regime} (confidence ${r.confidence.toFixed(2)})`,
  ];
  if (r.yieldCurve !== null) {
    lines.push(`  Yield curve (10Y-2Y): ${r.yieldCurve.toFixed(2)}`);
  }
  if (r.fedRate !== null) lines.push(`  Fed funds: ${r.fedRate.toFixed(2)}`);
  if (r.vix !== null) lines.push(`  VIX: ${r.vix.toFixed(1)}`);
  if (r.unemployment !== null) {
    lines.push(`  Unemployment: ${r.unemployment.toFixed(1)}`);
  }
  if (r.inflationYoY !== null) {
    lines.push(`  CPI YoY: ${r.inflationYoY.toFixed(1)}%`);
  }
  if (r.m2GrowthYoY !== null) {
    lines.push(`  M2 YoY: ${r.m2GrowthYoY.toFixed(1)}%`);
  }
  if (r.initialClaims !== null) {
    lines.push(`  Initial claims: ${r.initialClaims.toLocaleString()}`);
  }
  if (r.reasons.length > 0) {
    lines.push(`  Reasons: ${r.reasons.join("; ")}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// market_signals (F3)
// ---------------------------------------------------------------------------

const ALL_SIGNAL_TYPES: SignalType[] = [
  "ma_crossover",
  "rsi_extreme",
  "macd_crossover",
  "bollinger_breakout",
  "volume_spike",
  "price_threshold",
];

export const marketSignalsTool: Tool = {
  name: "market_signals",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "market_signals",
      description: `Detect recent technical signals on one symbol or the whole watchlist.

USE WHEN:
- User asks "any signals firing?", "what's triggering?", "show me crossovers/breakouts"
- Morning/EOD scan wants the recent signal list

Detectors (6): ma_crossover (golden/death cross), rsi_extreme (overbought/oversold),
macd_crossover (histogram sign change), bollinger_breakout (close outside bands),
volume_spike (z-score > 2σ), price_threshold (explicit user thresholds).

If 'symbol' is omitted, scans the active watchlist. Persists detected signals
to the market_signals DB table for F7 alpha-combination consumption.`,
      parameters: {
        type: "object",
        properties: {
          symbol: {
            type: "string",
            description: "Single symbol to scan. Omit to scan whole watchlist.",
          },
          interval: {
            type: "string",
            enum: ["daily", "60min"],
            description: "Bar interval. Default 'daily'.",
          },
          lookback: {
            type: "number",
            description: "Bars per symbol. Default 100, min 40, max 250.",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description:
              "If scanning watchlist, restrict to entries with any of these tags.",
          },
          types: {
            type: "array",
            items: {
              type: "string",
              enum: [
                "ma_crossover",
                "rsi_extreme",
                "macd_crossover",
                "bollinger_breakout",
                "volume_spike",
                "price_threshold",
              ],
            },
            description: "Which detectors to run. Default: all six.",
          },
          price_thresholds: {
            type: "array",
            items: { type: "number" },
            description:
              "Specific price levels to monitor. Used only if types includes 'price_threshold'.",
          },
        },
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const interval = (args.interval as "daily" | "60min") ?? "daily";
    const rawLookback = Number(args.lookback ?? 100);
    const lookback = Number.isFinite(rawLookback)
      ? Math.min(250, Math.max(40, Math.round(rawLookback)))
      : 100;
    const typesFilter =
      (args.types as SignalType[] | undefined) ?? ALL_SIGNAL_TYPES;
    const priceThresholds =
      (args.price_thresholds as number[] | undefined) ?? [];
    const tagsFilter = (args.tags as string[] | undefined) ?? [];
    const symbolArg = (args.symbol as string | undefined)
      ?.trim()
      ?.toUpperCase();

    const layer = getDataLayer();
    const targetSymbols: string[] = [];

    if (symbolArg) {
      targetSymbols.push(symbolArg);
    } else {
      const watchlist = layer.listWatchlist();
      if (watchlist.length === 0) {
        return "market_signals: no symbol provided and watchlist is empty.";
      }
      const filtered = tagsFilter.length
        ? watchlist.filter((w) => w.tags.some((t) => tagsFilter.includes(t)))
        : watchlist;
      for (const w of filtered) targetSymbols.push(w.symbol);
      if (targetSymbols.length === 0) {
        return `market_signals: no watchlist entries match tags ${JSON.stringify(tagsFilter)}.`;
      }
      // Audit W5: cap whole-watchlist scans to prevent runaway budget spend.
      // Explicit single-symbol calls bypass the cap (already bounded).
      const SCAN_CAP = 50;
      if (targetSymbols.length > SCAN_CAP) {
        targetSymbols.length = SCAN_CAP;
      }
    }

    const bySymbol = new Map<string, Signal[]>();
    const skipped: { symbol: string; reason: string }[] = [];
    let consecutiveRateLimit = 0;
    let earlyExit = false;

    for (const symbol of targetSymbols) {
      if (earlyExit) {
        skipped.push({ symbol, reason: "scan aborted (rate-limit cascade)" });
        continue;
      }
      try {
        const result =
          interval === "daily"
            ? await layer.getDaily(symbol, { lookback })
            : await layer.getIntraday(symbol, "60min", { lookback });
        if (result.bars.length < 40) {
          skipped.push({ symbol, reason: "insufficient bars" });
          continue;
        }
        consecutiveRateLimit = 0;
        const all = detectAllSignals(result.bars, {
          priceThresholds,
        });
        const filtered = all.filter((s) => typesFilter.includes(s.type));
        bySymbol.set(symbol, filtered);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        skipped.push({ symbol, reason: msg });
        // Audit W5: 3 consecutive rate-limit errors → bail out rather than
        // burning through the rest of the watchlist with doomed calls.
        if (
          /rate.?limit/i.test(msg) ||
          (err instanceof Error && err.name === "RateLimitedError")
        ) {
          consecutiveRateLimit++;
          if (consecutiveRateLimit >= 3) earlyExit = true;
        } else {
          consecutiveRateLimit = 0;
        }
      }
    }

    // Persist
    const allSignals: Signal[] = [];
    for (const sigs of bySymbol.values()) allSignals.push(...sigs);
    const inserted = persistSignals(allSignals);

    return formatSignalsResult(targetSymbols, bySymbol, skipped, inserted);
  },
};

function formatSignalsResult(
  targets: string[],
  bySymbol: Map<string, Signal[]>,
  skipped: { symbol: string; reason: string }[],
  inserted: number,
): string {
  const lines: string[] = [
    `market_signals: scanned ${targets.length} symbols · ${inserted} new firings persisted`,
  ];
  const orderedSymbols = targets.filter((s) => bySymbol.has(s));
  const withSignals = orderedSymbols.filter(
    (s) => (bySymbol.get(s) ?? []).length > 0,
  );
  if (withSignals.length === 0) {
    lines.push("  No signals fired.");
  } else {
    for (const symbol of withSignals) {
      const sigs = bySymbol.get(symbol)!;
      lines.push(`\n${symbol} — ${sigs.length} signals:`);
      for (const s of sigs.slice(-10)) {
        // cap output at last 10 per symbol for readability
        lines.push(
          `  ${s.timestamp} | ${s.type} | ${s.direction.padEnd(7)} | ${s.description}`,
        );
      }
    }
  }
  if (skipped.length > 0) {
    lines.push(`\nSkipped (${skipped.length}):`);
    for (const s of skipped.slice(0, 5)) {
      lines.push(`  ${s.symbol}: ${s.reason}`);
    }
    if (skipped.length > 5) {
      lines.push(`  ... and ${skipped.length - 5} more`);
    }
  }
  return lines.join("\n");
}
