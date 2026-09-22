/**
 * Jev shadow readout — bars 1–3, exactly as registered. Read-only, no vendor
 * call, no `--run`. Plan: docs/planning/jev-consumers-plan-2026-09-21.md
 * (bar 2: docs/planning/jev-consumer-2-memory-plan-2026-09-22.md).
 *
 *   npx tsx scripts/validate-jev-readout.ts [--labels <json>] [--show]
 *
 * Every bar is INCONCLUSIVE before 7 days and 150 decisions. `--show` prints
 * the bar-3 disagreement table (task ids and both labels, never text); the
 * operator labels it as `{"<task id>": "negative"|"rephrase"|"neutral"}` and
 * passes the file back with `--labels`. The bar-3 label threshold is frozen
 * in `FEEDBACK_THRESHOLD` — no flag, so a labelled table cannot be re-swept.
 */

import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bar1Kb,
  bar2Memory,
  bar3Feedback,
  FEEDBACK_THRESHOLD,
  READOUT_MIN_DAYS,
  READOUT_MIN_DECISIONS,
  type Gate,
  type HalfJudgement,
} from "../src/jev/readout.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const show = args.includes("--show");
const labelsPath = flag("--labels");
const labels: Record<string, string> = {};
if (labelsPath) {
  const parsed: unknown = JSON.parse(readFileSync(labelsPath, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("--labels must be a JSON object of task id → label");
  for (const [k, v] of Object.entries(parsed))
    if (typeof v === "string") labels[k] = v;
}

const db = new Database(join(ROOT, "data/mc.db"), {
  readonly: true,
  fileMustExist: true,
});
const now = new Date();
const kb = bar1Kb(db, now);
const memory = bar2Memory(db, now);
const feedback = bar3Feedback(db, now, FEEDBACK_THRESHOLD, labels);
db.close();

const pct = (x: number | null): string =>
  x === null ? "n/a" : `${(x * 100).toFixed(1)} %`;
const gateLine = (g: Gate): string =>
  `${g.days.toFixed(1)} days since ${g.firstRow ?? "no row"}, ${g.decisions} decisions ` +
  `(gate: ≥ ${READOUT_MIN_DAYS} days and ≥ ${READOUT_MIN_DECISIONS})`;
// `_cut` rows exist only since the harness deploy: earlier rows are unmarked.
const cutCaveat = "; rows before the _cut deploy unmarked";
const halfLine = (h: HalfJudgement | null): string =>
  h
    ? `used ${h.used} kept ${pct(h.usedKept)} · unused ${h.unused} dropped ${pct(h.unusedDropped)}`
    : "n/a";

console.log(`Jev shadow readout — ${now.toISOString()}\n`);

console.log(`Bar 1 — kb: ${kb.verdict}`);
console.log(`  ${gateLine(kb.gate)}`);
console.log(
  `  requests ${kb.requests} · withheld ${kb.withheld} · failed ${kb.failed} · no telemetry ${kb.noTelemetry} · no evidence ${kb.noEvidence} · rows missing today ${kb.rowsMissingToday}`,
);
console.log(
  `  evidence-positive rows ${kb.evidencePositive}: in budget by Jev order ${pct(kb.jevShare)} · by priority order ${pct(kb.priorityShare)} · live ${pct(kb.liveShare)} · decisions at the 500-char cut ${kb.cut}${cutCaveat}`,
);
console.log(`  PASS needs Jev ≥ 90 % and ≥ 15 points over priority order\n`);

console.log(`Bar 2 — memory: ${memory.verdict}`);
console.log(`  ${gateLine(memory.gate)}`);
console.log(
  `  requests ${memory.requests} · withheld ${memory.withheld} · failed ${memory.failed} · no items ${memory.noItems} · unclaimed ${memory.unclaimed} · fan-out dropped ${memory.fanOut} · scoreable recalls ${memory.recalls} (${memory.cut} at the 500-char cut${cutCaveat})`,
);
console.log(
  `  threshold ${memory.threshold ?? "n/a"} (first half): ${halfLine(memory.firstHalf)}`,
);
console.log(`  second half: ${halfLine(memory.secondHalf)}`);
console.log(
  `  PASS needs second half: used kept ≥ 90 % and unused dropped ≥ 40 %\n`,
);

console.log(`Bar 3 — feedback: ${feedback.verdict}`);
console.log(`  ${gateLine(feedback.gate)}`);
console.log(
  `  requests ${feedback.requests} · withheld ${feedback.withheld} · failed ${feedback.failed} · partial ${feedback.partial} · positive incumbent (not comparable) ${feedback.positiveIncumbent}`,
);
console.log(
  `  disagreements at threshold ${FEEDBACK_THRESHOLD}: ${feedback.disagreements.length} (${feedback.disagreements.filter((d) => d.atCut).length} at the 500-char cut${cutCaveat}) · labelled ${feedback.labelled} (${feedback.unknownLabels} unrecognised, ${feedback.unmatchedLabels} matched no disagreement) · Jev right ${pct(feedback.right)} · corrections ${feedback.corrections} at precision ${pct(feedback.precision)}`,
);
console.log(
  `  PASS needs Jev right ≥ 70 % and ≥ 20 labelled corrections at precision ≥ 80 %`,
);
if (show && feedback.disagreements.length > 0) {
  console.log(
    `\n  task id                               created (UTC)        correction restatement jev       regex     label`,
  );
  for (const d of feedback.disagreements)
    console.log(
      `  ${d.ref} ${d.createdAt}  ${d.correction.toFixed(2)}       ${d.restatement.toFixed(2)}        ${d.jev.padEnd(9)} ${d.incumbent.padEnd(9)} ${d.label ?? "-"}${d.atCut ? "  (at cut)" : ""}`,
    );
}
