/**
 * Summary renderer for scripts/benchmark-sonnet-tier.ts (works on partial
 * results — safe mid-run and via --summarize). Pure: no fs, no env, so the
 * tests call it directly instead of spawning the operator-gated script.
 */

import { calculateCost } from "../../src/budget/pricing.js";

export type ArmId = "A" | "B" | "C" | "D" | "E";
export const ALL_ARMS: ArmId[] = ["A", "B", "C", "D", "E"];

export interface CallRow {
  task: string; // 8-char prefix
  title: string;
  arm: ArmId;
  position: number; // 0-based slot in this task's rotated arm order
  model: string; // the arm's requested model
  effective_model: string;
  model_mismatch: boolean;
  cost_usd: number; // Σ per SDK call: total_cost_usd, or calculateCost(usage) when not authoritative
  cost_authoritative: boolean; // every SDK call reported a terminal total_cost_usd
  cost_estimated: boolean; // ≥1 SDK call (abort/timeout) was priced from usage
  runner_cost_usd?: number; // RunnerOutput.tokenUsage.actualCostUsd
  turns: number;
  tool_calls: number;
  tool_names: string[];
  prompt_tokens: number; // total input incl. cache read + creation
  cache_read_tokens: number;
  cache_creation_tokens: number;
  completion_tokens: number;
  cache_read_ratio: number;
  duration_ms: number;
  sdk_calls: number;
  status: string; // RunnerOutput.status (the runner's parseRunnerStatus + promotions)
  raw_status: string; // parseRunnerStatus over the last raw SDK text
  success: boolean;
  empty_completion: boolean;
  text_chars: number;
  tool_jaccard: number;
  msg_truncated: boolean; // replayed user message came from the 500-char telemetry cut
  error?: string;
  // stored production run, for reference
  orig_cost_usd: number;
  orig_turns: number | null;
  orig_tools: string[];
  orig_models?: string[]; // cost_ledger.model of the stored run (absent on runs before 2026-10-06)
  orig_created_at?: string; // tasks.created_at (SQLite UTC)
}

export const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const DONE_CLASS = new Set(["DONE", "DONE_WITH_CONCERNS"]);
/** Usage × pricing.ts list rates: the check on the SDK's total_cost_usd for a
 *  new model (an SDK that does not know a model's price shows up here). */
function pricingCost(r: CallRow): number {
  const m = r.effective_model && r.effective_model !== "none" && !r.effective_model.includes("+") ? r.effective_model : r.model;
  return calculateCost(m, r.prompt_tokens, r.completion_tokens, r.cache_read_tokens, r.cache_creation_tokens);
}
/** Request shape per arm (the model comes from the rows, so --summarize labels a past run correctly). */
const armShape = (MODEL_A: string): Record<ArmId, string> => ({
  A: `incumbent (${MODEL_A}, effort unset): thinking per model (disabled on 4.x, adaptive on 5.x)`,
  B: "adaptive thinking, effort medium",
  C: "adaptive thinking, effort low",
  D: "adaptive thinking, effort low",
  E: "adaptive thinking, effort medium",
});

interface ArmAgg {
  arm: ArmId;
  n: number;
  total_cost: number;
  mean_cost: number;
  mean_s: number;
  median_s: number;
  mean_turns: number;
  mean_tools: number;
  cache_read_ratio: number; // Σ cache_read / Σ prompt (token-weighted)
  mean_cache_read_ratio: number; // per-call mean
  empty: number;
  errors: number;
  status: Record<string, number>;
  mean_jaccard: number;
  mismatches: number;
  estimated: number; // rows whose cost was (partly) estimated from usage
  pricing_cost: number; // Σ usage × src/budget/pricing.ts list rates
  model: string; // requested model(s) of the arm's rows
  completed: number;
  cost_per_completed: number | null;
}

