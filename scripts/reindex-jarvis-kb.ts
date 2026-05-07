/**
 * Reindex jarvis_files table from the FS mirror at /root/claude/jarvis-kb/.
 *
 * Architecture: SQLite is source of truth, FS is a mirror. External writers
 * (shell_exec, manual edits, batch migrations) can drop files into the FS
 * that bypass `upsertFile()` and stay invisible to Jarvis's tools. This
 * script walks the FS, finds .md files missing from the DB, and upserts
 * them so the DB regains parity with disk.
 *
 * Usage:
 *   npx tsx scripts/reindex-jarvis-kb.ts            # dry run (default)
 *   npx tsx scripts/reindex-jarvis-kb.ts --apply    # actually upsert
 *
 * The hourly ritual at src/rituals/scheduler.ts#scheduleKbReindex runs the
 * same code automatically — this script is for one-off / verification use.
 */

import { initDatabase, closeDatabase, getDatabase } from "../src/db/index.js";
import { reindexJarvisKb, walkKbDir } from "../src/db/jarvis-reindex.js";
import { relative } from "node:path";

const KB_ROOT = process.env.JARVIS_KB_MIRROR_DIR ?? "/root/claude/jarvis-kb";
const DB_PATH = process.env.MC_DB_PATH ?? "./data/mc.db";

function dryRun() {
  initDatabase(DB_PATH);
  const fsFiles = walkKbDir(KB_ROOT);
  const fsRel = new Set(fsFiles.map((f) => relative(KB_ROOT, f)));
  const db = getDatabase();
  const dbPaths = new Set(
    (
      db.prepare("SELECT path FROM jarvis_files").all() as Array<{
        path: string;
      }>
    ).map((r) => r.path),
  );
  const fsOnly = [...fsRel].filter((p) => !dbPaths.has(p));
  console.log(
    `[reindex] FS=${fsRel.size} DB=${dbPaths.size} fs-only=${fsOnly.length} mode=DRY-RUN`,
  );
  if (fsOnly.length > 0) {
    const byDir = new Map<string, number>();
    for (const p of fsOnly) {
      const top = p.split("/")[0];
      byDir.set(top, (byDir.get(top) ?? 0) + 1);
    }
    for (const [dir, n] of [...byDir.entries()].sort(([, a], [, b]) => b - a)) {
      console.log(`  ${dir.padEnd(15)} ${n}`);
    }
    console.log("\n[reindex] dry run — pass --apply to upsert");
  } else {
    console.log("[reindex] no drift — DB and FS in sync");
  }
  closeDatabase();
}

function apply() {
  initDatabase(DB_PATH);
  const result = reindexJarvisKb({ kbRoot: KB_ROOT });
  console.log(
    `[reindex] FS=${result.fsCount} DB=${result.dbCount} drift=${result.drift} upserted=${result.upserted} errored=${result.errored} (${result.durationMs}ms) mode=APPLY`,
  );
  closeDatabase();
}

const shouldApply = process.argv.includes("--apply");
if (shouldApply) apply();
else dryRun();
