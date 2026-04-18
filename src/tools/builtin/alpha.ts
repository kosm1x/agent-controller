/**
 * F7 Alpha Combination tools — `alpha_run`, `alpha_latest`, `alpha_explain`.
 *
 * All deferred: true. Loaded when `alpha` scope activates. Output is
 * pre-formatted text per feedback_preformat_over_prompt.
 *
 * alpha_run       (write) — executes 11-step FLAM pipeline, persists to
 *                           signal_weights + signal_isq, returns summary
 * alpha_latest    (read)  — last completed run's weights + N_effective
 * alpha_explain   (read)  — per-signal breakdown (weight, ε, σ, ISQ) by run_id
 *
 * Inputs for alpha_run come from existing F1/F3/F6.5 persisted tables:
 *   market_data           — close prices (F1)
 *   market_signals        — F3 firings
 *   sentiment_readings    — F6.5 derived firings (optional)
 *   watchlist             — denominator for ISQ coverage
 *
 * See `docs/planning/phase-beta/19-f7-impl-plan.md` for design decisions.
 */

import type { Tool } from "../types.js";
import { getDatabase } from "../../db/index.js";
import {
  runAlphaCombination,
  type AlphaRunResult,
  type AlphaRunSignalResult,
  F7CorrelatedSignalsError,
  F7ConfigError,
} from "../../finance/alpha-combination.js";
import type { BarRow, FiringRow } from "../../finance/alpha-matrix.js";
import {
  persistAlphaRun,
  readAlphaRunByRunId,
  readLatestAlphaRun,
} from "../../finance/alpha-persist.js";
import { todayInNewYork } from "../../finance/alpha-isq.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Helpers — read DB inputs for alpha_run
// ---------------------------------------------------------------------------

function loadFiringsInWindow(windowStart: string): FiringRow[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      `SELECT symbol, signal_type, direction, strength, triggered_at
         FROM market_signals
         WHERE substr(triggered_at, 1, 10) >= ?
         ORDER BY triggered_at ASC`,
    )
    .all(windowStart) as Array<{
    symbol: string;
    signal_type: string;
    direction: "long" | "short" | "neutral";
    strength: number;
    triggered_at: string;
  }>;
  return rows;
}

function loadBarsInWindow(windowStart: string): BarRow[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      `SELECT symbol, timestamp, close
         FROM market_data
         WHERE interval = 'daily'
           AND substr(timestamp, 1, 10) >= ?
         ORDER BY timestamp ASC`,
    )
    .all(windowStart) as Array<{
    symbol: string;
    timestamp: string;
    close: number;
  }>;
  return rows;
}