function aggregate(rows: CallRow[]): { paired: string[]; arms: ArmAgg[] } {
  const arms = ALL_ARMS.filter((a) => rows.some((r) => r.arm === a));
  // Paired set: tasks that have a row for EVERY arm present — a --max-usd stop
  // or crash mid-task must not skew one arm's denominator.
  const byTask = new Map<string, Set<ArmId>>();
  for (const r of rows) byTask.set(r.task, (byTask.get(r.task) ?? new Set()).add(r.arm));
  const paired = [...byTask.entries()].filter(([, s]) => arms.every((a) => s.has(a))).map(([t]) => t);
  const pr = rows.filter((r) => paired.includes(r.task));
  return {
    paired,
    arms: arms.map((arm) => {
      const a = pr.filter((r) => r.arm === arm);
      const status: Record<string, number> = {};
      for (const r of a) status[r.status] = (status[r.status] ?? 0) + 1;
      const completed = a.filter((r) => DONE_CLASS.has(r.status) && !r.empty_completion).length;
      const total = a.reduce((s, r) => s + r.cost_usd, 0);
      const promptSum = a.reduce((s, r) => s + r.prompt_tokens, 0);
      return {
        arm,
        n: a.length,
        total_cost: total,
        mean_cost: mean(a.map((r) => r.cost_usd)),
        mean_s: mean(a.map((r) => r.duration_ms)) / 1000,
        median_s: median(a.map((r) => r.duration_ms)) / 1000,
        mean_turns: mean(a.map((r) => r.turns)),
        mean_tools: mean(a.map((r) => r.tool_calls)),
        cache_read_ratio: promptSum ? a.reduce((s, r) => s + r.cache_read_tokens, 0) / promptSum : 0,
        mean_cache_read_ratio: mean(a.map((r) => r.cache_read_ratio)),
        empty: a.filter((r) => r.empty_completion).length,
        errors: a.filter((r) => r.error).length,
        status,
        mean_jaccard: mean(a.map((r) => r.tool_jaccard)),
        mismatches: a.filter((r) => r.model_mismatch).length,
        estimated: a.filter((r) => r.cost_estimated).length,
        pricing_cost: a.reduce((s, r) => s + pricingCost(r), 0),
        model: [...new Set(a.map((r) => r.model))].join("+"),
        completed,
        cost_per_completed: completed ? total / completed : null,
      };
    }),
  };
}

/** Pool date range + reference model(s) of the stored production answers the
 *  rows were compared with (one entry per task). */
export function referenceInfo(rows: CallRow[]): { from: string | null; to: string | null; models: Record<string, number>; unknown: number } {
  const byTask = new Map<string, CallRow>();
  for (const r of rows) if (!byTask.has(r.task)) byTask.set(r.task, r);
  const dates = [...byTask.values()].map((r) => r.orig_created_at).filter((d): d is string => !!d).sort();
  const models: Record<string, number> = {};
  let unknown = 0;
  for (const r of byTask.values()) {
    if (!r.orig_models) { unknown++; continue; }
    const k = r.orig_models.length ? r.orig_models.join("+") : "none";
    models[k] = (models[k] ?? 0) + 1;
  }
  return { from: dates[0] ?? null, to: dates.at(-1) ?? null, models, unknown };
}
export function referenceLine(ref: ReturnType<typeof referenceInfo>): string {
  const models = Object.entries(ref.models).map(([m, n]) => `${m} ×${n}`).join(", ");
  return (
    `Pool created ${ref.from ?? "n/a"} → ${ref.to ?? "n/a"} UTC · reference (stored production answer) model(s): ${models || "n/a"}` +
    (ref.unknown ? ` · ${ref.unknown} task(s) without a recorded reference model (run predates 2026-10-06)` : "")
  );
}

