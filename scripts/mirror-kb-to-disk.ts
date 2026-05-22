/**
 * mirror-kb-to-disk.ts — restore the FS mirror for jarvis_files rows whose
 * disk file is missing.
 *
 * The hourly kb-reindex ritual only repairs FS->DB drift (files on disk that
 * are missing from the table). The DB->FS direction has no repair: when an
 * `upsertFile()` mirror write fails, the row lives on with no disk file and
 * stays invisible in Obsidian indefinitely. This script is that missing leg —
 * it walks jarvis_files and writes any row whose mirror file is absent.
 *
 *   npx tsx scripts/mirror-kb-to-disk.ts            # dry run (default)
 *   npx tsx scripts/mirror-kb-to-disk.ts --apply    # write the missing files
 *
 * Read-only on the DB; only writes files under the KB mirror root. Rows with
 * a malformed path (absolute, or containing `..`) are reported, not written —
 * mirroring them would recreate junk dirs outside the canonical hierarchy.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { initDatabase, getDatabase, closeDatabase } from "../src/db/index.js";
import { mirrorToDisk } from "../src/db/jarvis-fs.js";

const KB_ROOT = process.env.JARVIS_KB_MIRROR_DIR ?? "/root/claude/jarvis-kb";
const DB_PATH = process.env.MC_DB_PATH ?? "./data/mc.db";
const APPLY = process.argv.includes("--apply");

function malformed(path: string): boolean {
  return path.startsWith("/") || path.split("/").includes("..");
}

function main(): void {
  initDatabase(DB_PATH);
  const rows = getDatabase()
    .prepare("SELECT path, content FROM jarvis_files")
    .all() as Array<{ path: string; content: string }>;

  const missing: Array<{ path: string; content: string }> = [];
  const skipped: string[] = [];
  for (const r of rows) {
    if (malformed(r.path)) {
      if (!existsSync(join(KB_ROOT, r.path))) skipped.push(r.path);
      continue;
    }
    if (!existsSync(join(KB_ROOT, r.path))) missing.push(r);
  }

  console.log(`\n=== mirror-kb-to-disk — ${APPLY ? "APPLY" : "DRY-RUN"} ===`);
  console.log(`DB rows: ${rows.length}   missing on disk: ${missing.length}`);
  for (const m of missing) console.log(`  WRITE  ${m.path}`);
  if (skipped.length) {
    console.log(
      `\nSkipped ${skipped.length} malformed-path row(s) — fix the path in-DB, do not mirror:`,
    );
    for (const s of skipped) console.log(`  SKIP   ${s}`);
  }

  if (!APPLY) {
    console.log(`\nDry run — no files written. Re-run with --apply.`);
    closeDatabase();
    return;
  }

  let written = 0;
  for (const m of missing) {
    mirrorToDisk(m.path, m.content);
    if (existsSync(join(KB_ROOT, m.path))) written++;
    else console.warn(`  FAILED  ${m.path}`);
  }
  console.log(`\n[done] ${written}/${missing.length} mirror files written.`);
  closeDatabase();
}

main();