function countWatchlist(): number {
  const db = getDatabase();
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM watchlist WHERE active = 1`)
    .get() as { n: number };
  return row.n;
}

function formatSignalRow(s: AlphaRunSignalResult): string {
  if (s.excluded) {
    return `  [exc] ${s.signalKey.padEnd(28)} reason=${s.excludeReason ?? "?"}`;
  }
  const w = s.weight.toFixed(4);
  const eps = s.epsilon != null ? s.epsilon.toFixed(4) : "—";
  const sig = s.sigma != null ? s.sigma.toExponential(3) : "—";
  const ic = s.ic30d != null ? s.ic30d.toFixed(4) : "null";
  return `  ${s.signalKey.padEnd(28)} w=${w}  ε=${eps}  σ=${sig}  IC=${ic}`;
}

function formatRunSummary(r: AlphaRunResult, withTopN = 3): string {
  const lines: string[] = [];
  lines.push(`alpha_run: run_id=${r.runId}`);
  lines.push(`  timestamp: ${r.runTimestamp}`);
  lines.push(`  mode: ${r.mode}  regime: ${r.regime ?? "null"}`);
  lines.push(
    `  N=${r.N}  excluded=${r.NExcluded}  N_effective=${r.NEffective.toFixed(3)}  duration=${r.durationMs}ms`,
  );
  const active = r.signals
    .filter((s) => !s.excluded)
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
  if (active.length > 0) {
    const top = active.slice(0, withTopN);
    lines.push(`  top ${top.length} by |weight|:`);
    for (const s of top) lines.push(formatSignalRow(s));
    const rest = active.length - top.length;
    if (rest > 0)
      lines.push(`  (+ ${rest} other active signal${rest === 1 ? "" : "s"})`);
  }
  const excluded = r.signals.filter((s) => s.excluded);
  if (excluded.length > 0) {
    const byReason = new Map<string, number>();
    for (const s of excluded) {
      const k = s.excludeReason ?? "unknown";
      byReason.set(k, (byReason.get(k) ?? 0) + 1);
    }
    const parts = Array.from(byReason.entries()).map(([k, v]) => `${k}=${v}`);
    lines.push(`  exclusions: ${parts.join(", ")}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// alpha_run
// ---------------------------------------------------------------------------

export const alphaRunTool: Tool = {
  name: "alpha_run",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "alpha_run",
      description: `Run the F7 alpha combination engine — 11-step FLAM pipeline over
the last 250 trading days of market_signals + market_data, producing
weighted signal combination with per-signal ISQ dimensions.

USE WHEN:
- User asks for combined signal / megaalpha / alpha weights for today
- F8 paper-trade loop needs fresh weights before sizing
- F9 scan ritual invokes this nightly

NOT WHEN:
- User just wants to see last run's weights (use alpha_latest — cheaper)
- User wants per-signal diagnostic for an existing run (use alpha_explain)

Pipeline:
  IC filter → build return matrix → Steps 1-11 FLAM → ISQ → persist.

Returns run summary: run_id, N, N_effective, regime, top 3 signals by
|weight|, exclusion breakdown. Persists to signal_weights + signal_isq
(append-only, one row per signal per run).

Typical latency: 50-500ms. Safe to retry (new run_id each time).
Probability mode is reserved for F6.5.x; returns mode is the only v1 path.`,
      parameters: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            enum: ["returns", "probability"],
            description:
              "Pipeline mode. 'returns' (default) runs on equity-return signals. 'probability' is reserved for v1.1 (prediction-markets) and currently throws.",
          },
          as_of: {
            type: "string",
            description:
              "YYYY-MM-DD end of window. Defaults to today in America/New_York.",
          },
          window_m: {
            type: "number",
            description:
              "Historical window size in trading days. Default 250 (1 year).",
          },
          window_d: {
            type: "number",
            description:
              "Forward-expected-return lookback. Default 20 (1 month).",
          },
          horizon: {
            type: "number",
            description:
              "Forward-return bars per firing. Default 1 (next-day).",
          },
        },
        required: [],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const mode = (args.mode as "returns" | "probability") ?? "returns";
    // Audit W2 round 3: validate as_of at the tool boundary. An invalid string
    // would otherwise flow into resolveTradingPeriods and silently accept all
    // bars (lexicographic compare), or throw a generic RangeError.
    const rawAsOf = args.as_of as string | undefined;
    if (rawAsOf != null && !/^\d{4}-\d{2}-\d{2}$/.test(rawAsOf)) {
      return `alpha_run: as_of must be YYYY-MM-DD (got '${rawAsOf}'). Omit to default to today in America/New_York.`;
    }
    const asOf = rawAsOf ?? todayInNewYork();
    const windowM =
      typeof args.window_m === "number" ? Math.floor(args.window_m) : 250;
    const windowD =
      typeof args.window_d === "number" ? Math.floor(args.window_d) : 20;
    const horizon =
      typeof args.horizon === "number" ? Math.floor(args.horizon) : 1;

    // Compute window-start date. 250 trading days ≈ 354 calendar days (~72
    // weekends + ~10 holidays), so a naive `windowM + 14` pad shortchanges
    // the SQL substr filter. Use 1.5× ratio + horizon buffer (audit R3).
    const padDays = Math.ceil(windowM * 1.5) + horizon + 14;
    const start = new Date(asOf + "T12:00:00Z");
    start.setUTCDate(start.getUTCDate() - padDays);
    const windowStart = start.toISOString().slice(0, 10);

    const firings = loadFiringsInWindow(windowStart);
    const bars = loadBarsInWindow(windowStart);
    const watchlistSize = countWatchlist();

    // Regime derivation is deferred to F9 rituals (which load the full
    // MacroSeriesBundle from F5 helpers). F7 v1 just records `null` so the
    // column is forward-compatible; downstream readers can join against the
    // F5 macro tables by timestamp if needed.
    const regime: string | null = null;

    let result: AlphaRunResult;
    try {
      result = runAlphaCombination({
        mode,
        firings,
        bars,
        watchlistSize,
        regime,
        asOf,
        windowM,
        windowD,
        horizon,
      });
    } catch (err) {
      // Audit W1 round 3: emit structured context on failure so the DB isn't
      // the only forensic surface. console.warn pipes through pino/journald.
      if (err instanceof F7ConfigError) {
        console.warn(
          `[alpha_run] config error: ${err.message}`,
          JSON.stringify({ mode, asOf, windowM, windowD, horizon }),
        );
        return `alpha_run: config error — ${err.message}`;
      }
      if (err instanceof F7CorrelatedSignalsError) {
        console.warn(
          `[alpha_run] correlation guard exhausted`,
          JSON.stringify({
            mode,
            asOf,
            windowM,
            excludedCount: err.excluded.length,
            excluded: err.excluded,
          }),
        );
        return `alpha_run: correlation guard exhausted after 3 exclusions. Excluded signals: ${err.excluded.join(", ") || "(none)"}. No weights persisted.`;
      }
      console.warn(
        `[alpha_run] unexpected error: ${err instanceof Error ? err.message : String(err)}`,
        JSON.stringify({ mode, asOf, windowM, windowD, horizon }),
      );
      return `alpha_run: ${err instanceof Error ? err.message : String(err)}`;
    }

    if (result.N === 0) {
      return `alpha_run: no signals available in the window (${windowStart} .. ${asOf}). Nothing to persist. Check market_signals population.`;
    }

    const stats = persistAlphaRun(result);
    // Audit W1 round 3: log success with structured metrics for forensic
    // traceability. F8 paper-trading will rely on this signal trail if a
    // downstream decision turns out to be based on a stale/bad weight.
    console.log(
      `[alpha_run] ok run_id=${result.runId}`,
      JSON.stringify({
        mode: result.mode,
        N: result.N,
        excluded: result.NExcluded,
        n_effective: Number(result.NEffective.toFixed(3)),
        regime: result.regime,
        durationMs: result.durationMs,
        persisted: stats.weightsInserted,
      }),
    );
    const summary = formatRunSummary(result);
    return `${summary}\n  persisted: ${stats.weightsInserted} weight rows, ${stats.isqInserted} isq rows`;
  },
};

