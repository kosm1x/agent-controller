/**
 * mc-ctl v83-gate — V8.3 §14 v1 activation-gate report.
 *
 * Invoked by `mc-ctl v83-gate`. Evaluates the six §14 v1 queries over the decision
 * ledger (schema, V8.2 dependency, seeded capabilities, 7-day shadow volume,
 * judgment-linkage integrity, reversibility coverage) and prints one
 * operator-readable report. Read-only — no writes. It measures readiness for the
 * operator's FIRST L1→L2 promotion; it does not promote anything, and L≥3
 * additionally requires the V8.2 §17 gate (`mc-ctl briefing-gate`) to pass.
 *
 * Exit: 0 = pass, 1 = fail (a substrate/invariant check failed), 2 = still
 * accumulating shadow (the expected state during the 7-day shadow run).
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initDatabase } from "../src/db/index.js";
import {
  evaluateV83Gate,
  type V83GateCheck,
} from "../src/lib/v8-3/activation-gate.js";

const DB_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "data",
  "mc.db",
);

const LABEL = {
  pass: "✅ PASS — V8.3 §14 v1 activation gate met (substrate healthy, shadow sufficient)",
  fail: "❌ FAIL — a §14 substrate/invariant check failed",
  insufficient_data: "⏳ INSUFFICIENT DATA — 7-day shadow still accumulating",
} as const;

function main(): number {
  initDatabase(DB_PATH);
  const g = evaluateV83Gate();

  console.log("=== V8.3 §14 v1 Activation Gate ===\n");
  console.log(LABEL[g.verdict]);
  console.log("");

  const c = g.checks;
  const line = (label: string, chk: V83GateCheck): void =>
    console.log(`  ${chk.pass ? "✓" : "✗"} ${label}: ${chk.detail}`);
  line("schema", c.schema);
  line("v8.2 dependency", c.v82Dependency);
  line("seeded capabilities", c.seeded);
  line("shadow volume", c.shadowVolume);
  line("linkage integrity", c.linkageIntegrity);
  line("reversibility coverage", c.reversibilityCoverage);

  console.log("");
  console.log(
    "Note: pass = ready for the operator's first L1→L2 promotion. It promotes",
  );
  console.log(
    "nothing itself, and L≥3 autonomy additionally requires V8.2 §17 (mc-ctl briefing-gate).",
  );

  return g.verdict === "pass" ? 0 : g.verdict === "fail" ? 1 : 2;
}

process.exit(main());
