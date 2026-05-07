/**
 * Hindsight cost-pull ritual.
 *
 * Hindsight (the recall sidecar at crm-hindsight:8888) bills directly to
 * Fireworks via its own API key. mc's cost_ledger never sees that spend, so
 * /health, the 3-window budget enforcer, and alert rules have all been blind
 * to ~half of the inference bill (~$5-10/day undocumented as of 2026-05-07).
 *
 * This ritual closes that gap: every 5 min, scrape Hindsight's Prometheus
 * counters via mc-prometheus, compute the per-series delta over the last 5
 * minutes, and write a cost_ledger row per (scope, model, success) combo.
 *
 * Idempotent: each row uses a deterministic run_id derived from the series
 * label set + bucket timestamp, and we skip insert if the row already exists.
 * A retry of the same bucket is a no-op.
 *
 * See queue item #4 + feedback_fireworks_qwen3p6_retry_storm for context.
 */
import { createHash } from "node:crypto";
import { getDatabase } from "../db/index.js";
import { recordCost } from "../budget/service.js";
import { calculateCost } from "../budget/pricing.js";

const DEFAULT_PROM_URL = "http://127.0.0.1:9090";
const BUCKET_MS = 5 * 60 * 1000;
const QUERY_TIMEOUT_MS = 10_000;

interface PromVectorResult {
  status: "success" | "error";
  data?: {
    resultType: "vector";
    result: Array<{
      metric: Record<string, string>;
      value: [number, string];
    }>;
  };
  error?: string;
}

interface PullSummary {
  bucket: string;
  series: number;
  recorded: number;
  skipped: number;
  cost_usd: number;
}

async function queryProm(query: string): Promise<PromVectorResult> {
  const baseUrl = process.env.HINDSIGHT_COST_PULL_PROM_URL ?? DEFAULT_PROM_URL;
  const params = new URLSearchParams({ query });
  const resp = await fetch(`${baseUrl}/api/v1/query?${params}`, {
    signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
  });
  if (!resp.ok) {
    throw new Error(`Prometheus HTTP ${resp.status} for query: ${query}`);
  }
  return (await resp.json()) as PromVectorResult;
}

function seriesKey(metric: Record<string, string>): string {
  const model = metric.model ?? "unknown";
  const scope = metric.scope ?? "unknown";
  const provider = metric.provider ?? "unknown";
  const success = metric.success ?? "true";
  const tenant = metric.tenant ?? "public";
  return `${model}|${scope}|${provider}|${success}|${tenant}`;
}

function shortHash(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 8);
}

/**
 * Pull last 5 minutes of Hindsight token deltas and record each (scope,
 * model, success) combo as a cost_ledger row tagged agent_type='hindsight'.
 */
export async function runHindsightCostPull(): Promise<PullSummary> {
  const now = Date.now();
  const bucket = Math.floor(now / BUCKET_MS) * BUCKET_MS;
  const bucketIso = new Date(bucket).toISOString();

  const [inputResp, outputResp] = await Promise.all([
    queryProm("increase(hindsight_llm_tokens_input_tokens_total[5m])"),
    queryProm("increase(hindsight_llm_tokens_output_tokens_total[5m])"),
  ]);

  if (inputResp.status !== "success" || outputResp.status !== "success") {
    throw new Error(
      `Prometheus query error: input=${inputResp.error ?? "ok"} output=${outputResp.error ?? "ok"}`,
    );
  }

  type SeriesData = { metric: Record<string, string>; tokens: number };
  const inputBy = new Map<string, SeriesData>();
  for (const r of inputResp.data?.result ?? []) {
    const tokens = Math.max(0, parseFloat(r.value[1]));
    if (tokens > 0)
      inputBy.set(seriesKey(r.metric), { metric: r.metric, tokens });
  }

  const outputBy = new Map<string, SeriesData>();
  for (const r of outputResp.data?.result ?? []) {
    const tokens = Math.max(0, parseFloat(r.value[1]));
    if (tokens > 0)
      outputBy.set(seriesKey(r.metric), { metric: r.metric, tokens });
  }

  const allKeys = new Set([...inputBy.keys(), ...outputBy.keys()]);
  const db = getDatabase();
  const exists = db.prepare(
    "SELECT 1 FROM cost_ledger WHERE run_id = ? LIMIT 1",
  );

  let recorded = 0;
  let skipped = 0;
  let costSum = 0;

  for (const key of allKeys) {
    const inp = inputBy.get(key);
    const out = outputBy.get(key);
    const metric = inp?.metric ?? out?.metric ?? {};
    const promptTokens = Math.round(inp?.tokens ?? 0);
    const completionTokens = Math.round(out?.tokens ?? 0);

    const scope = metric.scope ?? "unknown";
    const model = metric.model ?? "unknown";
    const runId = `hindsight-${scope}-${shortHash(key)}-${bucketIso}`;

    if (exists.get(runId)) {
      skipped += 1;
      continue;
    }

    recordCost({
      runId,
      taskId: runId,
      agentType: "hindsight",
      model,
      promptTokens,
      completionTokens,
    });
    recorded += 1;
    costSum += calculateCost(model, promptTokens, completionTokens);
  }

  return {
    bucket: bucketIso,
    series: allKeys.size,
    recorded,
    skipped,
    cost_usd: Math.round(costSum * 10000) / 10000,
  };
}
