/**
 * list-drive-index-copies.ts — list every Drive file with a given name (default
 * INDEX.md) so duplicate copies of a KB file can be found by hand.
 *
 * OPERATOR-ONLY, READ-ONLY. Lists files named <basename> anywhere in the
 * operator's Drive (not trashed), with created/modified time, size, the parent
 * folder path resolved up to the KB root folder (DRIVE_KB_FOLDER_ID) or the
 * marker OUTSIDE KB FOLDER, and whether the file id is the one recorded in
 * drive_file_map (and for which path). Makes only Drive GET calls and opens
 * data/mc.db read-only; it never deletes, trashes or edits anything.
 *
 *   npx tsx scripts/list-drive-index-copies.ts [--name=INDEX.md]
 *
 * Needs Google OAuth env + DRIVE_KB_FOLDER_ID — run via the service
 * EnvironmentFile.
 */

import Database from "better-sqlite3";
import { googleFetch } from "../src/google/client.js";
import { requireOperatorContext } from "../src/lib/operator-gate.js";
import { driveLookup, OUTSIDE } from "./lib/drive-index-lookup.js";

// S6 item 3c: operator context only (login session or operator unit), before any db/Drive call.
requireOperatorContext("list-drive-index-copies", { tty: false });

const DB_PATH = process.env.MC_DB_PATH ?? "./data/mc.db";
const ROOT_FOLDER_ID = process.env.DRIVE_KB_FOLDER_ID ?? "";
const NAME =
  process.argv.find((a) => a.startsWith("--name="))?.slice("--name=".length) ??
  "INDEX.md";
const { kbLocation, listByName } = driveLookup(googleFetch, ROOT_FOLDER_ID);

async function main(): Promise<void> {
  if (!ROOT_FOLDER_ID) {
    console.error("[list-drive-index-copies] DRIVE_KB_FOLDER_ID is empty; refusing to run.");
    process.exit(1);
  }
  if (!NAME) {
    console.error("[list-drive-index-copies] --name= needs a file name.");
    process.exit(1);
  }

  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  const mapped = db.prepare("SELECT path FROM drive_file_map WHERE drive_id = ?");

  const { files } = await listByName(NAME);
  files.sort((a, b) => (a.createdTime ?? "").localeCompare(b.createdTime ?? ""));

  const rows: string[][] = [];
  let inside = 0;
  let unknown = 0;
  let inMap = 0;
  for (const f of files) {
    const location = await kbLocation(f.parents);
    if (location.startsWith("UNKNOWN")) unknown++;
    else if (location !== OUTSIDE) inside++;
    const row = mapped.get(f.id) as { path: string } | undefined;
    if (row) inMap++;
    rows.push([
      f.createdTime ?? "-",
      f.modifiedTime ?? "-",
      f.size ?? "-",
      f.id,
      location,
      row ? `yes (${row.path})` : "no",
    ]);
  }
  db.close();

  const header = ["created", "modified", "size", "id", "location", "in drive_file_map"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const fmt = (r: string[]): string => r.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  console.log(`\n=== Drive files named ${NAME} (read-only) ===`);
  console.log(fmt(header));
  console.log(fmt(widths.map((w) => "-".repeat(w))));
  for (const r of rows) console.log(fmt(r));
  console.log(
    `\nTotal: ${files.length} file(s) named ${NAME}; ${inside} inside the KB folder; ${unknown} UNKNOWN (lookup failed); ${inMap} recorded in drive_file_map.`,
  );
}

main().catch((err) => {
  console.error("[list-drive-index-copies] FAILED:", err);
  process.exitCode = 1;
});