export function renderSummary(rows: CallRow[], MODEL_A: string, OUT: string): { md: string; json: unknown } {
  const ARM_SHAPE = armShape(MODEL_A);
  const { paired, arms } = aggregate(rows);
  const A = arms.find((x) => x.arm === "A");
  const ref = referenceInfo(rows);
  const ratio = (x: number, y: number | undefined) => (y ? (x / y).toFixed(2) : "n/a");
  const L: string[] = [];
  L.push(`# Sonnet-tier (fast path) benchmark — ${OUT.split("/").pop()}`);
  L.push("");
  L.push(`Generated ${new Date().toISOString()} · rows ${rows.length} · paired tasks ${paired.length} · spend $${rows.reduce((s, r) => s + r.cost_usd, 0).toFixed(2)}`);
  L.push("");
  L.push(`Arms: ${arms.map((a) => `${a.arm} = ${a.model}, ${ARM_SHAPE[a.arm]}`).join(" · ")}.`);
  L.push("");
  L.push(`${referenceLine(ref)}. tool_jaccard (gate 3) and the grader's REFERENCE are relative to this model: an arm that shares the reference's shape is favoured.`);
  L.push("");
  L.push("Arm order was ROTATED per task (ABC, BCA, CAB, …) so no arm always runs first on a cold prompt cache; each row's 0-based `position` is in calls.jsonl.");
  L.push("");
  L.push("## Per arm (paired tasks only)");
  L.push("");
  L.push("| arm | n | total $ | mean $ | mean s | median s | turns | tool calls | cache-read (Σ) | cache-read (mean) | empty | errors | STATUS | tool_jaccard | model mismatch | est. cost rows | completed | $/completed |");
  L.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const a of arms) {
    L.push(
      `| ${a.arm} | ${a.n} | ${a.total_cost.toFixed(3)} | ${a.mean_cost.toFixed(4)} | ${a.mean_s.toFixed(1)} | ${a.median_s.toFixed(1)} | ${a.mean_turns.toFixed(1)} | ${a.mean_tools.toFixed(1)} | ` +
        `${(100 * a.cache_read_ratio).toFixed(1)}% | ${(100 * a.mean_cache_read_ratio).toFixed(1)}% | ${a.empty} | ${a.errors} | ${Object.entries(a.status).map(([k, v]) => `${k}:${v}`).join(" ")} | ` +
        `${a.mean_jaccard.toFixed(2)} | ${a.mismatches} | ${a.estimated} | ${a.completed} | ${a.cost_per_completed === null ? "n/a" : a.cost_per_completed.toFixed(4)} |`,
    );
  }
  L.push("");
  L.push("## Cost two ways (paired tasks)");
  L.push("");
  L.push("| arm | model | SDK total_cost_usd Σ | usage × pricing.ts Σ | SDK / pricing.ts | est. cost rows |");
  L.push("|---|---|---|---|---|---|");
  for (const a of arms) {
    L.push(`| ${a.arm} | ${a.model} | ${a.total_cost.toFixed(3)} | ${a.pricing_cost.toFixed(3)} | ${ratio(a.total_cost, a.pricing_cost)} | ${a.estimated} |`);
  }
  L.push("");
  L.push("A ratio far from 1.00 on one arm means the SDK and src/budget/pricing.ts disagree on that model's price (the SDK column already uses pricing.ts for est. cost rows).");
  L.push("");
  const gates: Record<string, Record<string, boolean | null>> = {};
  if (A) {
    L.push("## Ratios vs A");
    L.push("");
    L.push("| arm | cost | duration | cache-read ratio (Σ) |");
    L.push("|---|---|---|---|");
    for (const a of arms.filter((x) => x.arm !== "A")) {
      L.push(`| ${a.arm}/A | ${ratio(a.total_cost, A.total_cost)} | ${ratio(a.mean_s, A.mean_s)} | ${ratio(a.cache_read_ratio, A.cache_read_ratio)} |`);
    }
    L.push("");
    L.push("## Decision gates (adopt a candidate arm only if ALL four pass vs A — see plan doc)");
    L.push("");
    L.push("| arm | 1 $/completed ≤ A | 2 empty ≤ A and errors ≤ A | 3 tool_jaccard within 0.1 of A | 4 cache-read ≥ A − 10 pts | verdict |");
    L.push("|---|---|---|---|---|---|");
    for (const a of arms.filter((x) => x.arm !== "A")) {
      const g1 = a.cost_per_completed === null || A.cost_per_completed === null ? null : a.cost_per_completed <= A.cost_per_completed;
      const g2 = a.empty <= A.empty && a.errors <= A.errors;
      const g3 = Math.abs(a.mean_jaccard - A.mean_jaccard) <= 0.1;
      const g4 = a.cache_read_ratio >= A.cache_read_ratio - 0.1;
      gates[a.arm] = { cost_per_completed: g1, empty_and_errors: g2, tool_jaccard: g3, cache_read: g4 };
      const f = (b: boolean | null) => (b === null ? "n/a" : b ? "PASS" : "FAIL");
      const verdict = g1 === true && g2 && g3 && g4 ? "PASS" : "FAIL";
      L.push(`| ${a.arm} | ${f(g1)} | ${f(g2)} | ${f(g3)} | ${f(g4)} | ${verdict} |`);
    }
    L.push("");
  }
  L.push("## Per task (cost $ / seconds / turns / tool calls / STATUS)");
  L.push("");
  const armIds = arms.map((a) => a.arm);
  L.push(`| task | title | orig $ | ${armIds.join(" | ")} |`);
  L.push(`|---|---|---|${armIds.map(() => "---").join("|")}|`);
  const tasks = [...new Set(rows.map((r) => r.task))];
  for (const t of tasks) {
    const tr = rows.filter((r) => r.task === t);
    const cells = armIds.map((arm) => {
      const r = tr.find((x) => x.arm === arm);
      return r
        ? `${r.cost_usd.toFixed(3)} / ${(r.duration_ms / 1000).toFixed(0)}s / ${r.turns}t / ${r.tool_calls} / ${r.status}${r.empty_completion ? " EMPTY" : ""}${r.error ? " ERR" : ""}${r.model_mismatch ? " MISMATCH" : ""}`
        : "—";
    });
    L.push(`| ${t}${paired.includes(t) ? "" : " (unpaired)"} | ${oneLine(tr[0].title).replace(/\|/g, "/").slice(0, 50)} | ${tr[0].orig_cost_usd.toFixed(3)} | ${cells.join(" | ")} |`);
  }
  L.push("");
  const errs = rows.filter((r) => r.error);
  if (errs.length) {
    L.push("## Errors");
    L.push("");
    for (const e of errs) L.push(`- ${e.task} ${e.arm}: ${e.error?.slice(0, 200)}`);
    L.push("");
  }
  L.push("Notes: cost is the SDK-reported total_cost_usd summed over every SDK call of the run (resume/auth legs included); a call without a terminal cost (abort/timeout) is priced from its token usage via src/budget/pricing (`est. cost rows`), and that estimate counts toward --max-usd. Aggregates use paired tasks only. `completed` = STATUS DONE/DONE_WITH_CONCERNS with non-empty text. tool_jaccard compares tool-NAME sets with the stored production run (ToolSearch excluded); the replay only has the read-only subset, so it is a proxy. The spend cap is checked after each task-arm, not mid-run. Answers side by side: results/<task>-<arm>.md (orig = stored production answer).");
  L.push("");
  L.push(
    "Fidelity limits: (1) narrower tool scope — each replay gets only the stored scope ∩ the 11-tool read-only allow-list; every replayed task still has a tool that guards.isReadOnlyTool does not class read-only, so none takes the omit-KB branch; " +
      "(2) maxRounds is the CODING tier whenever grep/glob are in the replay scope (the runner keys it on tool names); " +
      "(3) chat history is rebuilt from per-channel `conversations` rows, not the router's in-memory thread buffer; " +
      "(4) the snapshot's KB and JME facts are NEWER than the replayed tasks (facts learned after a task can reach its replay); " +
      "(5) the mc.db + -wal copy is not atomic (a write between the two copies can leave the snapshot a few rows inconsistent); " +
      "(6) the Claude subscription rate limit is shared with the live service — a 429 shows in the error column, not as a model failure. " +
      "Rows with msg_truncated=true replayed the 500-char scope_telemetry cut of the user message (no jme_turns row).",
  );
  return { md: L.join("\n"), json: { out: OUT, generated: new Date().toISOString(), paired, reference: ref, arms, gates } };
}
