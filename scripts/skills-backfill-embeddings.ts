/**
 * Phase 3 operator-triggered embedding backfill.
 *
 * Invoked by `mc-ctl skills backfill-embeddings [--limit=N] [--sleep-ms=N]`.
 * Env-driven so the bash wrapper can stay tsx-resolver-agnostic.
 *
 *   LIMIT=N      cap on rows processed this run
 *   SLEEP_MS=N   ms between embed calls (operator API throttle)
 *
 * Exit codes:
 *   0 — all candidates embedded OR none considered
 *   1 — partial success (some rows skipped or errored)
 *   2 — fatal (unhandled throw)
 */

import { initDatabase } from "../src/db/index.js";
import { backfillSkillEmbeddings } from "../src/skills/backfill-embeddings.js";

async function main(): Promise<number> {
  initDatabase("./data/mc.db");
  const limitRaw = process.env.LIMIT;
  const sleepRaw = process.env.SLEEP_MS;
  const limit =
    limitRaw && limitRaw.length > 0 && Number.isFinite(parseInt(limitRaw, 10))
      ? parseInt(limitRaw, 10)
      : undefined;
  const sleepMs =
    sleepRaw && sleepRaw.length > 0 && Number.isFinite(parseInt(sleepRaw, 10))
      ? parseInt(sleepRaw, 10)
      : undefined;

  const result = await backfillSkillEmbeddings({ limit, sleepMs });
  console.log(JSON.stringify(result, null, 2));
  return result.errors.length > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(2);
  });
