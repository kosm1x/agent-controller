/**
 * trash-drive-index-copies.ts — move stale Drive copies of INDEX.md to the
 * Drive TRASH (recoverable from the Drive trash for 30 days; never a
 * permanent delete, never emptyTrash).
 *
 * OPERATOR-ONLY. Lists every non-trashed Drive file named INDEX.md (same
 * listing + parent-path resolution as scripts/list-drive-index-copies.ts) and
 * selects a file only when it is a plain file (not a folder, shortcut or other
 * Google-native type), its id is in NO drive_file_map row, it sits in the
 * KB root (`.`) or the `NorthStar` folder under DRIVE_KB_FOLDER_ID, and its
 * modifiedTime is older than --older-than-days (default 30). Opens data/mc.db
 * read-only; it never writes drive_file_map or anything else.
 *
 *   npx tsx --env-file=.env scripts/trash-drive-index-copies.ts                              # dry run (default): prints the plan, changes nothing
 *   npx tsx --env-file=.env scripts/trash-drive-index-copies.ts --apply --log=<path> [--limit=<n>]   # trash them
 *
 *   --apply              one PATCH {trashed:true} per file, sequential, 100 ms apart;
 *                        stops after 5 consecutive failures, or at once when a log
 *                        line cannot be written. Needs --log.
 *   --log=<path>         appends `<iso time> <id> trashed|FAILED <short error>` per file.
 *   --limit=<n>          trash at most n files this run (default: every eligible file).
 *   --older-than-days=<n> age guard (default 30).
 *
 * REFUSES (exit 2, before any PATCH) when DRIVE_KB_FOLDER_ID is empty, when
 * drive_file_map has no row for path INDEX.md, when that row's drive_id is not
 * in the Drive listing (wrong or empty database), or when the listing errored
 * or Drive reported it incomplete, or (--apply) when the --log file cannot be
 * written. The dry run and the summary print the database path and its mapped
 * id count, so a wrong database shows before --apply. Idempotent: a re-run
 * lists only the files that are still not trashed.
 */

import Database from "better-sqlite3";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { googleFetch } from "../src/google/client.js";
import { requireOperatorContext } from "../src/lib/operator-gate.js";
import { isMainModule } from "../src/lib/is-main-module.js";
import { DRIVE_FILES, OUTSIDE, driveLookup, type DriveFetch, type DriveFile } from "./lib/drive-index-lookup.js";

const TAG = "trash-drive-index-copies";
const DB_PATH = process.env.MC_DB_PATH ?? "./data/mc.db";
export const NAME = "INDEX.md";
/** KB-relative folders whose unmapped copies may be trashed; anything else is skipped: location. */
export const ALLOWED_LOCATIONS: readonly string[] = [".", "NorthStar"];
export const PAUSE_MS = 100;
export const MAX_CONSECUTIVE_FAILURES = 5;
const DAY_MS = 86_400_000;

export interface Flags {
  apply: boolean;
  log?: string;
  limit?: number;
  olderThanDays: number;
}

/** Pure: argv (without node + script) → flags, or why this invocation is refused. */
export function parseFlags(argv: string[]): Flags | { error: string } {
  const f: Flags = { apply: false, olderThanDays: 30 };
  const positive = (flag: string, v: string): number | { error: string } =>
    /^\d+$/.test(v) && Number(v) >= 1 ? Number(v) : { error: `${flag} must be a positive integer (got "${v}")` };
  for (const a of argv) {
    if (a === "--apply") f.apply = true;
    else if (a.startsWith("--log=")) f.log = a.slice("--log=".length);
    else if (a.startsWith("--limit=")) {
      const n = positive("--limit", a.slice("--limit=".length));
      if (typeof n !== "number") return n;
      f.limit = n;
    } else if (a.startsWith("--older-than-days=")) {
      const n = positive("--older-than-days", a.slice("--older-than-days=".length));
      if (typeof n !== "number") return n;
      f.olderThanDays = n;
    } else return { error: `unknown argument: ${a}` };
  }
  if (f.apply && !f.log) return { error: "--apply needs --log=<path> (one line per file)" };
  return f;
}

export type SkipReason =
  | "name"
  | "trashed"
  | "mapped"
  | "not-a-file"
  | "outside-kb"
  | "unknown-parent"
  | "location"
  | "age";
export interface Located extends DriveFile {
  location: string;
}

