/**
 * F8 Paper Trading tools — `paper_rebalance`, `paper_portfolio`, `paper_history`.
 *
 * All deferred. Loaded when the `paper` scope activates. Pre-formatted text
 * output per feedback_preformat_over_prompt.
 *
 * paper_rebalance  (write) — run the full pipeline: read alpha_latest +
 *                             backtest_latest → check ship_gate → fetch prices
 *                             → diff vs current → execute fills → persist.
 * paper_portfolio  (read)  — current positions + cash + total equity
 * paper_history    (read)  — recent fills with P&L
 */

import type { Tool } from "../types.js";
import { readLatestAlphaRun } from "../../finance/alpha-persist.js";
import { readLatestBacktest } from "../../finance/backtest-persist.js";
import { PaperEquityAdapter } from "../../finance/paper-equity-adapter.js";
import { runRebalance } from "../../finance/paper-executor.js";
import { parseSignalKey } from "../../finance/alpha-matrix.js";
import type { AlphaRunResult } from "../../finance/alpha-combination.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Flatten F7 alpha weights to per-symbol notional weights. Excluded signals
 * and zero-weight signals are dropped; multiple signals on the same symbol
 * are summed.
 */
function weightsBySymbol(alpha: AlphaRunResult): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of alpha.signals) {
    if (s.excluded || s.weight === 0) continue;
    const { symbol } = parseSignalKey(s.signalKey);
    out[symbol] = (out[symbol] ?? 0) + s.weight;
  }
  return out;
}

function fmt(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}

function fmtPct(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(digits)}%`;
}

// ---------------------------------------------------------------------------
// paper_rebalance (WRITE)
// ---------------------------------------------------------------------------

export const paperRebalanceTool: Tool = {
  name: "paper_rebalance",
  deferred: true,
  riskTier: "medium",
  definition: {
    type: "function",
    function: {
      name: "paper_rebalance",
      description: `Run a paper-trading rebalance on the default $100K simulated account.

Pipeline:
  alpha_latest → backtest_latest → ship_gate check → fetch weekly prices
  → diff vs current positions → execute MARKET fills at close × 5 bps slippage
  → persist fills + PORTFOLIO thesis row.

