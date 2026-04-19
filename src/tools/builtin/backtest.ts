/**
 * F7.5 Strategy Backtester tools — `backtest_run`, `backtest_latest`,
 * `backtest_explain`.
 *
 * All deferred. Loaded when the `backtest` scope activates. Pre-formatted text
 * output per feedback_preformat_over_prompt.
 *
 * backtest_run      (write) — walk-forward + CPCV + PBO + DSR; persists 3 tables
 * backtest_latest   (read)  — headline metrics of the most-recent run
 * backtest_explain  (read)  — per-trial/per-fold breakdown for deep audit
 */

import { randomUUID } from "node:crypto";
import type { Tool } from "../types.js";
import { getDatabase } from "../../db/index.js";
import type { BarRow, FiringRow } from "../../finance/alpha-matrix.js";
import {
  runCpcv,
  F75_DEFAULT_GRID,
  type TrialConfig,
} from "../../finance/backtest-cpcv.js";
import { computeOverfitMetrics } from "../../finance/backtest-overfit.js";
import {
  runWalkForward,
  type WalkForwardResult,
} from "../../finance/backtest-walkforward.js";
import {
  persistBacktestRun,
  readBacktestRun,
  readLatestBacktest,
} from "../../finance/backtest-persist.js";
import { todayInNewYork } from "../../finance/alpha-isq.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Minimum weekly bars required for a meaningful backtest. Roughly 180 days. */
const MIN_BARS_FOR_BACKTEST = 26;

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function loadFirings(windowStart: string, windowEnd: string): FiringRow[] {
  const db = getDatabase();
  return db
    .prepare(
      `SELECT symbol, signal_type, direction, strength, triggered_at
         FROM market_signals
         WHERE substr(triggered_at, 1, 10) >= ?
           AND substr(triggered_at, 1, 10) <= ?
         ORDER BY triggered_at ASC`,
    )
    .all(windowStart, windowEnd) as Array<{
    symbol: string;
    signal_type: string;
    direction: "long" | "short" | "neutral";
    strength: number;
    triggered_at: string;
  }>;
}

function loadWeeklyBars(windowStart: string, windowEnd: string): BarRow[] {
  const db = getDatabase();
  return db
    .prepare(
      `SELECT symbol, timestamp, close
         FROM market_data
         WHERE interval = 'weekly'
           AND substr(timestamp, 1, 10) >= ?
           AND substr(timestamp, 1, 10) <= ?
         ORDER BY timestamp ASC`,
    )
    .all(windowStart, windowEnd) as Array<{
    symbol: string;
    timestamp: string;
    close: number;
  }>;
}

function countActiveWatchlist(): number {
  const db = getDatabase();
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM watchlist WHERE active = 1`)
    .get() as { n: number };
  return row.n;
}

// ---------------------------------------------------------------------------
// Trial grid parser (from user-supplied JSON override)
// ---------------------------------------------------------------------------

function parseTrialGridOverride(raw: string): TrialConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `trial_grid: invalid JSON — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`trial_grid: must be a JSON object`);
  }
  const obj = parsed as Record<string, unknown>;
  const ms = obj.windowM;
  const ds = obj.windowD;
  const cs = obj.corrThreshold ?? obj.correlationThreshold;
  const asNumArr = (v: unknown, name: string): number[] => {
    if (!Array.isArray(v) || v.length === 0) {
      throw new Error(
        `trial_grid.${name} must be a non-empty array of numbers`,
      );
    }
    const arr: number[] = [];
    for (const x of v) {
      if (typeof x !== "number" || !Number.isFinite(x)) {
        throw new Error(`trial_grid.${name} has non-numeric entries`);
      }
      arr.push(x);
    }
    return arr;
  };
  const windowMs = asNumArr(ms, "windowM");
  const windowDs = asNumArr(ds, "windowD");
  const corrThresholds = asNumArr(cs, "corrThreshold");
  const out: TrialConfig[] = [];
  for (const m of windowMs)
    for (const d of windowDs)
      for (const c of corrThresholds)
        out.push({ windowM: m, windowD: d, correlationThreshold: c });
  return out;
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function fmt(n: number | null | undefined, digits = 4): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}

