/**
 * F8.1b — Polymarket paper-trading rebalance executor.
 *
 * Consumes `pm_alpha_latest` weights, sizes each active token by
 * `|weight| × total_equity`, diffs vs current holdings, generates orders
 * (sells-first), executes via the injected adapter, persists a
 * `trade_theses` row with `entry_signal='pm_{cadence}_rebalance'`.
 *
 * Parallel to F8's equity `paper-executor.ts` but keyed on
 * (marketId, outcome) rather than symbol.
 *
 * F8.1c — negative α-weights open NO-side positions by rewriting the target
 * onto the complement outcome (binary markets only). Multi-outcome markets
 * skip the short and log `multi_outcome_short_unsupported`. `cadence` param
 * threads through to `entry_signal` so daily vs weekly runs are separable
 * in audit queries.
 */

import { randomUUID } from "node:crypto";
import type {
  Fill,
  Order,
  OrderReject,
  OrderResult,
  VenueAdapter,
} from "./venue-types.js";
import { isFill, isOrderReject } from "./venue-types.js";
import {
  insertPmPortfolioThesis,
  linkPmFillsToThesis,
} from "./pm-paper-persist.js";
import { getDatabase } from "../db/index.js";

const SHARES_PRECISION = 1e4;
const DUST_MIN_NOTIONAL = 10; // $10 USDC — don't churn on sub-threshold deltas
// Leave a small cash buffer to absorb slip + rounding on buys; parallels
// F8's paper-executor.ts. 20 bps ≈ 2× default PM slippage.
const TARGET_CASH_BUFFER_BPS = 20;

function roundShares(x: number): number {
  return Math.round(x * SHARES_PRECISION) / SHARES_PRECISION;
}

export interface PmTokenTarget {
  marketId: string;
  outcome: string;
  /** Signed weight from pm_alpha_latest. |weight| × equity = target notional. */
  weight: number;
}

export interface PmRebalanceOpts {
  adapter: VenueAdapter;
  /** Per-token target weights (signed). */
  targets: PmTokenTarget[];
  /** Logical link to the pm_alpha run that produced these weights. */
  pmAlphaRunId: string | null;
  /**
   * True when the operator explicitly overrode the ship-gate. v1 has no
   * PM ship-gate; flag is threaded through for future F8.1c compatibility
   * and audit trail.
   */
  shipOverride: boolean;
  /** Free-form notes persisted with the thesis. */
  notes?: string;
  /** Account override; defaults to adapter's account if it exposes one. */
  account?: string;
  /**
   * When true, skip the pre-trade abort on stale positions. Operator opts in
   * explicitly. Defaults to false — stale marks make sizing untrustworthy.
   */
  allowStale?: boolean;
  /**
   * F8.1c — rebalance cadence. Drives the persisted `entry_signal` so audit
   * queries can distinguish weekly-equity-rhythm runs from PM-native daily
   * runs. Default "weekly" preserves F8.1b behavior.
   */
  cadence?: "weekly" | "daily";
}

export interface PmRebalanceSummary {
  thesisId: number;
  fills: Fill[];
  rejects: OrderReject[];
  totalEquityBefore: number;
  totalEquityAfter: number;
  cashBefore: number;
  cashAfter: number;
  ordersPlanned: number;
  ordersSkipped: number;
  /** Tokens whose pre-trade mark-to-market was stale. */
  staleMarkets: string[];
  /**
   * True when pre-trade aborted because one or more positions had stale
   * marks AND opts.allowStale !== true. No orders were placed; thesis is
   * still persisted for audit.
   */
  stalePositionsAborted: boolean;
}

function resolveAccount(opts: PmRebalanceOpts): string {
  if (opts.account) return opts.account;
  const adapterAny = opts.adapter as unknown as { account?: string };
  return adapterAny.account ?? "default";
}

/** Token symbol format used by PolymarketPaperAdapter. */
function tokenSymbol(marketId: string, outcome: string): string {
  return `${marketId}:${outcome}`;
}

/**
 * F8.1c — resolve the complement outcome for NO-side opens. Binary PM markets
 * use Yes/No (or SÍ/NO, True/False). We match by common complement pairs.
 * Returns null if the market has >2 outcomes or the primary isn't a known
 * side — in which case NO-side shorting is skipped (logged exclusion).
 */
const COMPLEMENT_PAIRS: Array<[string, string]> = [
  ["yes", "no"],
  ["no", "yes"],
  ["true", "false"],
  ["false", "true"],
  ["up", "down"],
  ["down", "up"],
  ["si", "no"],
  ["sí", "no"],
];

