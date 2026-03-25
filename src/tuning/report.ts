/**
 * Morning report generator for overnight tuning runs.
 *
 * Produces a markdown report summarizing:
 * - Score progression (baseline → best)
 * - Winning mutations with details
 * - Cost summary
 */

import type { Experiment, TuneRun } from "./types.js";

export function generateReport(
  run: TuneRun,
  experiments: Experiment[],
): string {
  const wins = experiments.filter((e) => e.status === "passed");
  const losses = experiments.filter((e) => e.status === "regressed");
  const errors = experiments.filter((e) => e.status === "error");

  const baselineScore = run.baseline_score ?? 0;
  const bestScore = run.best_score ?? baselineScore;
  const delta = bestScore - baselineScore;
  const sign = delta >= 0 ? "+" : "";

  const lines: string[] = [];

  lines.push(`# TUNING REPORT — ${new Date().toLocaleDateString("en-CA")}`);
  lines.push("");
  lines.push(
    `**Baseline**: ${baselineScore.toFixed(1)} → **Best**: ${bestScore.toFixed(1)} (${sign}${delta.toFixed(1)})`,
  );
  lines.push(
    `**Experiments**: ${experiments.length} run, ${wins.length} improvements, ${losses.length} regressions, ${errors.length} errors`,
  );
  lines.push(`**Cost**: $${run.total_cost_usd.toFixed(2)}`);

  if (wins.length > 0) {
    lines.push("");
    lines.push("## Winning Mutations");
    for (let i = 0; i < wins.length; i++) {
      const e = wins[i];
      const scoreDelta = (e.mutated_score ?? 0) - (e.baseline_score ?? 0);
      lines.push("");
      lines.push(`### ${i + 1}. ${e.surface}/${e.target}`);
      lines.push(`- **Score delta**: +${scoreDelta.toFixed(1)}`);
      lines.push(`- **Type**: ${e.mutation_type}`);
      lines.push(`- **Hypothesis**: ${e.hypothesis ?? "none"}`);
      lines.push(`- **New value** (truncated):`);
      lines.push("```");
      lines.push(e.mutated_value.slice(0, 500));
      lines.push("```");
    }
  }

  if (losses.length > 0) {
    lines.push("");
    lines.push("## Failed Experiments (top 5)");
    for (const e of losses.slice(0, 5)) {
      const scoreDelta = (e.mutated_score ?? 0) - (e.baseline_score ?? 0);
      lines.push(
        `- ${e.surface}/${e.target}: ${scoreDelta.toFixed(1)} — ${e.hypothesis ?? "none"}`,
      );
    }
  }

  lines.push("");
  lines.push("## Promotion");
  lines.push("```bash");
  lines.push(`./mc-ctl tuning report ${run.run_id}`);
  lines.push(`./mc-ctl tuning promote ${run.run_id}`);
  lines.push("```");

  return lines.join("\n");
}
