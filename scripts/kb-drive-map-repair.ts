/**
 * Map an existing Drive file to its KB path when the drive_file_map row is missing.
 *
 * A Drive CREATE (syncToDrive in src/db/drive-sync.ts) records the new file id only
 * after the upload; a process that closed its db first (2026-10-20 00:27 UTC,
 * directives/denue-access-card.md) left the Drive file unmapped, and the next upsert
 * of that path would create a duplicate. This tool finds the file read-only (it never
 * creates a folder, uploads, trashes or deletes anything on Drive) and, with --apply
 * and exactly one candidate, records it through recordDriveId. Run it with the
 * service env (DRIVE_KB_FOLDER_ID + Google credentials) against the live db.
 *
 * Usage:
 *   npx tsx scripts/kb-drive-map-repair.ts --path <kb rel path>           # dry run (default)
 *   npx tsx scripts/kb-drive-map-repair.ts --path <kb rel path> --apply   # write the map row + verify
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { initDatabase, closeDatabase } from "../src/db/index.js";
import { getFile } from "../src/db/jarvis-fs.js";
import { findFolder, getDriveMapEntry, isDriveSyncEnabled, recordDriveId } from "../src/db/drive-sync.js";
import { isLiveDatabaseFile, LIVE_DB_PATH, openDbFile } from "../src/db/live-db.js";
import { googleFetch } from "../src/google/client.js";
import { escapeDriveQueryValue } from "../src/google/drive-query.js";
import { requireOperatorContext } from "../src/lib/operator-gate.js";
import { errMsg } from "../src/lib/err-msg.js";

type Candidate = { id: string; name: string; createdTime: string };

/** Why this path cannot be repaired here, or null. Reads sqlite only. */
function refusal(path: string): string | null {
  if (!isDriveSyncEnabled()) return "Drive sync not enabled (DRIVE_KB_FOLDER_ID unset)";
  if (!isLiveDatabaseFile(openDbFile(), LIVE_DB_PATH)) return `open db is not the live ${LIVE_DB_PATH}`;
  if (!getFile(path)) return "no registry row in jarvis_files";
  const mapped = getDriveMapEntry(path);
  if (mapped) return `already in drive_file_map (updated_at=${mapped.updatedAt ?? "null"})`;
  return null;
}

export async function runRepair(opts: { path: string; apply: boolean }): Promise<{ ok: boolean }> {
  const { path, apply } = opts;
  const refused = refusal(path);
  if (refused) {
    console.log(`FAIL ${path} ${refused}`);
    return { ok: false };
  }
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? path.slice(0, slash) : "";
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  let candidates: Candidate[] = [];
  try {
    const parentId = await findFolder(dir);
    if (parentId) {
      const query = `name='${escapeDriveQueryValue(name)}' and '${escapeDriveQueryValue(parentId)}' in parents and mimeType='text/markdown' and trashed=false`;
      const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,createdTime)&orderBy=createdTime&pageSize=100`;
      candidates = (await googleFetch<{ files: Candidate[] }>(url)).files ?? [];
    } else console.log(`  folder "${dir}" not found on Drive`);
  } catch (err) {
    console.log(`FAIL ${path} Drive search failed: ${errMsg(err)}`);
    return { ok: false };
  }
  console.log(`  candidates=${candidates.length}`);
  for (const c of candidates) console.log(`  candidate id=${c.id} createdTime=${c.createdTime}`);
  if (candidates.length === 0) {
    console.log(
      `FAIL ${path} no Drive file to map; nothing written. The search only sees files with mimeType='text/markdown' and trashed=false directly under the path's folder: a copy re-saved under another mime type, trashed or moved reads as 0 here, and so does a copy under the newer of two same-named folders (the search walks the oldest; a duplicate-folder warning prints on stderr). Otherwise the next ordinary upsert of the path (from the service, or kb-import-from-disk --apply) creates and maps it.`,
    );
    return { ok: false };
  }
  if (candidates.length > 1) {
    console.log(
      `FAIL ${path} ${candidates.length} Drive files match; nothing written. Trash the extras in Drive by hand, then re-run.`,
    );
    return { ok: false };
  }
  const [only] = candidates as [Candidate];
  if (!apply) {
    console.log(`PASS ${path} --apply would map it to id=${only.id} (dry run)`);
    return { ok: true };
  }
  recordDriveId(path, only.id);
  const verified = getDriveMapEntry(path)?.driveId === only.id;
  console.log(`${verified ? "PASS" : "FAIL"} ${path} ${verified ? `mapped to id=${only.id}` : "(map row differs after write)"}`);
  return { ok: verified };
}

/** `--path <rel>` (exactly once) and `--apply`; anything else is an error. */
export function parseArgs(argv: string[]): { path: string; apply: boolean } | { error: string } {
  let path: string | null = null;
  let apply = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--apply") apply = true;
    else if (argv[i] === "--path" && path === null && argv[i + 1] && !argv[i + 1]!.startsWith("--")) path = argv[++i]!;
    else return { error: `unexpected argument: ${argv[i]}` };
  }
  return path !== null ? { path, apply } : { error: "--path <rel> is required" };
}

type MainDeps = {
  requireOperatorContext: (tag: string, opts: { tty: boolean }) => void;
  initDatabase: (path: string) => unknown;
  closeDatabase: () => void;
  runRepair: (opts: { path: string; apply: boolean }) => Promise<{ ok: boolean }>;
};

/** Operator entry: the gate runs before any db/Drive side effect. Returns the exit code. */
export async function main(
  argv: string[] = process.argv.slice(2),
  deps: MainDeps = { requireOperatorContext, initDatabase, closeDatabase, runRepair },
): Promise<number> {
  deps.requireOperatorContext("kb-drive-map-repair", { tty: false });
  const args = parseArgs(argv);
  if ("error" in args) {
    console.error(`[kb-drive-map-repair] ${args.error}`);
    return 1;
  }
  deps.initDatabase(process.env.MC_DB_PATH ?? "./data/mc.db");
  let ok = false;
  try {
    ({ ok } = await deps.runRepair(args));
  } finally {
    deps.closeDatabase();
  }
  if (!args.apply) console.log("[kb-drive-map-repair] dry run — pass --apply to write");
  return ok ? 0 : 1;
}

/** True only when this file is the process entry point (never when a test imports it). */
export function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

// runRepair writes sqlite synchronously and starts no fire-and-forget sync: nothing to drain.
if (isMainModule()) process.exitCode = await main();