function skipReason(f: Located, mappedIds: ReadonlySet<string>, cutoffMs: number): SkipReason | null {
  if (f.name !== NAME) return "name";
  if (f.trashed === true) return "trashed";
  if (mappedIds.has(f.id)) return "mapped";
  // Folders, shortcuts and every other Google-native type (trashing a folder trashes its contents); no mimeType = unknown.
  if (!f.mimeType || f.mimeType.startsWith("application/vnd.google-apps.")) return "not-a-file";
  if (f.location === OUTSIDE) return "outside-kb";
  if (f.location.startsWith("UNKNOWN")) return "unknown-parent";
  if (!ALLOWED_LOCATIONS.includes(f.location)) return "location";
  // A missing/unparseable modifiedTime is NaN and fails the comparison: skipped as "age".
  if (!(Date.parse(f.modifiedTime ?? "") < cutoffMs)) return "age";
  return null;
}

/** Pure: which located files may be trashed, and why each other one is skipped. */
export function selectStale(
  files: Located[],
  mappedIds: ReadonlySet<string>,
  opts: { nowMs: number; olderThanDays: number },
): { eligible: Located[]; skipped: Array<{ file: Located; reason: SkipReason }> } {
  const cutoffMs = opts.nowMs - opts.olderThanDays * DAY_MS;
  const eligible: Located[] = [];
  const skipped: Array<{ file: Located; reason: SkipReason }> = [];
  for (const f of files) {
    const reason = skipReason(f, mappedIds, cutoffMs);
    if (reason) skipped.push({ file: f, reason });
    else eligible.push(f);
  }
  return { eligible, skipped };
}

/** Every side effect of a run, injected so tests never touch Google or a real db. */
export interface RunDeps {
  fetch: DriveFetch;
  /** The database mapRows reads, as printed in the header and summary. */
  dbPath: string;
  rootFolderId: string;
  /** Every drive_file_map row (read-only). */
  mapRows(): Array<{ path: string; drive_id: string }>;
  /** Append one line to the --log file. */
  appendLog(path: string, line: string): void;
  sleep(ms: number): Promise<void>;
  now(): number;
  out(line: string): void;
  err(line: string): void;
}

/** Read-only: the drive_file_map rows of an open db. */
export function readMapRows(db: Database.Database): Array<{ path: string; drive_id: string }> {
  return db.prepare("SELECT path, drive_id FROM drive_file_map").all() as Array<{ path: string; drive_id: string }>;
}

const shortErr = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").slice(0, 120);

/**
 * Sequential trash: one PATCH per file, PAUSE_MS apart. Stops (with `stopped`
 * = why) after MAX_CONSECUTIVE_FAILURES PATCH failures in a row, or at once
 * when a log line cannot be written (naming the file whose outcome is unlogged).
 */
export async function trashAll(
  files: Located[],
  deps: Pick<RunDeps, "fetch" | "sleep" | "now"> & { log(line: string): void },
): Promise<{ trashed: number; failed: number; stopped: string | null }> {
  let trashed = 0;
  let failed = 0;
  let streak = 0;
  for (const [i, f] of files.entries()) {
    if (i > 0) await deps.sleep(PAUSE_MS);
    let error: string | null = null;
    try {
      await deps.fetch(`${DRIVE_FILES}/${encodeURIComponent(f.id)}`, { method: "PATCH", body: { trashed: true } });
    } catch (err) {
      error = shortErr(err);
    }
    if (error === null) {
      trashed++;
      streak = 0;
    } else {
      failed++;
      streak++;
    }
    try {
      deps.log(`${new Date(deps.now()).toISOString()} ${f.id} ${error === null ? "trashed" : `FAILED ${error}`}`);
    } catch (err) {
      const outcome = error === null ? "was trashed" : "PATCH failed";
      return { trashed, failed, stopped: `log write failed (${shortErr(err)}): ${f.id} ${outcome} but is NOT in the log` };
    }
    if (streak >= MAX_CONSECUTIVE_FAILURES)
      return { trashed, failed, stopped: `${MAX_CONSECUTIVE_FAILURES} consecutive PATCH failures` };
  }
  return { trashed, failed, stopped: null };
}