/**
 * F8.1c W1 fix — read the cached outcome count for a market to decide
 * whether NO-side shorting is semantically safe. Markets with >2 outcomes
 * can't be shorted by "buying the complement" because the complement's
 * probability mass is spread across multiple tokens, not a single NO token.
 * Returns undefined for unknown markets; the caller treats undefined as
 * "assume binary, proceed" — any subsequent `complementOutcome` or
 * `getMarketData` failure then surfaces a `no_quote` skip instead of a
 * silent mis-hedge. Flip-check: if fail-closed is preferred, caller can
 * treat undefined as "skip" by changing the guard at the call site.
 */
export function marketOutcomeCount(marketId: string): number | undefined {
  try {
    const db = getDatabase();
    const row = db
      .prepare(
        `SELECT outcome_tokens FROM prediction_markets
           WHERE market_id = ? ORDER BY fetched_at DESC LIMIT 1`,
      )
      .get(marketId) as { outcome_tokens: string | null } | undefined;
    if (!row?.outcome_tokens) return undefined;
    const parsed = JSON.parse(row.outcome_tokens);
    return Array.isArray(parsed) ? parsed.length : undefined;
  } catch {
    return undefined;
  }
}

export function complementOutcome(primary: string): string | null {
  const key = primary.trim().toLowerCase();
  for (const [a, b] of COMPLEMENT_PAIRS) {
    if (key === a) {
      // Preserve capitalization pattern of the primary ("Yes" → "No", "YES" → "NO").
      if (primary === primary.toUpperCase()) return b.toUpperCase();
      if (primary[0] === primary[0].toUpperCase()) {
        return b.charAt(0).toUpperCase() + b.slice(1);
      }
      return b;
    }
  }
  return null;
}

