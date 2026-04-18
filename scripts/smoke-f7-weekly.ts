/**
 * Live smoke test: run F7 alpha_run on the seeded weekly data.
 * Usage: npx tsx scripts/smoke-f7-weekly.ts
 */

import { initDatabase } from "../src/db/index.js";
import { alphaRunTool } from "../src/tools/builtin/alpha.js";

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
