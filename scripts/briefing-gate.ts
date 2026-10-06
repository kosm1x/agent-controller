/**
 * mc-ctl briefing-gate — V8.1 §13 + V8.2 §17 activation-gate report.
 *
 * Invoked by `mc-ctl briefing-gate`. Evaluates BOTH activation gates — the V8.1
 * §13 gate (five Morning Sync checks since 2026-10-06; the cache-read ratio and
 * morning-brief promote-rate print as unscored information) and the V8.2 §17 gate (shadow volume, citation resolver,
 * critic-unfixable, sycophancy) — and prints one operator-readable
 * report. Read-only — no writes. Both the printed Combined verdict and the exit
 * code are TRUE worst-of-two: exit 0 means BOTH layers are activatable. (This
 * said "EITHER layer" until 2026-08-02, describing the `||`-pass exception that
 * §17 check 6a's removal invalidated — see `combineVerdicts`.)
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initDatabase } from "../src/db/index.js";
import {
  evaluateActivationGate,
  GATE_COLD_START_AGENT_TYPES,
  GATE_MS_WINDOW_DAYS,
} from "../src/briefing/activation-gate.js";
import {
  evaluateV82Gate,
  combineVerdicts,
  COMBINED_VERDICT_LABEL,
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
  // NOT "shadow run still accumulating" — §13 has been ACTIVE since V8.1. And
  // NOT a named cause: §13 v2 has several terms that can be unmeasurable, so
  // naming one would guess. The per-check `…` lines below say which.
  insufficient_data:
    "⏳ INSUFFICIENT DATA — a §13 term is not measurable (see … below)",
} as const;

function main(): number {
  initDatabase(DB_PATH);
  const g = evaluateActivationGate();

  console.log("=== V8.1 §13 Activation Gate ===\n");
  console.log(VERDICT_LABEL[g.verdict]);
  console.log("");

  // Scored terms (§13 v2, operator ruling 2026-10-06): the Morning Sync itself.
  const mark = (status: string): string =>
    status === "pass" ? "✓" : status === "fail" ? "✗" : "…";
  console.log(
    `Morning Sync (scored; ${g.morningSync.runs} run(s) in the last ${GATE_MS_WINDOW_DAYS} MX days):`,
  );
  for (const [label, chk] of Object.entries(g.checks)) {
    console.log(`  ${mark(chk.status)} ${label}: ${chk.detail}`);
  }
  const ft = g.morningSync.firstTurn;
  console.log(
    ft.cacheReadPct === null
      ? "  ℹ first-turn cache-read share: not recorded yet — not scored"
      : `  ℹ first-turn cache-read share: ${ft.cacheReadPct}% over ${ft.runsWithAttrs} run(s), ` +
          `cache_creation ${ft.cacheCreationTokens} tokens — not scored (threshold after 7 days of data)`,
  );
  console.log("");

  console.log(
    "Cache-read ratio (cacheable inference, last 24h) — information: tracks run length; not scored (ruled 2026-10-06):",
  );
  console.log(`  ℹ ${g.legacy.cacheRead.detail}`);
  console.log(
    `  cacheable runs: ${g.cacheableRuns}   cacheable cost: $${g.cacheableCostUsd}`,
  );
  // Non-gating: keeps the cold-start exclusion auditable rather than invisible.
  if (g.excludedColdStart.runs > 0) {
    const { runs, cacheReadPct, costUsd } = g.excludedColdStart;
    console.log(
      `  ℹ excluded cold-start (${GATE_COLD_START_AGENT_TYPES.join(", ")}): ` +
        `${runs} run(s), cache-read ${cacheReadPct ?? "n/a"}%, cost $${costUsd} — not scored`,
    );
  }
  console.log("");

  console.log("Morning briefing promote-rate (last 7d):");
  console.log(
    `  ${g.legacy.promoteRate.pass ? "✓" : "✗"} ${g.legacy.promoteRate.detail}`,
  );
  console.log("");

  if (g.briefingHealth.length > 0) {
    console.log("Briefing health by surface (last 7d):");
    for (const h of g.briefingHealth) {
      console.log(
        // "of ruled" is load-bearing: the denominator is `promoted + discarded`,
        // NOT `generated` (expired/pending carry no verdict). Without the label a
        // reader comparing against historical output would misread the %.
        `  ${h.surface}: ${h.generated} generated · ${h.promoted} promoted · ` +
          `${h.discarded} discarded · ${h.expired} expired · ${h.pending} pending ` +
          `· ${h.promoteRatePct}% promote-rate (of ${h.ruled} ruled)`,
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

  // Combined verdict (worst-of-two) so one invocation reflects both layers.
  // 0 = both gates met; 1 = a threshold failed in either; 2 = a gate is not
  // measurable (a thin §13 Morning Sync sample, or a thin §17 window).
  //
  // PRINTED, not just returned (audit R2 C1): a per-gate render alone ends the
  // terminal on §17's line, so a §13 `insufficient_data` under a passing §17
  // showed a green last line while exiting 2. Nothing automated reads the exit
  // code, so the render IS the consumer — if it isn't on screen, it isn't
  // reported.
  const combined = combineVerdicts(g.verdict, g2.verdict);
  console.log(`\n=== Combined ===\n\n${COMBINED_VERDICT_LABEL[combined]}`);
  return combined === "pass" ? 0 : combined === "fail" ? 1 : 2;
}

process.exit(main());
