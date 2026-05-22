/**
 * reconcile-kb-drive.ts — trash Google Drive files orphaned by KB deletes.
 *
 * deleteFile() trashes a row's Drive copy inline, but a bulk DB-side cleanup
 * (cleanup-jarvis-kb.ts) deliberately skips the Drive leg — 1,000+ rate-limited
 * API calls do not belong in that path. The result: drive_file_map rows whose
 * `path` no longer exists in jarvis_files. This script is that follow-up — it
 * trashes each orphaned Drive file and drops its map row.
 *
 *   npx tsx scripts/reconcile-kb-drive.ts            # dry run (default)
 *   npx tsx scripts/reconcile-kb-drive.ts --apply    # trash the orphans
 *
 * Needs Google OAuth env (run via the service EnvironmentFile). Resumable: a
 * map row is dropped only AFTER its Drive file is settled, so a re-run retries
 * exactly the failures. Drive "trash" is recoverable for 30 days.
 */

import { initDatabase, getDatabase, closeDatabase } from "../src/db/index.js";
import { googleFetch } from "../src/google/client.js";

const DB_PATH = process.env.MC_DB_PATH ?? "./data/mc.db";
const APPLY = process.argv.includes("--apply");
const CONCURRENCY = 5;

interface Orphan {
  path: string;
  drive_id: string;
}

/** Trash one Drive file. A 404 means it is already gone — treated as success. */
async function trashOne(o: Orphan): Promise<"trashed" | "gone"> {
  try {
    await googleFetch(
      `https://www.googleapis.com/drive/v3/files/${o.drive_id}`,
      {
        method: "PATCH",
        body: { trashed: true },
      },
    );
    return "trashed";
  } catch (err) {
    const msg = (
      err instanceof Error ? err.message : String(err)
    ).toLowerCase();
    if (msg.includes("404") || msg.includes("not found")) return "gone";
    throw err;
  }
}

async function main(): Promise<void> {
  initDatabase(DB_PATH);
  const db = getDatabase();

  const orphans = db
    .prepare(
      `SELECT path, drive_id FROM drive_file_map
        WHERE path NOT IN (SELECT path FROM jarvis_files)`,
    )
    .all() as Orphan[];

  console.log(`\n=== reconcile-kb-drive — ${APPLY ? "APPLY" : "DRY-RUN"} ===`);
  console.log(
    `Drive orphans (in drive_file_map, not in jarvis_files): ${orphans.length}`,
  );

  if (!APPLY) {
    for (const o of orphans.slice(0, 15)) console.log(`  TRASH  ${o.path}`);
    if (orphans.length > 15)
      console.log(`  ... and ${orphans.length - 15} more`);
    console.log(`\nDry run — no Drive calls made. Re-run with --apply.`);
    closeDatabase();
    return;
  }

  const dropRow = db.prepare("DELETE FROM drive_file_map WHERE path = ?");
  let trashed = 0;
  let gone = 0;
  let errored = 0;
  let done = 0;
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < orphans.length) {
      const o = orphans[cursor++];
      try {
        const r = await trashOne(o);
        if (r === "trashed") trashed++;
        else gone++;
        dropRow.run(o.path); // only after Drive is settled — keeps re-runs exact
      } catch (err) {
        errored++;
        console.warn(
          `  ERROR ${o.path}: ${err instanceof Error ? err.message : err}`,
        );
      }
      if (++done % 100 === 0) console.log(`  ... ${done}/${orphans.length}`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const remaining = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM drive_file_map
          WHERE path NOT IN (SELECT path FROM jarvis_files)`,
      )
      .get() as { n: number }
  ).n;

  console.log(
    `\n[done] trashed=${trashed}  already-gone=${gone}  errored=${errored}`,
  );
  console.log(
    `Drive orphans remaining: ${remaining}` +
      (remaining > 0
        ? "  — re-run --apply to retry the failures."
        : "  — clean."),
  );
  closeDatabase();
}

main().catch((err) => {
  console.error("[reconcile-kb-drive] FAILED:", err);
  process.exitCode = 1;
});