// ---------------------------------------------------------------------------
// alpha_latest
// ---------------------------------------------------------------------------

export const alphaLatestTool: Tool = {
  name: "alpha_latest",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "alpha_latest",
      description: `Return the most recent completed alpha run's weights — read-only, no
side effects. Use this for F8 / F9 / user queries asking "what does the
system think right now."

NOT WHEN:
- You want to force a fresh run (use alpha_run)
- You want per-signal ISQ diagnostic (use alpha_explain with run_id)

Returns a pre-formatted summary with run_id, timestamp, regime,
N / N_excluded / N_effective, ranked active weights. Latency <50ms.`,
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },

  async execute(_args: Record<string, unknown>): Promise<string> {
    const run = readLatestAlphaRun();
    if (!run) {
      return "alpha_latest: no completed runs found. Invoke alpha_run to produce one.";
    }
    const active = run.signals.filter((s) => !s.excluded);
    const sorted = active.sort(
      (a, b) => Math.abs(b.weight) - Math.abs(a.weight),
    );
    const lines: string[] = [];
    lines.push(`alpha_latest: run_id=${run.runId}`);
    lines.push(`  timestamp: ${run.runTimestamp}`);
    lines.push(
      `  mode: ${run.mode}  regime: ${run.regime ?? "null"}  N=${run.N}  excluded=${run.NExcluded}  N_effective=${run.NEffective.toFixed(3)}`,
    );
    if (sorted.length === 0) {
      lines.push("  (no active signals — all excluded)");
    } else {
      lines.push("  active weights (|w| desc):");
      for (const s of sorted) lines.push(formatSignalRow(s));
    }
    return lines.join("\n");
  },
};

