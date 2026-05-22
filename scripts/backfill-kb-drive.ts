/**
 * backfill-kb-drive.ts — upload jarvis_files rows that have no Drive copy.
 *
 * Wraps backfillToDrive(): idempotent — rows already in drive_file_map are
 * skipped, only unmapped rows are uploaded. Run this after a bulk move or
 * cleanup to restore the Drive mirror, since moveFile() does not re-sync Drive
 * and cleanup-jarvis-kb.ts deliberately skips the Drive leg.
 *
 *   npx tsx scripts/backfill-kb-drive.ts
 *
 * Needs Google OAuth env — run via the service EnvironmentFile.
 */
import { initDatabase, closeDatabase } from "../src/db/index.js";
import { backfillToDrive } from "../src/db/drive-sync.js";

initDatabase(process.env.MC_DB_PATH ?? "./data/mc.db");
const r = await backfillToDrive();
console.log(
  `[backfill-kb-drive] uploaded=${r.uploaded} skipped=${r.skipped} failed=${r.failed}`,
);
closeDatabase();
