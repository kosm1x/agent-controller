/**
 * V8 substrate S2 — self-audit before reporting.
 *
 * Codifies the "Audited?" reflex: stratify aggregate metrics, surface
 * warnings (small-n, single-bucket dominance, baseline divergence) BEFORE
 * the headline number is reported.
 *
 * Born from the 2026-05-03 trilogy validation incident: aggregate "22.2%
 * utility delivered" headline averaged 88% on mc-operational (n=69) with 7%
 * on mc-jarvis (n=1637, collapsed). Aggregate read green; the operator's
 * primary bank was in complete collapse. See
 * feedback_recall_aggregate_hides_bank_collapse.md.
 *
 * Architecture: pure analytic core (`auditAggregate`) operates on
 * Sample[] so tests can use synthetic data. Metric-specific runners
 * (`auditUtility`, `auditCacheHit`, ...) fetch from the live DB and feed
 * the core. mc-ctl exposes the runners; the LLM invokes via shell_exec.
 *
 * Freeze-aligned: no new builtin tool surface, no new scope-regex, no
 * new runner. Reliability infrastructure for existing reports.
 */

import { getDatabase } from "../db/index.js";

// ---------------------------------------------------------------------------
// Pure analytic core
// ---------------------------------------------------------------------------

export type AuditWarning =
  | "small-n"
  | "single-bucket-dominance"
  | "stratification-divergence"
  | "baseline-divergence";

export interface Sample {
  /** Stratification dimension, e.g., bank, source, agent_type. Optional. */
  bucket?: string;
  /** Numeric value: 0/1 for boolean rates, raw number for continuous. */
  value: number;
}

export interface StratificationBucket {
  bucket: string;
  n: number;
  sum: number;
  mean: number;
}

export interface AuditOptions {
  /** Human-readable claim being audited. Echoed in output. */
  claim: string;
  /**
   * Minimum sample size to consider verified. Default 30 — keeps a ±9pp
   * 95% confidence window narrow enough for ratio metrics.
   */
  minN?: number;
  /**
   * Optional baseline for divergence check. Same units as Sample.value
   * (e.g., 0.222 for 22.2% if values are 0/1, or 22.2 if values are
   * pre-multiplied — caller's choice, just be consistent).
   */
  baseline?: number;
  /**
   * Per-bucket minimum n. Default 10. Buckets below this are tagged
   * "(insufficient)" in stratification but never trigger
   * stratification-divergence (single-row noise).
   */
  minBucketN?: number;
  /**
   * Single-bucket-dominance threshold. If one bucket holds ≥ this share
   * of n AND its mean differs from aggregate by ≥ minDivergencePct,
   * raise single-bucket-dominance. Default 0.7.
   */
  dominanceShare?: number;
  /**
   * Minimum mean delta (absolute) between any qualifying bucket and the
   * aggregate to trigger stratification-divergence. Default 0.15 — for
   * 0/1 values this is 15 percentage points.
   */
  minDivergencePct?: number;
  /**
   * Minimum relative delta from baseline (as fraction, e.g., 0.5 = 50%)
   * to trigger baseline-divergence. Default 0.5.
   */
  baselineDivergenceRel?: number;
}

export interface AuditResult {
  claim: string;
  n: number;
  mean: number;
  sum: number;
  /** No warnings AND n >= minN. */
  verified: boolean;
  warnings: AuditWarning[];
  /** Empty when caller's samples carry no `bucket`. */
  stratification: StratificationBucket[];
  /** Plain-English diagnostic notes; rendered as bullets in the CLI. */
  notes: string[];
  /** Present when opts.baseline was set. Absolute mean - baseline. */
  baselineDelta?: number;
}

