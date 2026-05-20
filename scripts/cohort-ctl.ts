/**
 * v7.7 Spine 5 Bundle 2 — self-defining cohort operator helper.
 *
 * Backs `mc-ctl cohort rollup` (the write path — runs the deterministic
 * roll-up through the TS engine so all invariants hold). The thin bash
 * front-end handles `list`/`show` directly via SQLite.
 *
 * Env: MODE=rollup (required).
 *
 * Exit codes: 0 ok | 1 roll-up failed | 2 bad MODE.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCohortRollup } from "../src/cohort/rollup-cron.js";
import { initDatabase } from "../src/db/index.js";

// Resolve the DB path relative to THIS script, not the process cwd.
const DB_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "data",
  "mc.db",
);

function main(): number {
  const mode = (process.env.MODE ?? "").toLowerCase();
  if (mode !== "rollup") {
    console.error(`[cohort-ctl] MODE must be rollup (got "${mode}")`);
    return 2;
  }
  initDatabase(DB_PATH);
  const result = runCohortRollup();
  if (!result) {
    console.error("[cohort-ctl] roll-up failed — see logs above");
    return 1;
  }
  console.log(
    `[cohort-ctl] roll-up complete — ${result.candidates} candidate(s), ` +
      `${result.cohort_size} active, ${result.inactive} inactive`,
  );
  for (const [kind, n] of Object.entries(result.by_kind)) {
    console.log(`  ${kind.padEnd(12)} ${n}`);
  }
  return 0;
}

process.exit(main());
