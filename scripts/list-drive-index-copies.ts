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

// S6 item 3c: operator context only (login session or operator unit), before any db/Drive call.
requireOperatorContext("list-drive-index-copies", { tty: false });

const DB_PATH = process.env.MC_DB_PATH ?? "./data/mc.db";
const ROOT_FOLDER_ID = process.env.DRIVE_KB_FOLDER_ID ?? "";
const NAME =
  process.argv.find((a) => a.startsWith("--name="))?.slice("--name=".length) ??
  "INDEX.md";
const DRIVE = "https://www.googleapis.com/drive/v3/files";
const OUTSIDE = "OUTSIDE KB FOLDER";
/** Guard against a parent cycle or a very deep tree. */
const MAX_DEPTH = 50;

interface DriveFile {
  id: string;
  name: string;
  createdTime?: string;
  modifiedTime?: string;
  size?: string;
  parents?: string[];
}

interface FolderNode {
  id: string;
  name: string;
  parents?: string[];
}

/** null = 404 (not visible to this account): the chain is outside the KB. */
const folderCache = new Map<string, FolderNode | null>();

/**
 * Look up one folder. A 404 resolves to null and is cached; any other error
 * (auth, quota, timeout) is returned as `{ error }` and NOT cached, so the
 * operator sees UNKNOWN instead of a misleading OUTSIDE.
 */
async function getFolder(id: string): Promise<FolderNode | null | { error: string }> {
  if (folderCache.has(id)) return folderCache.get(id) ?? null;
  try {
    const node = await googleFetch<FolderNode>(`${DRIVE}/${id}?fields=id,name,parents`);
    folderCache.set(id, node);
    return node;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = /Google API (\d{3})/.exec(msg)?.[1];
    if (status === "404") {
      folderCache.set(id, null);
      return null;
    }
    return { error: status ?? msg.slice(0, 80) };
  }
}

/**
 * Folder path relative to the KB root; OUTSIDE when the chain never reaches
 * it; UNKNOWN (<status or message>) when a lookup failed for another reason.
 */
async function kbLocation(parents: string[] | undefined): Promise<string> {
  let id = parents?.[0];
  const names: string[] = [];
  for (let depth = 0; id && depth < MAX_DEPTH; depth++) {
    if (id === ROOT_FOLDER_ID) return names.length ? names.reverse().join("/") : ".";
    const node = await getFolder(id);
    if (!node) break;
    if ("error" in node) return `UNKNOWN (${node.error})`;
    names.push(node.name);
    id = node.parents?.[0];
  }
  return OUTSIDE;
}

async function listByName(name: string): Promise<DriveFile[]> {
  const escaped = name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const q = encodeURIComponent(`name = '${escaped}' and trashed = false`);
  const fields = "nextPageToken,files(id,name,createdTime,modifiedTime,size,parents)";
  const out: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const url =
      `${DRIVE}?q=${q}&fields=${encodeURIComponent(fields)}&pageSize=100` +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
    const page = await googleFetch<{ files?: DriveFile[]; nextPageToken?: string }>(url);
    out.push(...(page.files ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return out;
}

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

  const files = await listByName(NAME);
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