Ship-gate: refuses to trade when F7.5 flags \`ship_blocked=1\` unless
\`override_ship_gate=true\` (the override is logged in the thesis row).

USE WHEN operator asks to paper-trade, execute the strategy, rebalance,
"ejecuta el paper trade", "rebalancear la cartera", "pon el portafolio",
"rotar posiciones".
NOT WHEN asking for current positions (use \`paper_portfolio\`) or last fills
(use \`paper_history\`). Do NOT use for Polymarket / prediction-market trading
— that's F8.1 (not implemented).

Takes ~0.5-2 seconds. Starts with $100,000 cash on first run. No leverage,
no shorts, no options. MARKET orders only. Weekly cadence.`,
      parameters: {
        type: "object",
        properties: {
          override_ship_gate: {
            type: "boolean",
            description:
              "Proceed even if F7.5 reports ship_blocked=1. Logged in thesis. Default false.",
          },
          override_stale: {
            type: "boolean",
            description:
              "Proceed even if held positions have stale quotes (>5 weeks old). Distorts target sizing; use only if you know the prices are close. Default false.",
          },
          initial_cash: {
            type: "number",
            description:
              "Override starting cash on first run. Ignored if account already exists. Default 100000.",
          },
          notes: {
            type: "string",
            description:
              "Free-form notes stored with the thesis (e.g. 'manual override — testing'). Max 500 chars.",
          },
        },
        required: [],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const overrideShipGate = args.override_ship_gate === true;
    const overrideStale = args.override_stale === true;
    const initialCash =
      typeof args.initial_cash === "number" && args.initial_cash > 0
        ? args.initial_cash
        : undefined;
    const rawNotes =
      typeof args.notes === "string" ? args.notes.slice(0, 500) : undefined;

    const alpha = readLatestAlphaRun();
    if (!alpha) {
      return `paper_rebalance: no alpha run found. Run \`alpha_run\` first to produce signal weights.`;
    }
    // Audit W1 round 1: prefer the latest 'flam' run, but fall back to the
    // latest overall run if 'flam' doesn't exist yet. Avoids a hard failure
    // when the strategy name evolves.
    const backtest = readLatestBacktest("flam") ?? readLatestBacktest();
    if (!backtest) {
      return `paper_rebalance: no backtest run found. Run \`backtest_run\` first to check the ship_gate.`;
    }

    const shipBlocked = backtest.run.ship_blocked === 1;
    if (shipBlocked && !overrideShipGate) {
      const pbo = fmt(backtest.run.pbo, 4);
      const dsr = fmt(backtest.run.dsr_pvalue, 4);
      return [
        `paper_rebalance: SHIP_BLOCKED by F7.5 firewall.`,
        `  latest backtest run_id=${backtest.run.run_id}`,
        `  PBO=${pbo} (threshold 0.50)  DSR_pvalue=${dsr} (threshold 0.05)`,
        `  Pass override_ship_gate: true to force. The override is logged.`,
      ].join("\n");
    }

    const targetWeights = weightsBySymbol(alpha);
    if (Object.keys(targetWeights).length === 0) {
      return `paper_rebalance: alpha run ${alpha.runId} has no active weights (all signals excluded). Nothing to trade.`;
    }

    const adapter = new PaperEquityAdapter({ initialCash });

    const summary = await runRebalance({
      adapter,
      targetWeights,
      alphaRunId: alpha.runId,
      backtestRunId: backtest.run.run_id,
      regime: alpha.regime,
      shipBlocked,
      overrideShip: overrideShipGate && shipBlocked,
      allowStale: overrideStale,
      notes: rawNotes,
    });

    const lines: string[] = [];
    lines.push(
      `paper_rebalance: thesis_id=${summary.thesisId}  alpha=${alpha.runId.slice(0, 8)}  backtest=${backtest.run.run_id.slice(0, 8)}  strategy=${backtest.run.strategy}`,
    );

    // Audit W-R2-2 round 2: surface stale-abort explicitly. Otherwise the
    // operator sees a 0-order response with no reason to refresh prices.
    if (summary.stalePositionsAborted) {
      lines.push(
        `  ⚠  ABORTED: stale quotes for ${summary.staleSymbols.join(", ")}. Refresh prices or pass override_stale=true.`,
      );
      return lines.join("\n");
    }

    lines.push(
      `  equity: ${fmt(summary.totalEquityBefore)} → ${fmt(summary.totalEquityAfter)}  cash: ${fmt(summary.cashBefore)} → ${fmt(summary.cashAfter)}`,
    );
    lines.push(
      `  orders: planned=${summary.ordersPlanned}  skipped=${summary.ordersSkipped}  filled=${summary.fills.length}  rejected=${summary.rejects.length}`,
    );
    if (overrideShipGate && shipBlocked) {
      lines.push(
        `  ⚠  SHIP_GATE OVERRIDDEN — PBO=${fmt(backtest.run.pbo, 4)} DSR_p=${fmt(backtest.run.dsr_pvalue, 4)}`,
      );
    }
    if (overrideStale) {
      lines.push(`  ⚠  STALE QUOTES ALLOWED — totalEquity may be distorted.`);
    }
    if (summary.fills.length > 0) {
      lines.push(`  fills:`);
      for (const f of summary.fills.slice(0, 10)) {
        lines.push(
          `    ${f.side.toUpperCase().padEnd(4)} ${f.symbol.padEnd(6)} ${fmt(f.quantity, 4)} @ ${fmt(f.price)}  notional=${fmt(f.grossNotional)}`,
        );
      }
      if (summary.fills.length > 10) {
        lines.push(`    (+ ${summary.fills.length - 10} more fills)`);
      }
    }
    if (summary.rejects.length > 0) {
      const byReason = new Map<string, number>();
      for (const r of summary.rejects)
        byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + 1);
      const parts = Array.from(byReason.entries()).map(([k, v]) => `${k}=${v}`);
      lines.push(`  rejects: ${parts.join(", ")}`);
    }
    return lines.join("\n");
  },
};

