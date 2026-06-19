/**
 * mc-ctl briefing-gate — V8.1 §13 + V8.2 §17 activation-gate report.
 *
 * Invoked by `mc-ctl briefing-gate`. Evaluates BOTH activation gates — the V8.1
 * §13 gate (cache-read ratio over cacheable inference + morning-brief
 * promote-rate) and the V8.2 §17 gate (shadow volume, citation resolver,
 * critic-unfixable, sycophancy, acceptance) — and prints one operator-readable
 * report. Read-only — no writes. The exit code is the worst-of-two so a single
 * `mc-ctl briefing-gate` reflects whether EITHER layer is activatable.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initDatabase } from "../src/db/index.js";
import { evaluateActivationGate } from "../src/briefing/activation-gate.js";
import {
  evaluateV82Gate,
  combineVerdicts,
} from "../src/briefing/v82-activation-gate.js";

const V82_VERDICT_LABEL = {
  pass: "✅ PASS — V8.2 §17 activation gate met",
  fail: "❌ FAIL — below a §17 threshold",
  insufficient_data: "⏳ INSUFFICIENT DATA — shadow run still accumulating",
} as const;

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

  // ── V8.2 §17 activation gate ────────────────────────────────────────────────
  const g2 = evaluateV82Gate();
  console.log("\n=== V8.2 §17 Activation Gate ===\n");
  console.log(V82_VERDICT_LABEL[g2.verdict]);
  console.log("");
  const c = g2.checks;
  const line = (label: string, chk: { pass: boolean; detail: string }): void =>
    console.log(`  ${chk.pass ? "✓" : "✗"} ${label}: ${chk.detail}`);
  line("schema", c.schema);
  line("shadow volume", c.volume);
  line("citation resolver", c.resolver);
  line("critic unfixable", c.unfixable);
  line("sycophancy", c.sycophancy);
  line("acceptance (6a)", c.acceptance);

  // Combined exit code (worst-of-two) so one invocation reflects both layers.
  // 0 = both gates met; 1 = a threshold failed in either; 2 = still
  // accumulating (the expected state while V8.2 is in its 7-day shadow).
  const combined = combineVerdicts(g.verdict, g2.verdict);
  return combined === "pass" ? 0 : combined === "fail" ? 1 : 2;
}

process.exit(main());
