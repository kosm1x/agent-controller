/**
 * Summary renderer for scripts/benchmark-opus-tier.ts (works on partial
 * results — safe to call mid-run). Pure: no fs, no env, so the tests call it
 * directly instead of spawning the operator-gated script.
 */

import { calculateCost } from "../../src/budget/pricing.js";

export interface CallRow {
  task: string;
  family: string;
  phase: "plan" | "reflect" | "assess" | "execute";
  model: string;
  config: "A" | "B";
  reportedModel?: string;
  ok: boolean;
  error?: string;
  durationMs: number;
  numTurns?: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  textChars: number;
  bareJson?: boolean;
  fencedJson?: boolean;
  thinkingLeak: boolean;
  toolCallInText: boolean;
  goals?: number;
  criteria?: number;
  gates?: number;
  storedGoals?: number;
  score?: number;
  storedScore?: number;
  met?: boolean | null;
  toolCalls?: number;
  storedToolCalls?: number;
  completedGoals?: number;
}

function pct(n: number, d: number): string {
  return d === 0 ? "n/a" : `${((100 * n) / d).toFixed(0)}%`;
}
function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

export function renderSummary(rows: CallRow[], OUT: string): string {
  const arms = [...new Set(rows.map((r) => `${r.model}|${r.config}`))].sort();
  const lines: string[] = [];
  lines.push(`# Opus-tier benchmark — ${OUT.split("/").pop()} — ${new Date().toISOString()}`);
  lines.push("");
  lines.push(`Rows: ${rows.length} · tasks: ${new Set(rows.map((r) => r.task)).size} · spend: $${rows.reduce((a, r) => a + r.costUsd, 0).toFixed(2)}`);
  lines.push("");
  for (const phase of ["plan", "reflect", "assess", "execute"] as const) {
    const ph = rows.filter((r) => r.phase === phase);
    if (ph.length === 0) continue;
    lines.push(`## ${phase}`);
    lines.push("");
    lines.push(
      "| arm | n | ok | bare JSON | parsed (ok) | think-leak | tool-in-text | prompt tok | cache-read | compl tok | $/call | s/call | turns | " +
        (phase === "plan" ? "goals (stored) | criteria | gates |" : phase === "execute" ? "tool calls (stored) | goals done | score |" : phase === "reflect" ? "score (stored) | success agree |" : "met (stored run completed every one) |"),
    );
    lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|" + (phase === "plan" ? "---|---|---|" : phase === "execute" ? "---|---|---|" : phase === "reflect" ? "---|---|" : "---|"));
    for (const arm of arms) {
      const [model, config] = arm.split("|");
      const a = ph.filter((r) => r.model === model && r.config === config);
      if (a.length === 0) continue;
      // Rates/means over OK rows only — a failed row carries zeros and would
      // deflate exactly the token/cost comparison the decision rule turns on.
      const okRows = a.filter((r) => r.ok);
      const prompt = mean(okRows.map((r) => r.promptTokens));
      const cacheRead = okRows.reduce((s, r) => s + r.cacheReadTokens, 0);
      const promptSum = okRows.reduce((s, r) => s + r.promptTokens, 0);
      const isExec = phase === "execute"; // per-call text/turn stats are not defined for a whole graph run
      const base =
        `| ${model} ${config} | ${a.length} | ${pct(okRows.length, a.length)} | ${isExec ? "n/a" : pct(okRows.filter((r) => r.bareJson).length, okRows.length)} | ` +
        // plan throws on unparseable JSON and assess is ok only with a parsed
        // assessment; reflect swallows a parse failure into its heuristic.
        `${phase === "plan" || phase === "assess" ? pct(okRows.length, a.length) : "n/a"} | ` +
        `${a.filter((r) => r.thinkingLeak).length} | ${a.filter((r) => r.toolCallInText).length} | ${prompt.toFixed(0)} | ` +
        `${pct(cacheRead, promptSum)} | ${mean(okRows.map((r) => r.completionTokens)).toFixed(0)} | ` +
        `${mean(okRows.map((r) => r.costUsd)).toFixed(3)} | ${(mean(okRows.map((r) => r.durationMs)) / 1000).toFixed(1)} | ${isExec ? "n/a" : mean(okRows.map((r) => r.numTurns ?? 0)).toFixed(1)} |`;
      let tail = "";
      if (phase === "plan") {
        tail = ` ${mean(okRows.map((r) => r.goals ?? 0)).toFixed(1)} (${mean(okRows.map((r) => r.storedGoals ?? 0)).toFixed(1)}) | ${mean(okRows.map((r) => r.criteria ?? 0)).toFixed(1)} | ${mean(okRows.map((r) => r.gates ?? 0)).toFixed(1)} |`;
      } else if (phase === "execute") {
        tail = ` ${mean(okRows.map((r) => r.toolCalls ?? 0)).toFixed(1)} (${mean(okRows.map((r) => r.storedToolCalls ?? 0)).toFixed(1)}) | ${mean(okRows.map((r) => r.completedGoals ?? 0)).toFixed(1)}/${mean(okRows.map((r) => r.storedGoals ?? 0)).toFixed(1)} | ${mean(okRows.map((r) => r.score ?? 0)).toFixed(2)} |`;
      } else if (phase === "reflect") {
        const agree = okRows.filter((r) => (r.score ?? 0) >= 0.8 === (r.storedScore ?? 0) >= 0.8).length;
        tail = ` ${mean(okRows.map((r) => r.score ?? 0)).toFixed(2)} (${mean(okRows.map((r) => r.storedScore ?? 0)).toFixed(2)}) | ${pct(agree, okRows.length)} |`;
      } else {
        // Every assess input is a goal the stored 4.8 run completed, so met=true is the expected reading.
        const metRows = okRows.filter((r) => r.met !== null && r.met !== undefined);
        tail = ` ${pct(metRows.filter((r) => r.met).length, metRows.length)} |`;
      }
      lines.push(base + tail);
    }
    lines.push("");
  }
  // SDK-reported total_cost_usd vs usage × pricing.ts: a new model the SDK
  // mis-prices shows as a ratio far from 1.00 (OK rows only, like the tables).
  lines.push("## Cost two ways (OK rows)");
  lines.push("");
  lines.push("| arm | phase | n | SDK total_cost_usd Σ | usage × pricing.ts Σ | SDK / pricing.ts |");
  lines.push("|---|---|---|---|---|---|");
  for (const arm of arms) {
    const [model, config] = arm.split("|");
    for (const phase of ["plan", "reflect", "assess", "execute"] as const) {
      const a = rows.filter((r) => r.ok && r.phase === phase && r.model === model && r.config === config);
      if (a.length === 0) continue;
      const sdk = a.reduce((s, r) => s + r.costUsd, 0);
      const priced = a.reduce((s, r) => s + calculateCost(r.reportedModel || r.model, r.promptTokens, r.completionTokens, r.cacheReadTokens, r.cacheCreationTokens), 0);
      lines.push(`| ${model} ${config} | ${phase} | ${a.length} | ${sdk.toFixed(3)} | ${priced.toFixed(3)} | ${priced ? (sdk / priced).toFixed(2) : "n/a"} |`);
    }
  }
  lines.push("");
  lines.push("execute rows price the whole graph run's summed usage at the arm's model (Sonnet-routed legs, if any, are priced as that model).");
  lines.push("");
  const errs = rows.filter((r) => !r.ok);
  if (errs.length) {
    lines.push("## Errors");
    lines.push("");
    for (const e of errs) lines.push(`- ${e.task} ${e.phase} ${e.model}/${e.config}: ${e.error}`);
    lines.push("");
  }
  lines.push("Gate 1 (contract) reads `parsed (ok)` — the reply parsed into the phase's JSON (fenced JSON included; plan and assess only, since reflect falls back to a heuristic on a parse failure); `bare JSON` is formatting only.");
  lines.push("");
  lines.push("Agreement columns compare against the STORED 4.8 production run (a proxy, not ground truth): reflect = success threshold 0.8 on both; assess = met on a goal the stored run completed. Spend cap is checked after each recorded call/graph run, not mid-run.");
  return lines.join("\n");
}
