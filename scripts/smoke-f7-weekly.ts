/**
 * Live smoke test: run F7 alpha_run on the seeded weekly data.
 * Usage: npx tsx scripts/smoke-f7-weekly.ts
 */

import { initDatabase } from "../src/db/index.js";
import { alphaRunTool } from "../src/tools/builtin/alpha.js";
import { requireOperatorContext } from "../src/lib/operator-gate.js";

// S6 item 3c: operator context only (login session or operator unit), before any db/KB side effect.
requireOperatorContext("smoke-f7-weekly", { tty: false });

async function main() {
  initDatabase("./data/mc.db");
  const out = (await alphaRunTool.execute({
    as_of: "2026-04-17",
  })) as string;
  console.log(out);
}

main().catch((err) => {
  console.error("[smoke] FATAL:", err);
  process.exit(1);
});
