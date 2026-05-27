/**
 * mc-ctl briefing-gate — V8.1 §13 activation-gate report.
 *
 * Invoked by `mc-ctl briefing-gate`. Evaluates the §13 activation gate
 * (cache-read ratio over cacheable inference + morning-brief promote-rate)
 * and prints an operator-readable report. Read-only — no writes.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initDatabase } from "../src/db/index.js";
import { evaluateActivationGate } from "../src/briefing/activation-gate.js";

// Resolve the DB path relative to THIS script, so the helper works regardless
// of the invoking cwd (same pattern as scripts/events-ctl.ts).
const DB_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "data",
  "mc.db",
);

const VERDICT_LABEL = {
  pass: "✅ PASS — V8.1 §13 activation gate met",
  fail: "❌ FAIL — below a §13 threshold",
  insufficient_data: "⏳ INSUFFICIENT DATA — shadow run still accumulating",
} as const;

function main(): number {
  initDatabase(DB_PATH);
  const g = evaluateActivationGate();

  console.log("=== V8.1 §13 Activation Gate ===\n");
  console.log(VERDICT_LABEL[g.verdict]);
  console.log("");

  console.log("Cache-read ratio (cacheable inference, last 24h):");
  console.log(
    `  ${g.checks.cacheRead.pass ? "✓" : "✗"} ${g.checks.cacheRead.detail}`,
  );
  console.log(
    `  cacheable runs: ${g.cacheableRuns}   cacheable cost: $${g.cacheableCostUsd}`,
  );
  console.log("");

  console.log("Morning briefing promote-rate (last 7d):");
  console.log(
    `  ${g.checks.promoteRate.pass ? "✓" : "✗"} ${g.checks.promoteRate.detail}`,
  );
  console.log("");

  if (g.briefingHealth.length > 0) {
    console.log("Briefing health by surface (last 7d):");
    for (const h of g.briefingHealth) {
      console.log(
        `  ${h.surface}: ${h.generated} generated · ${h.promoted} promoted · ` +
          `${h.discarded} discarded · ${h.expired} expired · ${h.pending} pending ` +
          `· ${h.promoteRatePct}% promote-rate`,
      );
    }
  } else {
    console.log(
      "Briefing health by surface (last 7d): no briefings generated.",
    );
  }

  // Distinct exit codes so the operator (or a script) can branch on the
  // activation decision: 0 = pass (gate met), 1 = fail (below a threshold),
  // 2 = insufficient data (shadow run still accumulating — not an error).
  return g.verdict === "pass" ? 0 : g.verdict === "fail" ? 1 : 2;
}

process.exit(main());