function formatRunSummary(params: {
  runId: string;
  windowStart: string;
  windowEnd: string;
  strategy: string;
  walkForward: WalkForwardResult;
  cpcvMean: number;
  cpcvStd: number;
  cpcvAborted: number;
  cpcvTrials: number;
  cpcvFolds: number;
  pbo: number;
  dsrPvalue: number;
  shipBlocked: boolean;
  overrideShip: boolean;
  costBps: number;
  durationMs: number;
}): string {
  const lines: string[] = [];
  lines.push(`backtest_run: run_id=${params.runId}`);
  lines.push(
    `  strategy=${params.strategy}  window=${params.windowStart}..${params.windowEnd}  cost=${params.costBps}bps  duration=${params.durationMs}ms`,
  );
  lines.push(`  walk-forward:`);
  lines.push(
    `    sharpe=${fmt(params.walkForward.sharpe, 4)}  cum_return=${fmt(params.walkForward.cumReturn, 4)}  max_dd=${fmt(params.walkForward.maxDrawdown, 4)}  calmar=${fmt(params.walkForward.calmar, 4)}`,
  );
  lines.push(
    `    win_rate=${fmt(params.walkForward.winRate, 3)}  trades=${params.walkForward.totalTrades}  bars=${params.walkForward.nTestBars}  aborted=${params.walkForward.nAbortedRuns}`,
  );
  lines.push(
    `  cpcv (${params.cpcvTrials} trials × ${params.cpcvFolds} folds):`,
  );
  lines.push(
    `    sharpe_mean=${fmt(params.cpcvMean, 4)}  sharpe_std=${fmt(params.cpcvStd, 4)}  n_aborted=${params.cpcvAborted}`,
  );
  lines.push(`  overfit firewall:`);
  lines.push(
    `    PBO=${fmt(params.pbo, 4)} (threshold 0.50)  DSR_pvalue=${fmt(params.dsrPvalue, 4)} (threshold 0.05)`,
  );
  const shipStatus = params.overrideShip
    ? "OVERRIDE (operator force)"
    : params.shipBlocked
      ? "SHIP_BLOCKED"
      : "ship_ok";
  lines.push(`  ship_gate: ${shipStatus}`);
  if (params.shipBlocked && !params.overrideShip) {
    // Audit W2 round 2: surface degenerate-run reasons explicitly. NaN
    // comparisons return false in `>` tests, so an empty reasons line used to
    // appear when PBO/DSR couldn't be computed (all folds aborted).
    const reasons: string[] = [];
    if (!Number.isFinite(params.pbo)) {
      reasons.push("PBO=NaN (all folds aborted or zero eligible trials)");
    } else if (params.pbo > 0.5) {
      reasons.push(`PBO=${params.pbo.toFixed(2)} > 0.50`);
    }
    if (!Number.isFinite(params.dsrPvalue)) {
      reasons.push("DSR_pvalue=NaN (insufficient trial variance)");
    } else if (params.dsrPvalue > 0.05) {
      reasons.push(`DSR_pvalue=${params.dsrPvalue.toFixed(3)} > 0.05`);
    }
    lines.push(`  → ${reasons.join("; ")}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// backtest_run (WRITE)
// ---------------------------------------------------------------------------

export const backtestRunTool: Tool = {
  name: "backtest_run",
  deferred: true,
  riskTier: "low",
  definition: {
    type: "function",
    function: {
      name: "backtest_run",
      description: `Run the F7.5 Strategy Backtester — walk-forward P&L replay + CPCV (Combinatorial
Purged Cross-Validation) + PBO + Deflated Sharpe, over all weekly bars + signals in mc.db.

USE WHEN:
- Operator asks to validate/backtest the alpha strategy, check for overfitting,
  produce a P&L curve, or gate F8 paper trading
- User says "is the strategy overfit", "backtest this", "compute PBO", "deflated Sharpe",
  "walk-forward", "historial de backtest", "respaldar la estrategia", "sobreajuste"

NOT WHEN:
- User wants per-signal analysis (use alpha_explain instead)
- User just wants the headline numbers of the last run (use backtest_latest — cheaper)

Pipeline (strategy=flam):
  walk-forward (weekly rebalance) → CPCV 24 trials × 15 folds → PBO + DSR → persist.
  Takes ~1-3 seconds. Persists to backtest_runs / backtest_paths / backtest_overfit.

Output: run_id, walk-forward Sharpe/drawdown/Calmar, CPCV aggregate,
PBO + DSR p-value, ship_blocked flag. Ship-gate: PBO > 0.50 OR DSR_pvalue > 0.05.
Operator can override via override_ship: true (logged).`,
      parameters: {
        type: "object",
        properties: {
          strategy: {
            type: "string",
            enum: ["flam", "equal_weight"],
            description:
              "Strategy to backtest. 'flam' is the F7 alpha-combination output (default). 'equal_weight' is a diagnostic baseline reserved for v1.1.",
          },
          start_date: {
            type: "string",
            description:
              "YYYY-MM-DD earliest bar to include. Defaults to earliest available bar.",
          },
          end_date: {
            type: "string",
            description:
              "YYYY-MM-DD latest bar (inclusive). Defaults to today in America/New_York.",
          },
          cost_bps: {
            type: "number",
            description:
              "Round-trip transaction cost in basis points. Default 5 (5 bps = 0.05%).",
          },
          rebalance_bars: {
            type: "number",
            description:
              "Bars between weight refreshes. Default 1 (weekly). Increase to reduce turnover.",
          },
          override_ship: {
            type: "boolean",
            description:
              "Ship the run as approved even if PBO > 0.50 or DSR_pvalue > 0.05. Logged.",
          },
          trial_grid: {
            type: "string",
            description:
              'Optional JSON override of the default 24-config grid. Shape: {"windowM":[52,78,104,156],"windowD":[4,8,12],"corrThreshold":[0.9,0.95]}. Omit for defaults.',
          },
        },
        required: [],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const startedAt = Date.now();

    const strategy =
      (args.strategy as "flam" | "equal_weight" | undefined) ?? "flam";
    if (strategy === "equal_weight") {
      return `backtest_run: strategy='equal_weight' is reserved for v1.1 and not implemented at v1 — use strategy='flam' (default).`;
    }

    const rawStart = args.start_date as string | undefined;
    const rawEnd = args.end_date as string | undefined;
    if (rawStart != null && !DATE_RE.test(rawStart)) {
      return `backtest_run: start_date must be YYYY-MM-DD (got '${rawStart}').`;
    }
    if (rawEnd != null && !DATE_RE.test(rawEnd)) {
      return `backtest_run: end_date must be YYYY-MM-DD (got '${rawEnd}').`;
    }
    const endDate = rawEnd ?? todayInNewYork();

    const costBps =
      typeof args.cost_bps === "number" &&
      args.cost_bps >= 0 &&
      args.cost_bps <= 100
        ? args.cost_bps
        : 5;
    const rebalanceBars =
      typeof args.rebalance_bars === "number" && args.rebalance_bars >= 1
        ? Math.floor(args.rebalance_bars)
        : 1;
    const overrideShip = args.override_ship === true;

    let trialGrid: TrialConfig[];
    if (
      typeof args.trial_grid === "string" &&
      args.trial_grid.trim().length > 0
    ) {
      try {
        trialGrid = parseTrialGridOverride(args.trial_grid);
      } catch (err) {
        return `backtest_run: ${err instanceof Error ? err.message : String(err)}`;
      }
    } else {
      trialGrid = F75_DEFAULT_GRID;
    }

    // Determine window. If start not given, pick earliest bar in DB.
    const db = getDatabase();
    let startDate = rawStart;
    if (!startDate) {
      const row = db
        .prepare(
          `SELECT MIN(substr(timestamp, 1, 10)) AS first_bar FROM market_data WHERE interval = 'weekly'`,
        )
        .get() as { first_bar?: string } | undefined;
      startDate = row?.first_bar;
    }
    if (!startDate) {
      return `backtest_run: no weekly bars found in market_data. Seed data first with market_watchlist_add or scripts/seed-watchlist-weekly.ts.`;
    }

    const bars = loadWeeklyBars(startDate, endDate);
    // Count unique week-level timestamps — measuring HISTORY DEPTH, not total
    // rows. 3 symbols × 10 weeks = 30 rows but only 10 weeks of usable depth.
    const uniqueWeeks = new Set(bars.map((b) => b.timestamp.slice(0, 10))).size;
    if (uniqueWeeks < MIN_BARS_FOR_BACKTEST) {
      return `backtest_run: insufficient bars (found ${uniqueWeeks} distinct weeks, need ≥ ${MIN_BARS_FOR_BACKTEST}). Seed more history first.`;
    }
    const firings = loadFirings(startDate, endDate);
    const watchlistSize = countActiveWatchlist();

    // Walk-forward
    const walkForward = runWalkForward({
      bars,
      firings,
      watchlistSize,
      costBps,
      rebalanceBars,
    });

    // CPCV
    const cpcv = runCpcv({
      bars,
      firings,
      watchlistSize,
      trialGrid,
      costBps,
    });

    // Overfit firewall
    const observedReturns = walkForward.equityCurve.map((p) => p.return);
    const overfit = computeOverfitMetrics(cpcv, {
      observedReturns,
      T: observedReturns.length,
    });

    const pbo = overfit.pbo;
    const dsrPvalue = overfit.dsr.pvalue;
    // NaN → ship-blocked. Degenerate runs (all folds aborted, too few trials
    // to estimate variance) cannot clear the firewall, so the safe default is
    // "blocked" rather than "unknown-passes-through".
    const pboBlocks = !Number.isFinite(pbo) || pbo > 0.5;
    const dsrBlocks = !Number.isFinite(dsrPvalue) || dsrPvalue > 0.05;
    const shipBlocked = pboBlocks || dsrBlocks;

    const runId = randomUUID();
    const runTimestamp = new Date().toISOString();

    const durationMs = Date.now() - startedAt;

    persistBacktestRun({
      runId,
      runTimestamp,
      strategy,
      mode: "returns",
      windowStart: startDate,
      windowEnd: endDate,
      costBps,
      rebalanceBars,
      walkForward,
      cpcv,
      overfit,
      shipBlocked,
      overrideShip,
      regime: null,
      durationMs,
    });

    return formatRunSummary({
      runId,
      windowStart: startDate,
      windowEnd: endDate,
      strategy,
      walkForward,
      cpcvMean: cpcv.aggregateSharpeMean,
      cpcvStd: cpcv.aggregateSharpeStd,
      cpcvAborted: cpcv.nAborted,
      cpcvTrials: cpcv.nTrialsTotal,
      cpcvFolds: cpcv.nFoldsPerTrial,
      pbo,
      dsrPvalue,
      shipBlocked,
      overrideShip,
      costBps,
      durationMs,
    });
  },
};

// ---------------------------------------------------------------------------
// backtest_latest (READ)
// ---------------------------------------------------------------------------

export const backtestLatestTool: Tool = {
  name: "backtest_latest",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "backtest_latest",
      description: `Return the most-recent backtest run's headline metrics — walk-forward
Sharpe/drawdown/Calmar, CPCV aggregate, PBO, DSR p-value, ship_blocked flag.

USE WHEN:
- Operator asks "is the strategy ready", "last backtest", "should we go live"
- F8 paper-trading decision wants the latest gate status

NOT WHEN:
- User wants a fresh run (use backtest_run)
- User wants per-trial/fold breakdown (use backtest_explain)

Reads backtest_runs + backtest_overfit. No side effects. < 1ms typical.`,
      parameters: {
        type: "object",
        properties: {
          strategy: {
            type: "string",
            enum: ["flam", "equal_weight"],
            description:
              "Filter to a specific strategy. Omit to get latest run of any strategy.",
          },
        },
        required: [],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const strategy = args.strategy as string | undefined;
    const result = readLatestBacktest(strategy);
    if (!result) {
      return `backtest_latest: no runs found${strategy ? ` for strategy='${strategy}'` : ""}.`;
    }
    const r = result.run;
    const o = result.overfit;
    const lines: string[] = [];
    lines.push(`backtest_latest: run_id=${r.run_id}`);
    lines.push(
      `  strategy=${r.strategy}  timestamp=${r.run_timestamp}  window=${r.window_start}..${r.window_end}`,
    );
    lines.push(
      `  walk-forward: sharpe=${fmt(r.wf_sharpe)}  cum_return=${fmt(r.wf_cum_return)}  max_dd=${fmt(r.wf_max_drawdown)}  calmar=${fmt(r.wf_calmar)}  win_rate=${fmt(r.wf_win_rate, 3)}`,
    );
    lines.push(
      `  cpcv: mean_sharpe=${fmt(r.cpcv_sharpe_mean)}  std=${fmt(r.cpcv_sharpe_std)}  n_trials=${r.cpcv_n_trials}  n_folds=${r.cpcv_n_folds}  aborted=${r.cpcv_n_aborted}`,
    );
    lines.push(
      `  overfit: PBO=${fmt(r.pbo)}  DSR_pvalue=${fmt(r.dsr_pvalue)}  DSR_ratio=${fmt(r.dsr_ratio)}`,
    );
    if (o) {
      lines.push(
        `  dsr_detail: observed_sharpe=${fmt(o.dsr_observed_sharpe)}  expected_null=${fmt(o.dsr_expected_null)}  skew=${fmt(o.dsr_skewness)}  kurt=${fmt(o.dsr_kurtosis)}`,
      );
    }
    const shipStatus =
      r.override_ship === 1
        ? "OVERRIDE"
        : r.ship_blocked === 1
          ? "SHIP_BLOCKED"
          : "ship_ok";
    lines.push(`  ship_gate: ${shipStatus}`);
    return lines.join("\n");
  },
};

// ---------------------------------------------------------------------------
// backtest_explain (READ)
// ---------------------------------------------------------------------------

export const backtestExplainTool: Tool = {
  name: "backtest_explain",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "backtest_explain",
      description: `Return a per-trial/per-fold breakdown of a backtest run — which trials won
in-sample, their OOS ranks, aborted-fold reasons, and skew/kurtosis contributions to DSR.

USE WHEN:
- Operator asks "why is PBO high", "which trial won", "what failed in the backtest"
- You need to investigate a specific run_id returned by backtest_run or backtest_latest

NOT WHEN:
- User just wants headline metrics (use backtest_latest)
- User wants to re-run the backtest (use backtest_run)

Params:
  run_id: UUID of a specific run. Omit to use the latest.

Reads backtest_runs + backtest_paths + backtest_overfit. No side effects.`,
      parameters: {
        type: "object",
        properties: {
          run_id: {
            type: "string",
            description:
              "UUID of a specific backtest run. Omit to fetch the latest.",
          },
        },
        required: [],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const rawRunId = args.run_id as string | undefined;
    let result;
    if (rawRunId) {
      if (!UUID_RE.test(rawRunId)) {
        return `backtest_explain: run_id must be a UUID (got '${rawRunId}').`;
      }
      result = readBacktestRun(rawRunId);
    } else {
      result = readLatestBacktest();
    }
    if (!result) {
      return `backtest_explain: run not found${rawRunId ? ` for run_id=${rawRunId}` : " (no runs exist yet)"}.`;
    }

    const r = result.run;
    const paths = result.paths;

    // Per-trial aggregate
    const byTrial = new Map<number, typeof paths>();
    for (const p of paths) {
      const arr = byTrial.get(p.trial_index);
      if (arr) arr.push(p);
      else byTrial.set(p.trial_index, [p]);
    }
    const trialSummaries = Array.from(byTrial.entries()).map(([idx, rows]) => {
      // Filter IS and OOS symmetrically: aborted→skip, null→skip. Audit W1:
      // previously `is_sharpe ?? 0` diluted IS mean toward zero on aborts,
      // misrepresenting in-sample performance.
      const goodOos = rows.filter(
        (x) => x.aborted === 0 && x.oos_sharpe !== null,
      );
      const goodIs = rows.filter(
        (x) => x.aborted === 0 && x.is_sharpe !== null,
      );
      const oos = goodOos.map((x) => x.oos_sharpe as number);
      const is = goodIs.map((x) => x.is_sharpe as number);
      const mean =
        oos.length > 0 ? oos.reduce((a, b) => a + b, 0) / oos.length : null;
      const isMean =
        is.length > 0 ? is.reduce((a, b) => a + b, 0) / is.length : null;
      const cfg = rows[0]!;
      return {
        trialIndex: idx,
        windowM: cfg.window_m,
        windowD: cfg.window_d,
        corrThreshold: cfg.corr_threshold,
        oosMean: mean,
        isMean,
        aborted: rows.filter((x) => x.aborted === 1).length,
      };
    });
    // Sort by OOS mean descending. Null → -Infinity so null-only trials sink
    // to the bottom. Audit I3: explicit ternary avoids NaN (∞−∞) if both null.
    trialSummaries.sort((a, b) => {
      const av = a.oosMean ?? -Infinity;
      const bv = b.oosMean ?? -Infinity;
      if (av === bv) return 0;
      return bv > av ? 1 : -1;
    });

    const lines: string[] = [];
    lines.push(`backtest_explain: run_id=${r.run_id}  strategy=${r.strategy}`);
    lines.push(
      `  window=${r.window_start}..${r.window_end}  PBO=${fmt(r.pbo)}  DSR_pvalue=${fmt(r.dsr_pvalue)}  ship_blocked=${r.ship_blocked === 1 ? "yes" : "no"}`,
    );
    lines.push(`  trials (top 5 by OOS mean Sharpe):`);
    const topN = trialSummaries.slice(0, 5);
    for (const t of topN) {
      lines.push(
        `    trial ${String(t.trialIndex).padEnd(2)}  windowM=${t.windowM}  windowD=${t.windowD}  corr=${t.corrThreshold.toFixed(2)}  IS_mean=${fmt(t.isMean)}  OOS_mean=${fmt(t.oosMean)}  aborted=${t.aborted}`,
      );
    }
    const rest = trialSummaries.length - topN.length;
    if (rest > 0)
      lines.push(
        `  (+ ${rest} more trials; bottom trial OOS_mean=${fmt(trialSummaries[trialSummaries.length - 1]?.oosMean ?? null)})`,
      );

    // Aborted breakdown
    const aborted = paths.filter((p) => p.aborted === 1);
    if (aborted.length > 0) {
      const byReason = new Map<string, number>();
      for (const a of aborted) {
        const k = a.abort_reason ?? "unknown";
        byReason.set(k, (byReason.get(k) ?? 0) + 1);
      }
      lines.push(
        `  aborted folds: ${Array.from(byReason.entries())
          .map(([k, v]) => `${k}=${v}`)
          .join(", ")}`,
      );
    }

    // DSR decomposition
    const o = result.overfit;
    if (o) {
      lines.push(
        `  dsr: observed_sr=${fmt(o.dsr_observed_sharpe)}  expected_null_sr=${fmt(o.dsr_expected_null)}  trial_variance=${fmt(o.dsr_sharpe_variance)}  skew=${fmt(o.dsr_skewness)}  kurt=${fmt(o.dsr_kurtosis)}`,
      );
    }

    return lines.join("\n");
  },
};

export const backtestTools: Tool[] = [
  backtestRunTool,
  backtestLatestTool,
  backtestExplainTool,
];