// Defaults are applied via destructuring with `=` rather than object spread
// so that callers passing `{minN: undefined}` still get the default. Spread
// would clobber the default with the explicit undefined.
const DEFAULT_MIN_N = 30;
const DEFAULT_MIN_BUCKET_N = 10;
const DEFAULT_DOMINANCE_SHARE = 0.7;
// Tightened from 0.15 to 0.10 on 2026-05-03 — the 24h post-tune sample showed
// mc-jarvis (30.3%) and mc-operational (8.3%) diverging 22pp from each other
// while each sat 11pp from the aggregate. 0.15 missed it; 0.10 catches it
// without firing on 5pp noise.
const DEFAULT_MIN_DIVERGENCE_PCT = 0.1;
const DEFAULT_BASELINE_DIVERGENCE_REL = 0.5;

export function auditAggregate(
  samples: readonly Sample[],
  opts: AuditOptions,
): AuditResult {
  const {
    minN = DEFAULT_MIN_N,
    minBucketN = DEFAULT_MIN_BUCKET_N,
    dominanceShare = DEFAULT_DOMINANCE_SHARE,
    minDivergencePct = DEFAULT_MIN_DIVERGENCE_PCT,
    baselineDivergenceRel = DEFAULT_BASELINE_DIVERGENCE_REL,
  } = opts;
  const cfg = {
    minN: minN ?? DEFAULT_MIN_N,
    minBucketN: minBucketN ?? DEFAULT_MIN_BUCKET_N,
    dominanceShare: dominanceShare ?? DEFAULT_DOMINANCE_SHARE,
    minDivergencePct: minDivergencePct ?? DEFAULT_MIN_DIVERGENCE_PCT,
    baselineDivergenceRel:
      baselineDivergenceRel ?? DEFAULT_BASELINE_DIVERGENCE_REL,
  };
  const n = samples.length;
  const sum = samples.reduce((acc, s) => acc + s.value, 0);
  const mean = n > 0 ? sum / n : 0;

  const warnings: AuditWarning[] = [];
  const notes: string[] = [];

  // Stratify if any sample carries a bucket
  const buckets = new Map<string, { sum: number; n: number }>();
  for (const s of samples) {
    if (s.bucket === undefined) continue;
    const cur = buckets.get(s.bucket) ?? { sum: 0, n: 0 };
    cur.sum += s.value;
    cur.n += 1;
    buckets.set(s.bucket, cur);
  }
  const stratification: StratificationBucket[] = [...buckets.entries()]
    .map(([bucket, agg]) => ({
      bucket,
      n: agg.n,
      sum: agg.sum,
      mean: agg.n > 0 ? agg.sum / agg.n : 0,
    }))
    .sort((a, b) => b.n - a.n);

  // --- Warning: small-n ---
  if (n < cfg.minN) {
    warnings.push("small-n");
    notes.push(
      `Sample size n=${n} is below minN=${cfg.minN}. Headline ${formatRate(mean)} is statistically thin — re-query with a wider window before acting.`,
    );
  }

  // --- Warning: single-bucket-dominance ---
  // One bucket holds ≥ dominanceShare of n AND its mean diverges ≥
  // minDivergencePct from the aggregate. The 2026-05-03 trilogy headline
  // (88% mc-operational on 69 rows hiding 7% mc-jarvis on n=??) is the
  // canonical case this catches when the operator quotes the aggregate.
  if (stratification.length >= 2 && n > 0) {
    const top = stratification[0];
    const share = top.n / n;
    const meanDelta = Math.abs(top.mean - mean);
    if (share >= cfg.dominanceShare && meanDelta >= cfg.minDivergencePct) {
      warnings.push("single-bucket-dominance");
      notes.push(
        `Bucket '${top.bucket}' holds ${formatPct(share)} of n=${n} with mean ${formatRate(top.mean)} vs aggregate ${formatRate(mean)} (delta ${formatRate(meanDelta)}). Headline is being shaped by one bucket.`,
      );
    }
  }

  // --- Warning: stratification-divergence ---
  // Any qualifying bucket (n >= minBucketN) diverges ≥ minDivergencePct
  // from the aggregate. Catches the inverse pattern of dominance: a
  // small-but-real bucket (e.g., mc-jarvis at 7%) hidden under a large
  // healthy bucket (e.g., mc-operational at 88%) that doesn't dominate.
  if (stratification.length >= 2 && n > 0) {
    for (const b of stratification) {
      if (b.n < cfg.minBucketN) continue;
      const delta = Math.abs(b.mean - mean);
      if (delta >= cfg.minDivergencePct) {
        if (!warnings.includes("stratification-divergence")) {
          warnings.push("stratification-divergence");
        }
        notes.push(
          `Bucket '${b.bucket}' (n=${b.n}) diverges ${formatRate(delta)} from aggregate (${formatRate(b.mean)} vs ${formatRate(mean)}). Bank-stratified verdict differs from headline.`,
        );
      }
    }
  }

  // --- Warning: baseline-divergence ---
  let baselineDelta: number | undefined;
  if (opts.baseline !== undefined && n > 0) {
    baselineDelta = mean - opts.baseline;
    const denom = Math.abs(opts.baseline);
    const rel = denom > 0 ? Math.abs(baselineDelta) / denom : Infinity;
    if (rel >= cfg.baselineDivergenceRel) {
      warnings.push("baseline-divergence");
      const dir = baselineDelta > 0 ? "above" : "below";
      notes.push(
        `Headline ${formatRate(mean)} is ${formatRate(Math.abs(baselineDelta))} ${dir} baseline ${formatRate(opts.baseline)} (relative ${formatPct(rel)}). Investigate cause before reporting movement as a trend.`,
      );
    }
  }

  // Insufficient-bucket annotation (informational note, not a warning)
  for (const b of stratification) {
    if (b.n < cfg.minBucketN) {
      notes.push(
        `Bucket '${b.bucket}' has n=${b.n}, below per-bucket minN=${cfg.minBucketN}. Treat its rate ${formatRate(b.mean)} as noise.`,
      );
    }
  }

  return {
    claim: opts.claim,
    n,
    mean,
    sum,
    verified: warnings.length === 0 && n >= cfg.minN,
    warnings,
    stratification,
    notes,
    baselineDelta,
  };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatRate(x: number): string {
  // Heuristic: if value is in [0, 1], assume rate and show as %.
  // Otherwise show raw number with 2 decimals.
  if (Math.abs(x) <= 1) return `${(x * 100).toFixed(1)}%`;
  return x.toFixed(2);
}

function formatPct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}

