/**
 * Jev consumer 1, Phase 0 — how often do conditional KB rows overflow their
 * budget, and which rows lose? Plan: docs/planning/jev-consumers-plan-2026-09-21.md.
 *
 * Free and read-only: replays the last 30 days of `scope_telemetry.tools_in_scope`
 * through the production packer against TODAY's `jarvis_files` rows (no row
 * history exists, so past edits are not reflected). No vendor call, no `--run`.
 *
 *   npx tsx scripts/validate-jev-kb.ts [--show]
 *
 * Registered reading: under 5 % of turns with a pointer-only row = consumer 1
 * has no problem to solve.
 */

import Database from "better-sqlite3";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  packConditionalRows,
  type ConditionalRow,
} from "../src/messaging/kb-injection.js";

import { KB_SHADOW_ROWS } from "../src/jev/shadow-kb.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WINDOW_DAYS = 30;

const db = new Database(join(ROOT, "data/mc.db"), {
  readonly: true,
  fileMustExist: true,
});

const rows = db
  .prepare(
    `SELECT path, title, content, condition FROM jarvis_files
     WHERE qualifier = 'conditional' ORDER BY priority ASC, created_at ASC`,
  )
  .all() as ConditionalRow[];

const turns = db
  .prepare(
    `SELECT tools_in_scope FROM scope_telemetry
     WHERE created_at >= datetime('now', ?) AND tools_in_scope IS NOT NULL
       AND tools_in_scope NOT IN ('', '[]')`,
  )
  .all(`-${WINDOW_DAYS} days`) as Array<{ tools_in_scope: string }>;
db.close();

const applied = new Map<string, number>();
const lost = new Map<string, number>();
let overflowed = 0;
let scored = 0;
for (const t of turns) {
  let tools: unknown;
  try {
    tools = JSON.parse(t.tools_in_scope);
  } catch {
    continue;
  }
  if (!Array.isArray(tools)) continue;
  scored++;
  const packed = packConditionalRows(rows, tools as string[]);
  if (packed.pointer.length > 0) overflowed++;
  for (const f of [...packed.inBudget, ...packed.pointer])
    applied.set(f.path, (applied.get(f.path) ?? 0) + 1);
  for (const f of packed.pointer) lost.set(f.path, (lost.get(f.path) ?? 0) + 1);
}

const pct = (n: number, d: number) =>
  d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)} %`;

console.log(
  `Conditional rows: ${rows.length} · turns with a scope, last ${WINDOW_DAYS} d: ${scored}`,
);
console.log(
  `Turns where at least one applicable row became a pointer: ${overflowed} (${pct(overflowed, scored)})`,
);
console.log("\nrow · applied on turns · pointer-only on turns");
for (const f of rows) {
  const a = applied.get(f.path) ?? 0;
  const l = lost.get(f.path) ?? 0;
  console.log(`  ${f.path} · ${a} · ${l} (${pct(l, a)})`);
}
const sent = rows.filter((f) => Object.hasOwn(KB_SHADOW_ROWS, f.path));
// `--show`: the exact text arming `kb` sends about each row — the committed
// description, never the row's own content.
if (process.argv.includes("--show")) {
  console.log("\nWhat leaves the box per row when `kb` is armed:");
  for (const f of sent)
    console.log(`\n[${f.path}]\n${KB_SHADOW_ROWS[f.path].describes}`);
}
console.log(
  `\nRows with no registered entry (never sent): ${rows.length - sent.length}`,
);
for (const f of rows) if (!sent.includes(f)) console.log(`  ${f.path}`);
const missing = Object.keys(KB_SHADOW_ROWS).filter(
  (path) => !rows.some((f) => f.path === path),
);
console.log(`Registered rows missing from the KB today: ${missing.length}`);
for (const path of missing) console.log(`  ${path}`);
console.log(
  overflowed / Math.max(scored, 1) < 0.05
    ? "\nREADING: under 5 % of turns overflow — consumer 1 has no problem to solve."
    : "\nREADING: the budget overflows often enough for row order to matter.",
);
