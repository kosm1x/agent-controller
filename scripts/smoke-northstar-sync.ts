/**
 * Live smoke test: invoke northstar_sync against the real COMMIT DB.
 * Usage: npx tsx scripts/smoke-northstar-sync.ts
 */

import { initDatabase, getDatabase } from "../src/db/index.js";
import { northstarSyncTool } from "../src/tools/builtin/northstar-sync.js";
import { readFileSync } from "node:fs";

// Load .env manually (no dotenv dep in this project)
try {
  const env = readFileSync("./.env", "utf-8");
  for (const line of env.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {
  /* ignore */
}

async function main() {
  initDatabase("./data/mc.db");

  const before = getDatabase()
    .prepare("SELECT COUNT(*) as c FROM northstar_sync_state")
    .get() as { c: number };
  console.log(`[smoke] journal rows before: ${before.c}`);

  console.log("[smoke] running sync…");
  const out = (await northstarSyncTool.execute({})) as string;
  console.log(out);

  const after = getDatabase()
    .prepare(
      "SELECT kind, COUNT(*) as c FROM northstar_sync_state GROUP BY kind",
    )
    .all() as Array<{ kind: string; c: number }>;
  console.log("[smoke] journal rows after:", after);
}

main().catch((err) => {
  console.error("[smoke] FATAL:", err);
  process.exit(1);
});