// ---------------------------------------------------------------------------
// Window parsing — shared with mc-ctl semantics
// ---------------------------------------------------------------------------

export interface WindowSpec {
  /** SQLite datetime() modifier, e.g., "-24 hours". */
  modifier: string;
  /** Echo string for output, e.g., "24h". */
  label: string;
}

/** Parse a window string like "24h", "7d", "120m" into a SQLite-safe spec. */
export function parseWindow(input: string): WindowSpec {
  const m = input.match(/^(\d+)([hdm])$/);
  if (!m) throw new Error(`Invalid window '${input}'. Use Nh|Nd|Nm.`);
  const n = m[1];
  const unit = m[2];
  const unitName = unit === "h" ? "hours" : unit === "d" ? "days" : "minutes";
  return { modifier: `-${n} ${unitName}`, label: `${n}${unit}` };
}

// ---------------------------------------------------------------------------
// Metric runners — DB → Sample[] → auditAggregate
// ---------------------------------------------------------------------------
//
// SECURITY: stratifyBy is interpolated into SQL (not bindable as a column
// reference), so each runner validates against a hardcoded allowlist before
// composing the query. TS unions don't enforce at runtime — JSON.parse can
// deliver any string. Reject unknown columns explicitly.

function assertAllowedColumn(
  col: string | undefined,
  allowed: readonly string[],
  metric: string,
): void {
  if (col === undefined) return;
  if (!allowed.includes(col)) {
    throw new Error(
      `Invalid stratifyBy '${col}' for metric '${metric}'. Allowed: ${allowed.join(", ")}`,
    );
  }
}

