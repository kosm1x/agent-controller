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

import { reformatDriveFiles } from "../src/db/drive-sync.js";

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