// ---------------------------------------------------------------------------
// paper_portfolio (READ)
// ---------------------------------------------------------------------------

export const paperPortfolioTool: Tool = {
  name: "paper_portfolio",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "paper_portfolio",
      description: `Return the current paper-trading portfolio: positions (symbol + shares + avg_cost + market_value + unrealized P&L), cash, total equity, cumulative return since account open.

USE WHEN operator asks "what's in the paper account", "ver el portafolio",
"current positions", "cartera actual".
NOT WHEN asking for the trade history (use \`paper_history\`) or to place
orders (use \`paper_rebalance\`).

Read-only, ~100ms. Marks to market using latest weekly close per symbol.`,
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },

  async execute(): Promise<string> {
    const adapter = new PaperEquityAdapter();
    const balance = await adapter.getBalance();
    const positions = await adapter.getPositions();

    const lines: string[] = [];
    lines.push(
      `paper_portfolio: equity=${fmt(balance.totalEquity)}  cash=${fmt(balance.cash)}  positions=${fmt(balance.positionsValue)}  n=${positions.length}`,
    );
    if (positions.length === 0) {
      lines.push(`  (no open positions)`);
      return lines.join("\n");
    }
    lines.push(`  positions:`);
    const sorted = [...positions].sort((a, b) => b.marketValue - a.marketValue);
    for (const p of sorted) {
      const unrPct =
        p.avgCost > 0
          ? (p.marketValue - p.shares * p.avgCost) / (p.shares * p.avgCost)
          : 0;
      lines.push(
        `    ${p.symbol.padEnd(6)} ${fmt(p.shares, 4).padStart(10)} sh  cost=${fmt(p.avgCost)}  mv=${fmt(p.marketValue)}  unr=${fmt(p.unrealizedPnl, 2)} (${fmtPct(unrPct, 2)})`,
      );
    }
    return lines.join("\n");
  },
};

// ---------------------------------------------------------------------------
// paper_history (READ)
// ---------------------------------------------------------------------------

export const paperHistoryTool: Tool = {
  name: "paper_history",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "paper_history",
      description: `Return recent paper-trading fills. Filter by symbol or since-date.

USE WHEN operator asks "qué he tradeado", "last trades", "historial de fills",
"paper trade history".

Read-only, no side effects.`,
      parameters: {
        type: "object",
        properties: {
          symbol: {
            type: "string",
            description:
              "Filter to a specific symbol (case-sensitive, e.g. 'AAPL'). Omit for all.",
          },
          since: {
            type: "string",
            description:
              "ISO date (YYYY-MM-DD) or full ISO 8601 timestamp. Only return fills at/after this time. Default: all history.",
          },
          limit: {
            type: "number",
            description:
              "Max fills to return (1..1000). Default 20. Newer fills first.",
          },
        },
        required: [],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const symbol = typeof args.symbol === "string" ? args.symbol : undefined;
    let since = typeof args.since === "string" ? args.since : undefined;
    if (since && ISO_DATE.test(since)) since = `${since}T00:00:00Z`;
    const limit =
      typeof args.limit === "number" && args.limit >= 1 && args.limit <= 1000
        ? Math.floor(args.limit)
        : 20;

    const adapter = new PaperEquityAdapter();
    const fills = await adapter.getFills({ symbol, since, limit });

    const lines: string[] = [];
    lines.push(
      `paper_history: n=${fills.length}${symbol ? ` symbol=${symbol}` : ""}${since ? ` since=${since}` : ""}`,
    );
    if (fills.length === 0) {
      lines.push(`  (no fills)`);
      return lines.join("\n");
    }
    for (const f of fills) {
      lines.push(
        `  ${f.filledAt.slice(0, 19)}  ${f.side.toUpperCase().padEnd(4)} ${f.symbol.padEnd(6)} ${fmt(f.quantity, 4).padStart(10)} @ ${fmt(f.price)}  notional=${fmt(f.grossNotional)}`,
      );
    }
    return lines.join("\n");
  },
};

export const paperTradingTools: Tool[] = [
  paperRebalanceTool,
  paperPortfolioTool,
  paperHistoryTool,
];