/** Exit code: 0 ok, 1 some PATCH failed or the run stopped, 2 refused. */
export async function run(flags: Flags, deps: RunDeps): Promise<number> {
  const refuse = (why: string): number => {
    deps.err(`[${TAG}] REFUSED: ${why}`);
    return 2;
  };
  if (!deps.rootFolderId) return refuse("DRIVE_KB_FOLDER_ID is empty");
  const rows = deps.mapRows();
  const liveId = rows.find((r) => r.path === NAME)?.drive_id;
  if (!liveId) return refuse(`drive_file_map has no row for path ${NAME} (wrong or empty database?)`);

  const lookup = driveLookup(deps.fetch, deps.rootFolderId);
  let listing: Awaited<ReturnType<typeof lookup.listByName>>;
  try {
    listing = await lookup.listByName(NAME);
  } catch (err) {
    return refuse(`Drive listing failed: ${shortErr(err)}`);
  }
  if (listing.incomplete) return refuse("Drive reported the listing as incomplete (incompleteSearch)");
  if (!listing.files.some((f) => f.id === liveId))
    return refuse(`the live ${NAME} recorded in drive_file_map (${liveId}) is not in the Drive listing (wrong database?)`);

  listing.files.sort((a, b) => (a.createdTime ?? "").localeCompare(b.createdTime ?? ""));
  const located: Located[] = [];
  for (const f of listing.files) located.push({ ...f, location: await lookup.kbLocation(f.parents) });

  const { eligible, skipped } = selectStale(located, new Set(rows.map((r) => r.drive_id)), {
    nowMs: deps.now(),
    olderThanDays: flags.olderThanDays,
  });
  const batch = flags.limit === undefined ? eligible : eligible.slice(0, flags.limit);
  const mappedCount = new Set(rows.map((r) => r.drive_id)).size;
  const dbText = `db=${deps.dbPath} mapped-ids=${mappedCount}`;
  deps.out(`database: ${deps.dbPath} (${rows.length} drive_file_map rows, ${mappedCount} distinct drive ids)`);
  const verb = flags.apply ? "trash" : "would trash";
  for (const f of batch)
    deps.out(`${verb}  ${f.id}  ${f.location}  modified=${f.modifiedTime ?? "-"}  size=${f.size ?? "-"}`);
  for (const s of skipped) deps.out(`skipped: ${s.reason}  ${s.file.id}  ${s.file.location}  modified=${s.file.modifiedTime ?? "-"}`);

  const counts = new Map<SkipReason, number>();
  for (const s of skipped) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1);
  const skippedText = [...counts].map(([r, n]) => `${r}=${n}`).join(" ") || "none";
  const byLocation = ALLOWED_LOCATIONS.map((l) => `${l}=${eligible.filter((f) => f.location === l).length}`).join(" ");
  const head = `${dbText} listed=${listing.files.length} eligible=${eligible.length} (by location: ${byLocation}) this-run=${batch.length}`;

  if (!flags.apply) {
    deps.out(`DRY RUN, nothing changed. ${head}; skipped: ${skippedText}. Re-run with --apply --log=<path> to trash.`);
    return 0;
  }
  const logPath = flags.log ?? "";
  const log = (line: string): void => deps.appendLog(logPath, line);
  try {
    log(`# ${new Date(deps.now()).toISOString()} ${TAG} start: ${batch.length} file(s) to trash`);
  } catch (err) {
    return refuse(`cannot write --log=${logPath}: ${shortErr(err)}`);
  }
  const r = await trashAll(batch, { ...deps, log });
  if (r.stopped) deps.err(`[${TAG}] STOPPED: ${r.stopped}`);
  deps.out(`Summary: ${head} trashed=${r.trashed} failed=${r.failed}; skipped: ${skippedText}.`);
  return r.failed > 0 || r.stopped ? 1 : 0;
}

/** CLI: the operator gate first, before any flag, db or Drive work. */
export async function main(argv: string[], deps: RunDeps & { gate(): void }): Promise<number> {
  deps.gate();
  const flags = parseFlags(argv);
  if ("error" in flags) {
    deps.err(`[${TAG}] REFUSED: ${flags.error}`);
    return 2;
  }
  return run(flags, deps);
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2), {
    // S6 item 3c: operator context only (login session or operator unit), before any db/Drive call.
    gate: () => requireOperatorContext("trash-drive-index-copies", { tty: false }),
    fetch: googleFetch,
    dbPath: resolve(DB_PATH),
    rootFolderId: process.env.DRIVE_KB_FOLDER_ID ?? "",
    mapRows: () => {
      const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
      try {
        return readMapRows(db);
      } finally {
        db.close();
      }
    },
    appendLog: (path, line) => appendFileSync(path, `${line}\n`),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    out: (l) => console.log(l),
    err: (l) => console.error(l),
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(`[${TAG}] FAILED:`, err);
      process.exitCode = 1;
    },
  );
}