export type UtilityStratifyBy = "bank" | "source" | "match_type";
const UTILITY_COLS: readonly UtilityStratifyBy[] = [
  "bank",
  "source",
  "match_type",
];

export function fetchUtilitySamples(
  window: WindowSpec,
  stratifyBy?: UtilityStratifyBy,
): Sample[] {
  assertAllowedColumn(stratifyBy, UTILITY_COLS, "utility");
  const db = getDatabase();
  const col = stratifyBy ? `, COALESCE(${stratifyBy}, '(null)') AS bucket` : "";
  const rows = db
    .prepare(
      `SELECT was_used AS value${col}
       FROM recall_audit
       WHERE created_at >= datetime('now', ?) AND was_used IS NOT NULL`,
    )
    .all(window.modifier) as Array<{ value: number; bucket?: string }>;
  return rows.map((r) => ({
    bucket: r.bucket,
    value: r.value === 1 ? 1 : 0,
  }));
}

export type CacheHitStratifyBy = "agent_type" | "model";
const CACHE_HIT_COLS: readonly CacheHitStratifyBy[] = ["agent_type", "model"];

export function fetchCacheHitSamples(
  window: WindowSpec,
  stratifyBy?: CacheHitStratifyBy,
): Sample[] {
  assertAllowedColumn(stratifyBy, CACHE_HIT_COLS, "cache-hit");
  const db = getDatabase();
  const col = stratifyBy ? `, ${stratifyBy} AS bucket` : "";
  const rows = db
    .prepare(
      `SELECT prompt_tokens, cache_read_tokens${col}
       FROM cost_ledger
       WHERE created_at >= datetime('now', ?) AND prompt_tokens > 0`,
    )
    .all(window.modifier) as Array<{
    prompt_tokens: number;
    cache_read_tokens: number;
    bucket?: string;
  }>;
  return rows.map((r) => ({
    bucket: r.bucket,
    value: r.cache_read_tokens / r.prompt_tokens,
  }));
}

export type LatencyStratifyBy = "bank" | "source";
const LATENCY_COLS: readonly LatencyStratifyBy[] = ["bank", "source"];

export function fetchLatencySamples(
  window: WindowSpec,
  stratifyBy?: LatencyStratifyBy,
): Sample[] {
  assertAllowedColumn(stratifyBy, LATENCY_COLS, "latency");
  const db = getDatabase();
  const col = stratifyBy ? `, COALESCE(${stratifyBy}, '(null)') AS bucket` : "";
  const rows = db
    .prepare(
      `SELECT latency_ms AS value${col}
       FROM recall_audit
       WHERE created_at >= datetime('now', ?) AND latency_ms IS NOT NULL`,
    )
    .all(window.modifier) as Array<{ value: number; bucket?: string }>;
  return rows.map((r) => ({ bucket: r.bucket, value: r.value }));
}

export type CostStratifyBy = "agent_type" | "model";
const COST_COLS: readonly CostStratifyBy[] = ["agent_type", "model"];

export function fetchCostSamples(
  window: WindowSpec,
  stratifyBy?: CostStratifyBy,
): Sample[] {
  assertAllowedColumn(stratifyBy, COST_COLS, "cost");
  const db = getDatabase();
  const col = stratifyBy ? `, ${stratifyBy} AS bucket` : "";
  const rows = db
    .prepare(
      `SELECT cost_usd AS value${col}
       FROM cost_ledger
       WHERE created_at >= datetime('now', ?)`,
    )
    .all(window.modifier) as Array<{ value: number; bucket?: string }>;
  return rows.map((r) => ({ bucket: r.bucket, value: r.value }));
}

// ---------------------------------------------------------------------------
// Top-level dispatcher used by mc-ctl
// ---------------------------------------------------------------------------

export type Metric = "utility" | "cache-hit" | "latency" | "cost";

export interface AuditClaimRequest {
  metric: Metric;
  window: string;
  stratifyBy?: string;
  baseline?: number;
  minN?: number;
}

