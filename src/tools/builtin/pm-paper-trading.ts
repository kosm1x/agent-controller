/**
 * F8.1b — Polymarket paper-trading tools.
 *
 * pm_paper_rebalance   (write) — runs PM rebalance from `pm_alpha_latest`
 * pm_paper_portfolio   (read)  — current PM positions + USDC cash + equity
 * pm_paper_history     (read)  — recent PM fills
 *
 * All deferred, all in the new `pm_paper` scope group. Parallel to F8's
 * equity paper tools but scoped to Polymarket. At v1 there is NO F7.5 ship-gate
 * integration (deferred to F8.1c).
 */

import type { Tool } from "../types.js";
import { PolymarketPaperAdapter } from "../../finance/pm-paper-adapter.js";
import {
  runPmRebalance,
  type PmTokenTarget,
} from "../../finance/pm-paper-executor.js";
import { readLatestPmAlphaRun } from "../../finance/pm-alpha-persist.js";
import { isPolymarketPosition } from "../../finance/venue-types.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function fmt(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}

function fmtPct(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(digits)}%`;
}

// ---------------------------------------------------------------------------
// pm_paper_rebalance (WRITE)
// ---------------------------------------------------------------------------

export const pmPaperRebalanceTool: Tool = {
  name: "pm_paper_rebalance",
  deferred: true,
  riskTier: "medium",
  definition: {
    type: "function",
    function: {
      name: "pm_paper_rebalance",
      description: `Executes a Polymarket paper-trading rebalance from the latest \`pm_alpha_run\` output.

Pipeline:
  pm_alpha_latest → per-token |weight| × total_equity sizing → diff vs current
  PM positions → sells-first ordering → synthetic fills at midpoint × (1 ± 20 bps
  slip) → persists fills + PM thesis row.

USE WHEN operator asks to "rebalance polymarket positions", "pm paper trade",
"ejecuta pm rebalance", "rotar polymarket", "aplica pesos polymarket".
NOT WHEN equity rebalance (use \`paper_rebalance\` — F8) or alpha analysis only
(use \`pm_alpha_run\` / \`pm_alpha_latest\`).

No F7.5 ship_gate at v1 — deferred to F8.1d. Negative α weights now open
NO-side positions (buy the complement outcome) as of F8.1c; legacy v1
exit-only behavior is no longer active.

Cadence param (F8.1c): "weekly" (default, preserves F8.1b behavior) or
"daily". Daily cadence uses a 24h staleness gate + tags thesis entry_signal
as pm_daily_rebalance for audit separation.

Takes ~0.5-1s. Starts with $10K USDC paper cash on first run. No leverage.
MARKET orders only. Dust threshold: $10 per trade.`,
      parameters: {
        type: "object",
        properties: {
          cost_bps: {
            type: "number",
            description:
              "Slippage applied per side in basis points. Default 20.",
          },
          initial_cash: {
            type: "number",
            description:
              "Starting USDC on first run. Ignored if account exists. Default 10000.",
          },
          notes: {
            type: "string",
            description:
              "Free-form notes stored with the thesis. Max 500 chars.",
          },
          override_ship_gate: {
            type: "boolean",
            description:
              "Placeholder for F8.1d firewall; logged in thesis for audit. No effect at v1 (no ship-gate exists yet).",
          },
          allow_stale: {
            type: "boolean",
            description:
              "When true, bypass the pre-trade stale-position abort. Default false — held positions with stale marks make sizing untrustworthy and orders are skipped.",
          },
          cadence: {
            type: "string",
            enum: ["weekly", "daily"],
            description:
              "Rebalance cadence (F8.1c). 'weekly' (default) uses the 5d staleness gate and tags entry_signal=pm_weekly_rebalance. 'daily' uses a 24h staleness gate and tags entry_signal=pm_daily_rebalance — used by the PM daily ritual.",
          },
        },
        required: [],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const costBps =
      typeof args.cost_bps === "number" &&
      args.cost_bps >= 0 &&
      args.cost_bps <= 500
        ? args.cost_bps
        : undefined;
    const initialCash =
      typeof args.initial_cash === "number" && args.initial_cash > 0
        ? args.initial_cash
        : undefined;
    const notes =
      typeof args.notes === "string" ? args.notes.slice(0, 500) : undefined;
    const overrideShip = args.override_ship_gate === true;
    const allowStale = args.allow_stale === true;
    const cadence: "weekly" | "daily" =
      args.cadence === "daily" ? "daily" : "weekly";
    const quoteStaleMs =
      cadence === "daily" ? 24 * 60 * 60 * 1000 : 5 * 24 * 60 * 60 * 1000;

    const pmAlpha = readLatestPmAlphaRun();
    if (!pmAlpha) {
      return `pm_paper_rebalance: no pm_alpha_run found. Run \`pm_alpha_run\` first to produce per-token weights.`;
    }

    // Extract signed weights per (market_id, outcome). Only active (non-excluded)
    // tokens contribute; excluded rows stay out of the rebalance.
    const targets: PmTokenTarget[] = [];
    for (const t of pmAlpha.tokens) {
      if (t.excluded) continue;
      // Filter NaN + near-zero: both produce no useful order. Without the
      // NaN guard, `Math.abs(NaN) < 1e-9` is false and the bogus target
      // flows through to a zero_quantity reject.
      if (!Number.isFinite(t.weight)) continue;
      if (Math.abs(t.weight) < 1e-9) continue;
      targets.push({
        marketId: t.marketId,
        outcome: t.outcome,
        weight: t.weight,
      });
    }
    if (targets.length === 0) {
      return `pm_paper_rebalance: pm_alpha run ${pmAlpha.runId} has no active weights. Nothing to trade.`;
    }

    const adapter = new PolymarketPaperAdapter({
      initialCash,
      slippageBps: costBps,
      quoteStaleMs,
    });

    const summary = await runPmRebalance({
      adapter,
      targets,
      pmAlphaRunId: pmAlpha.runId,
      shipOverride: overrideShip,
      notes,
      allowStale,
      cadence,
    });

    const lines: string[] = [];
    lines.push(
      `pm_paper_rebalance: thesis_id=${summary.thesisId}  pm_alpha=${pmAlpha.runId.slice(0, 8)}  cadence=${cadence}`,
    );
    lines.push(
      `  equity: ${fmt(summary.totalEquityBefore)} → ${fmt(summary.totalEquityAfter)}  cash: ${fmt(summary.cashBefore)} → ${fmt(summary.cashAfter)}`,
    );
    lines.push(
      `  orders: planned=${summary.ordersPlanned}  skipped=${summary.ordersSkipped}  filled=${summary.fills.length}  rejected=${summary.rejects.length}`,
    );
    if (overrideShip) {
      lines.push(
        `  ⚠  SHIP_GATE OVERRIDE flagged in thesis (no gate at v1; honored for audit)`,
      );
    }
    if (summary.staleMarkets.length > 0) {
      lines.push(
        `  ⚠  stale markets: ${summary.staleMarkets.slice(0, 5).join(", ")}${summary.staleMarkets.length > 5 ? ` +${summary.staleMarkets.length - 5} more` : ""}`,
      );
    }
    if (summary.stalePositionsAborted) {
      lines.push(
        `  ⛔ STALE_ABORT: rebalance skipped; pass allow_stale=true to force.`,
      );
    }
    if (summary.fills.length > 0) {
      lines.push(`  fills:`);
      for (const f of summary.fills.slice(0, 10)) {
        lines.push(
          `    ${f.side.toUpperCase().padEnd(4)} ${f.symbol.padEnd(32)} ${fmt(f.quantity, 2).padStart(10)} sh @ ${fmt(f.price, 4)}  notional=${fmt(f.grossNotional)}`,
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
// pm_paper_portfolio (READ)
// ---------------------------------------------------------------------------

export const pmPaperPortfolioTool: Tool = {
  name: "pm_paper_portfolio",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "pm_paper_portfolio",
      description: `Current Polymarket paper portfolio: positions (market + outcome + shares + avg_cost + market_value + unr P&L), USDC cash, total equity.

USE WHEN operator asks "pm portfolio", "polymarket positions", "posiciones polymarket".
NOT WHEN asking for trade history (use \`pm_paper_history\`) or equity positions (use \`paper_portfolio\`).

Read-only, ~100ms. Marks to market using cached midpoint per token.`,
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },

  async execute(): Promise<string> {
    const adapter = new PolymarketPaperAdapter();
    const balance = await adapter.getBalance();
    const positions = (await adapter.getPositions()).filter(
      isPolymarketPosition,
    );

    const lines: string[] = [];
    lines.push(
      `pm_paper_portfolio: equity=${fmt(balance.totalEquity)}  cash=${fmt(balance.cash)}  positions=${fmt(balance.positionsValue)}  n=${positions.length}`,
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
      const token = `${p.slug ?? p.marketId.slice(0, 8)}/${p.outcome}`;
      const staleTag = p.stale ? " ⚠stale" : "";
      lines.push(
        `    ${token.padEnd(28)} ${fmt(p.shares, 2).padStart(10)} sh  cost=${fmt(p.avgCost, 4)}  mv=${fmt(p.marketValue)}  unr=${fmt(p.unrealizedPnl)} (${fmtPct(unrPct)})${staleTag}`,
      );
    }
    return lines.join("\n");
  },
};

// ---------------------------------------------------------------------------
// pm_paper_history (READ)
// ---------------------------------------------------------------------------

export const pmPaperHistoryTool: Tool = {
  name: "pm_paper_history",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "pm_paper_history",
      description: `Recent Polymarket paper fills. Filter by market_id (Polymarket condition_id UUID), outcome, since-date, limit.

USE WHEN operator asks "pm history", "polymarket fills", "historial de pm paper".
NOT WHEN asking for current positions (use \`pm_paper_portfolio\`) or equity (use \`paper_history\`).

Read-only.`,
      parameters: {
        type: "object",
        properties: {
          market_id: {
            type: "string",
            description:
              "Filter to a specific Polymarket condition_id. Omit for all.",
          },
          outcome: {
            type: "string",
            description:
              "Filter to a specific outcome label (e.g. 'Yes', 'No'). Omit for all.",
          },
          since: {
            type: "string",
            description:
              "ISO date (YYYY-MM-DD) or full ISO 8601. Only return fills at/after this time.",
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
    const marketId =
      typeof args.market_id === "string" ? args.market_id : undefined;
    const outcome = typeof args.outcome === "string" ? args.outcome : undefined;
    let since = typeof args.since === "string" ? args.since : undefined;
    if (since && ISO_DATE.test(since)) since = `${since}T00:00:00Z`;
    const limit =
      typeof args.limit === "number" && args.limit >= 1 && args.limit <= 1000
        ? Math.floor(args.limit)
        : 20;

    const adapter = new PolymarketPaperAdapter();
    // Build adapter-format symbol filter if both supplied.
    const symbol = marketId && outcome ? `${marketId}:${outcome}` : undefined;
    // If only one is supplied, fall back to raw getFills with market_id
    // equality — adapter only accepts symbol matches, so read raw in that case.
    const fills = symbol
      ? await adapter.getFills({ symbol, since, limit })
      : await adapter.getFills({ since, limit });
    const filtered = fills.filter((f) => {
      if (marketId && !f.symbol.startsWith(`${marketId}:`)) return false;
      if (outcome && !f.symbol.endsWith(`:${outcome}`)) return false;
      return true;
    });

    const lines: string[] = [];
    lines.push(
      `pm_paper_history: n=${filtered.length}${marketId ? ` market_id=${marketId.slice(0, 10)}` : ""}${outcome ? ` outcome=${outcome}` : ""}${since ? ` since=${since}` : ""}`,
    );
    if (filtered.length === 0) {
      lines.push(`  (no fills)`);
      return lines.join("\n");
    }
    for (const f of filtered) {
      lines.push(
        `  ${f.filledAt.slice(0, 19)}  ${f.side.toUpperCase().padEnd(4)} ${f.symbol.padEnd(32)} ${fmt(f.quantity, 2).padStart(10)} sh @ ${fmt(f.price, 4)}  notional=${fmt(f.grossNotional)}`,
      );
    }
    return lines.join("\n");
  },
};

export const pmPaperTradingTools: Tool[] = [
  pmPaperRebalanceTool,
  pmPaperPortfolioTool,
  pmPaperHistoryTool,
];

// Suppress unused-import warning for UUID_RE — retained for future
// operator-facing run_id validation when explain tool lands (F8.1b.2).
void UUID_RE;
