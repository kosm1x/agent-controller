/**
 * Corpus replay: run the write-time expect validator over every task_gates
 * row in a LIVE ledger, read-only, and print what it would refuse.
 *
 *   npx tsx scripts/replay-gate-expects.ts [path/to/mc.db]
 *
 * Ships with the validator (2026-09-12) so the rule is checked against the
 * real corpus before and after any change to src/lib/v8-4/expect.ts:
 * an unexpected refusal means the RULE is wrong, not the row.
 */
import Database from "better-sqlite3";
import { isUnsettleableExpect } from "../src/lib/v8-4/expect.js";

const path = process.argv[2] ?? "data/mc.db";
const db = new Database(path, { readonly: true, fileMustExist: true });

interface Row {
  task_id: string;
  gate_id: string;
  source: string;
  state: string;
  check_cmd: string | null;
  expect: string | null;
  created_at: string;
}

const rows = db
  .prepare(
    `SELECT task_id, gate_id, source, state, check_cmd, expect, created_at
       FROM task_gates ORDER BY created_at`,
  )
  .all() as Row[];

const refused: Array<Row & { why: string }> = [];
const kept = new Map<string, number>();
let noExpect = 0;
for (const r of rows) {
  if (!r.expect || !r.expect.trim()) {
    noExpect++;
    continue;
  }
  const why = isUnsettleableExpect(r.expect);
  if (why) refused.push({ ...r, why });
  else kept.set(r.expect, (kept.get(r.expect) ?? 0) + 1);
}

console.log(`rows ${rows.length} · no expect ${noExpect} · kept ${rows.length - noExpect - refused.length} · would refuse ${refused.length}\n`);
console.log("WOULD REFUSE");
for (const r of refused) {
  console.log(
    `  ${r.created_at}  ${r.source.padEnd(7)} ${r.state.padEnd(9)} ${JSON.stringify(r.expect)}\n` +
      `      check: ${(r.check_cmd ?? "").slice(0, 90)}\n      why:   ${r.why.slice(0, 120)}`,
  );
}
console.log("\nKEPT (distinct expects)");
for (const [e, n] of [...kept.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(3)}  ${JSON.stringify(e)}`);
}