// ---------------------------------------------------------------------------
// alpha_explain
// ---------------------------------------------------------------------------

export const alphaExplainTool: Tool = {
  name: "alpha_explain",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "alpha_explain",
      description: `Given a run_id (or default: latest), return the full per-signal
breakdown: weight, ε (residual), σ (volatility), E_norm (forward return
normalized), IC, and ISQ dimensions (efficiency/timeliness/coverage/
stability/forward_ic). Excluded signals include the exclude_reason.

USE WHEN:
- "Why is signal X weighted at 0?"
- Audit a specific past run
- Debugging unexpected weight distribution

Latency <50ms.`,
      parameters: {
        type: "object",
        properties: {
          run_id: {
            type: "string",
            description:
              "UUID of the run to explain. If omitted, uses the latest completed run.",
          },
        },
        required: [],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const runIdArg = args.run_id as string | undefined;
    if (runIdArg != null && !UUID_RE.test(runIdArg)) {
      return `alpha_explain: run_id must be a UUID (got '${runIdArg}'). Omit to use latest.`;
    }

    const run = runIdArg ? readAlphaRunByRunId(runIdArg) : readLatestAlphaRun();
    if (!run) {
      return runIdArg
        ? `alpha_explain: no run with id '${runIdArg}' found.`
        : "alpha_explain: no completed runs found. Invoke alpha_run first.";
    }

    const lines: string[] = [];
    lines.push(`alpha_explain: run_id=${run.runId}`);
    lines.push(
      `  ${run.runTimestamp}  mode=${run.mode}  regime=${run.regime ?? "null"}  N=${run.N}  excluded=${run.NExcluded}  N_eff=${run.NEffective.toFixed(3)}`,
    );
    lines.push("");
    lines.push(
      "  signal_key                     status     weight   epsilon   sigma     IC       efficiency tlns cov  stab fwd_ic",
    );
    lines.push("  " + "-".repeat(110));
    const sorted = run.signals.slice().sort((a, b) => {
      if (a.excluded !== b.excluded) return a.excluded ? 1 : -1;
      return Math.abs(b.weight) - Math.abs(a.weight);
    });
    for (const s of sorted) {
      const status = s.excluded ? `exc(${s.excludeReason ?? "?"})` : "active";
      const w = s.weight.toFixed(4);
      const eps = s.epsilon != null ? s.epsilon.toFixed(4) : "—";
      const sig = s.sigma != null ? s.sigma.toExponential(3) : "—";
      const ic = s.ic30d != null ? s.ic30d.toFixed(4) : "null";
      const isq = s.isq;
      const isqStr = isq
        ? `  ${isq.efficiency.toFixed(3)}    ${isq.timeliness.toFixed(2)} ${isq.coverage.toFixed(2)} ${isq.stability.toFixed(2)} ${isq.forward_ic.toFixed(3)}`
        : "  (no isq — excluded)";
      lines.push(
        `  ${s.signalKey.padEnd(30)} ${status.padEnd(10)} ${w.padStart(7)}  ${eps.padStart(7)}  ${sig.padEnd(9)} ${ic.padStart(7)}${isqStr}`,
      );
    }
    return lines.join("\n");
  },
};
