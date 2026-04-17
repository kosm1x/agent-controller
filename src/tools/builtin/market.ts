/**
 * F1 finance tools — market_quote, market_history, market_watchlist_*,
 * market_budget_stats.
 *
 * All deferred: true (loaded only when `finance` scope activates).
 * Output pre-formatted for LLM consumption per feedback_preformat_over_prompt.
 */

import type { Tool } from "../types.js";
import { getDataLayer } from "../../finance/data-layer.js";
import type { AssetClass, MarketBar } from "../../finance/types.js";
import { budgetSummary } from "../../finance/budget.js";
import { currentWindow, ceilings } from "../../finance/rate-limit.js";

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
