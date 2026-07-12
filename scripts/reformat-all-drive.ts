/**
 * Reformat all existing Drive files with the updated Obsidian-native content.
 *
 * Run after changing toObsidianContent to push new frontmatter + wikilinks
 * to all files already in Drive (those with a drive_id in drive_file_map).
 *
 * Usage:
 *   npx tsx scripts/reformat-all-drive.ts
 *
 * Progress is written to /tmp/reformat-drive-progress.log
 * Run `tail -f /tmp/reformat-drive-progress.log` in another terminal to watch.
 */

import { copyFileSync, existsSync, mkdtempSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { initDatabase } from "../src/db/index.js";
import { reformatDriveFiles } from "../src/db/drive-sync.js";

// Standalone-harness bootstrap per the CLAUDE.md validate-harness doctrine
// (audit W3 fold 2026-07-12): initDatabase is a WRITE path (WAL pragma +
// schema probes) — never point it at the live mc.db while the service runs.
// This pass only READS SQLite (writes go to Drive), so a snapshot is exact.
// Paths resolve from the repo root, not cwd — a cwd-relative default
// silently created a fresh empty DB and reported success doing nothing.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LIVE_DB = process.env.MC_DB_PATH ?? join(ROOT, "data", "mc.db");
if (!existsSync(LIVE_DB)) {
  console.error(`FATAL: DB not found at ${LIVE_DB}`);
  process.exit(1);
}
loadConfig();
const snapDir = mkdtempSync(join(tmpdir(), "reformat-drive-"));
for (const suffix of ["", "-wal", "-shm"]) {
  if (existsSync(LIVE_DB + suffix)) {
    copyFileSync(LIVE_DB + suffix, join(snapDir, `mc.db${suffix}`));
    chmodSync(join(snapDir, `mc.db${suffix}`), 0o600);
  }
}
initDatabase(join(snapDir, "mc.db"));

const LOG_FILE = "/tmp/reformat-drive-progress.log";

function log(msg: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  process.stdout.write(line);
  // Append to log file
  import("node:fs").then(({ appendFileSync }) => {
    try {
      appendFileSync(LOG_FILE, line);
    } catch {
      // ignore
    }
  });
}

async function main(): Promise<void> {
  log("=== reformat-all-drive START ===");
  log(`Log file: ${LOG_FILE}`);

  const { updated, skipped, failed } = await reformatDriveFiles();

  log(`=== reformat-all-drive DONE ===`);
  log(`  updated : ${updated}`);
  log(`  skipped : ${skipped}  (no drive_id — not yet in Drive)`);
  log(`  failed  : ${failed}`);

  if (failed > 0) {
    log("WARNING: some files failed — check console output above for details");
    process.exit(1);
  }
}

main().catch((err) => {
  log(`FATAL: ${String(err)}`);
  process.exit(1);
});