export function runAudit(req: AuditClaimRequest): AuditResult {
  const window = parseWindow(req.window);
  let samples: Sample[];
  let claim: string;
  // Per-metric defaults — latency/cost are continuous so the default 15pp
  // divergence threshold (built for 0/1 rates) won't apply meaningfully.
  // For continuous metrics we widen the threshold relative to the aggregate.
  const baseOpts: AuditOptions = {
    claim: "",
    minN: req.minN,
    baseline: req.baseline,
  };

  switch (req.metric) {
    case "utility":
      samples = fetchUtilitySamples(
        window,
        req.stratifyBy as UtilityStratifyBy | undefined,
      );
      claim = `Recall utility (was_used) over last ${window.label}${req.stratifyBy ? ` stratified by ${req.stratifyBy}` : ""}`;
      break;
    case "cache-hit":
      samples = fetchCacheHitSamples(
        window,
        req.stratifyBy as CacheHitStratifyBy | undefined,
      );
      claim = `Cache-hit ratio (cache_read/prompt) over last ${window.label}${req.stratifyBy ? ` stratified by ${req.stratifyBy}` : ""}`;
      break;
    case "latency":
      samples = fetchLatencySamples(
        window,
        req.stratifyBy as LatencyStratifyBy | undefined,
      );
      claim = `Recall latency (ms) over last ${window.label}${req.stratifyBy ? ` stratified by ${req.stratifyBy}` : ""}`;
      break;
    case "cost":
      samples = fetchCostSamples(
        window,
        req.stratifyBy as CostStratifyBy | undefined,
      );
      claim = `Cost (USD) over last ${window.label}${req.stratifyBy ? ` stratified by ${req.stratifyBy}` : ""}`;
      break;
    default: {
      const exhaustive: never = req.metric;
      throw new Error(`Unknown metric: ${exhaustive as string}`);
    }
  }

  // Continuous metrics need a different divergence scale. Compute aggregate
  // mean first; use 15% of aggregate as the divergence threshold instead of
  // an absolute 0.15. Keeps the "stratification divergence" semantic tight
  // for big numbers (latency in ms, cost in USD).
  const continuousMetrics: ReadonlySet<Metric> = new Set(["latency", "cost"]);
  if (continuousMetrics.has(req.metric) && samples.length > 0) {
    const aggMean =
      samples.reduce((a, s) => a + s.value, 0) / samples.length || 1;
    baseOpts.minDivergencePct = Math.abs(aggMean) * 0.15;
  }

  return auditAggregate(samples, { ...baseOpts, claim });
}

// ---------------------------------------------------------------------------
// CLI rendering — pretty-prints AuditResult for terminal/Markdown
// ---------------------------------------------------------------------------

export function renderAuditResult(result: AuditResult): string {
  const lines: string[] = [];
  lines.push(`Claim: ${result.claim}`);
  lines.push(`n=${result.n}, headline=${formatRate(result.mean)}`);
  if (result.baselineDelta !== undefined) {
    const dir = result.baselineDelta >= 0 ? "+" : "";
    lines.push(`baseline delta: ${dir}${formatRate(result.baselineDelta)}`);
  }
  lines.push(
    result.verified
      ? "VERDICT: VERIFIED (no warnings, sample sufficient)"
      : `VERDICT: ${result.warnings.length === 0 ? "INSUFFICIENT N" : "WARNINGS"} — do not report headline as-is`,
  );
  if (result.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const w of result.warnings) lines.push(`  - ${w}`);
  }
  if (result.stratification.length > 0) {
    lines.push("");
    lines.push("Stratification (sorted by n):");
    lines.push("  bucket           n      mean");
    for (const b of result.stratification) {
      const bucket = b.bucket.padEnd(16);
      const n = String(b.n).padStart(5);
      lines.push(`  ${bucket} ${n}  ${formatRate(b.mean)}`);
    }
  }
  if (result.notes.length > 0) {
    lines.push("");
    lines.push("Notes:");
    for (const note of result.notes) lines.push(`  - ${note}`);
  }
  return lines.join("\n");
}