export async function runPmRebalance(
  opts: PmRebalanceOpts,
): Promise<PmRebalanceSummary> {
  const { adapter } = opts;
  const account = resolveAccount(opts);
  const startedAtIso = adapter.clock.now().toISOString();

  // Snapshot pre-trade state.
  const balBefore = await adapter.getBalance();
  const posBefore = await adapter.getPositions();

  // Build (marketId, outcome) → shares map from current PM positions.
  const currentShares = new Map<string, number>();
  const staleMarkets: string[] = [];
  for (const p of posBefore) {
    if (p.kind !== "polymarket") continue;
    const key = tokenSymbol(p.marketId, p.outcome);
    currentShares.set(key, p.shares);
    if (p.stale) staleMarkets.push(key);
  }

  // Fetch quotes for every target. No-quote tokens skip cleanly. For NO-side
  // opens (negative weight), resolve the complement outcome and fetch its
  // quote — the rebalance acts on the NO key, not the YES key.
  const quotes = new Map<string, number>();
  const skipped: string[] = [];
  const targetByKey = new Map<string, PmTokenTarget>();
  for (const t of opts.targets) {
    let effectiveOutcome = t.outcome;
    if (t.weight < 0) {
      // Binary-only guard: if the market has >2 outcomes, "buying the
      // complement" doesn't cleanly hedge the short. Skip with explicit
      // reason so audit queries can spot semantic gaps in alpha output.
      const outcomeCount = marketOutcomeCount(t.marketId);
      if (outcomeCount !== undefined && outcomeCount > 2) {
        skipped.push(
          `${tokenSymbol(t.marketId, t.outcome)}:multi_outcome_short_unsupported`,
        );
        continue;
      }
      const complement = complementOutcome(t.outcome);
      if (!complement) {
        skipped.push(
          `${tokenSymbol(t.marketId, t.outcome)}:multi_outcome_short_unsupported`,
        );
        continue;
      }
      effectiveOutcome = complement;
    }
    const key = tokenSymbol(t.marketId, effectiveOutcome);
    // Rewrite target to the effective (possibly complemented) outcome and
    // flip weight to positive — downstream sizing math is now uniform.
    targetByKey.set(key, {
      marketId: t.marketId,
      outcome: effectiveOutcome,
      weight: Math.abs(t.weight),
    });
    try {
      const q = await adapter.getMarketData(key);
      quotes.set(key, q.price);
    } catch {
      skipped.push(`${key}:no_quote`);
    }
  }

  // Also fetch quotes for holdings that aren't in targets — needed for sizing.
  for (const key of currentShares.keys()) {
    if (quotes.has(key)) continue;
    try {
      const q = await adapter.getMarketData(key);
      quotes.set(key, q.price);
    } catch {
      skipped.push(`${key}:no_quote_for_hold`);
    }
  }

  // Stale-position abort: if any held position has a stale mark and the
  // operator did not opt into allowStale, refuse to trade. Sizing uses
  // totalEquity = cash + Σ(shares × mark); a stale mark skews the target.
  // Thesis is still written for audit via the tail block.
  const stalePositionsAborted = staleMarkets.length > 0 && !opts.allowStale;

  // Plan orders. Union of (target tokens + held tokens).
  const allKeys = new Set<string>([
    ...currentShares.keys(),
    ...targetByKey.keys(),
  ]);
  const orders: Order[] = [];
  if (!stalePositionsAborted) {
    // Derate targets by a small cash buffer so slip + rounding on buys can't
    // push cash negative. Buffer intentionally tiny — PM spreads are much
    // wider than the 20 bps used here and already absorb most friction.
    const cashBufferFactor = 1 - TARGET_CASH_BUFFER_BPS / 10_000;
    for (const key of allKeys) {
      const price = quotes.get(key);
      if (price === undefined || !(price > 0)) continue;
      const held = currentShares.get(key) ?? 0;
      const target = targetByKey.get(key);
      // targetByKey rewriting (above) has already flipped NO-side shorts onto
      // their complement key with positive weight; this path only sees non-
      // negative weights now. Clamp defensively to 0 so any rogue negative
      // (e.g. hand-constructed targets) still collapses to full exit.
      const weight = Math.max(0, target?.weight ?? 0);
      const targetNotional = balBefore.totalEquity * cashBufferFactor * weight;
      const targetShares = roundShares(targetNotional / price);
      const delta = roundShares(targetShares - held);
      if (delta === 0) continue;
      const absNotional = Math.abs(delta) * price;
      // Dust filter: skip sub-threshold rebalances UNLESS this is a full exit
      // (target 0 with held > 0) — closing a dust position should always
      // clear. Without this carve-out, penny-priced stranded shares would
      // accrete forever.
      const isFullExit = targetShares === 0 && held > 0;
      if (absNotional < DUST_MIN_NOTIONAL && !isFullExit) continue;
      orders.push({
        clientOrderId: randomUUID(),
        symbol: key,
        side: delta > 0 ? "buy" : "sell",
        quantity: Math.abs(delta),
        type: "market",
        timeInForce: "day",
      });
    }
  }

  // Sort: sells first (free up cash), then buys. Stable by symbol within side.
  orders.sort((a, b) => {
    if (a.side !== b.side) return a.side === "sell" ? -1 : 1;
    return a.symbol.localeCompare(b.symbol);
  });

  // Execute serially.
  const fills: Fill[] = [];
  const rejects: OrderReject[] = [];
  for (const order of orders) {
    const res: OrderResult = await adapter.placeOrder(order);
    if (isFill(res)) fills.push(res);
    else if (isOrderReject(res)) rejects.push(res);
  }

  // Persist thesis after trades.
  const nowIso = adapter.clock.now().toISOString();
  const targetWeightsDump: Record<string, { outcome: string; weight: number }> =
    {};
  for (const t of opts.targets) {
    // Record the INTENT weight (signed) from the alpha layer, not the
    // rewritten complement — downstream audit wants to see the original
    // alpha decision.
    targetWeightsDump[t.marketId] = { outcome: t.outcome, weight: t.weight };
  }
  // Annotate thesis when aborted so downstream audit queries can distinguish
  // "intentionally flat" from "stale-abort". Mirrors F8 equity's pattern.
  const notesWithAbort = stalePositionsAborted
    ? [opts.notes, `aborted: stale markets: ${staleMarkets.join(", ")}`]
        .filter((s): s is string => !!s)
        .join(" | ")
    : opts.notes;

  const thesisId = insertPmPortfolioThesis(
    {
      account,
      pmAlphaRunId: opts.pmAlphaRunId,
      shipOverride: opts.shipOverride,
      targetWeights: targetWeightsDump,
      notes: notesWithAbort,
      aborted: stalePositionsAborted,
      cadence: opts.cadence ?? "weekly",
    },
    nowIso,
  );

  // Back-link PM fills to thesis by fill_id — concurrent-safe pattern from F8.
  const fillIds = fills.map((f) => f.fillId);
  linkPmFillsToThesis(thesisId, fillIds);
  void startedAtIso;

  const balAfter = await adapter.getBalance();

  return {
    thesisId,
    fills,
    rejects,
    totalEquityBefore: balBefore.totalEquity,
    totalEquityAfter: balAfter.totalEquity,
    cashBefore: balBefore.cash,
    cashAfter: balAfter.cash,
    stalePositionsAborted,
    ordersPlanned: orders.length,
    ordersSkipped: skipped.length,
    staleMarkets,
  };
}
