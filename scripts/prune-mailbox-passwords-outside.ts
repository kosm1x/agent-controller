/**
 * One-off operator script, the second half of scripts/prune-mailbox-passwords.ts:
 * copies of remembered mailbox passwords OUTSIDE the service's own stores.
 *
 * It runs AFTER the local removal, with the service running, and finds a value the
 * same way: the reply check's own candidate runs (`hasKnownRun` of the local script,
 * which uses `candidateRuns` + `passwordFingerprint`), matched against the fingerprint
 * table `mailbox_password_seen` of the local database. The local removal has already
 * added every value it removed to that table.
 *
 * The local database is opened ONLY through `openDatabaseReadOnly` (src/db/index.ts):
 * read-only and must-exist, no set-up step, refused unless its `user_version` is the
 * code's migration head. A write to it is impossible from this process; the drive
 * re-upload reads the module's database through the same handle.
 *
 * Before anything is read the run is refused unless the code it runs is the code the
 * service runs: `dist/build-info.json` names a clean build of a commit in the repository
 * whose code paths equal HEAD's (a docs-only commit on top passes), the code paths of the
 * working tree are clean, and the `--repo` given is the repository this file lives in.
 *
 * Kinds of copy, one counts line each (dry run: count; --apply: act, then a second run
 * must find nothing to do):
 *  1. Search copy (`kb_entries`): every row's title and content (each alone and the two
 *     joined, so a value cut between them is found). A hit whose path has a local
 *     `jarvis_files` row is re-synced from that (already cleaned) row with the code's
 *     own `syncToPgvector`; a hit with no local row (extracted facts, lessons, ingested
 *     chunks) is deleted with the code's own `pgDelete`. Every acted row is read back:
 *     a re-synced row must hold no known value, a deleted one must be gone. More than
 *     DELETE_BOUND deletions refuse unless `--confirm-delete <n>` repeats the exact
 *     count the dry run printed; a `--confirm-delete` with any other number refuses too
 *     (a wrong fingerprint table must not empty the store). A hit whose local row still
 *     holds a value is never re-synced (it would push the value again): it fails the
 *     run, and the local removal must be finished first.
 *  2. Nightly backup copy (`jarvis_kb_backup`): count only. A hit with a local row is
 *     fixed by the nightly push (src/rituals/scheduler.ts `kb-backup`, 22:30 service
 *     time, every jarvis_files row upserted by path); a hit without one stays and needs
 *     a decision (the code has no delete for that table).
 *  3. Cloud-drive mirror: no content is read. The paths re-synced in kind 1, plus every
 *     local row that holds the placeholder (the local removal records no path), that
 *     are in `drive_file_map` get their head revision rewritten from the row with the
 *     code's own `reformatDriveFiles({ exactPath })`. Right before each call the row is
 *     read again: it must exist, have the `updated_at` listed at the start and hold no
 *     known value, else it is left for the next run (`changed_since_listing`). If its
 *     `updated_at` changes during the call, the re-upload is not recorded (`to_redo`).
 *     A path is done once its re-upload is in an earlier run's acted log with the same
 *     `updated_at`. Old revisions stay.
 *  4. `docs/EVOLUTION-LOG.md`: lines holding a known value in the current file and in
 *     its git history (`git log -p`, added and removed lines). Count only: the history
 *     is public, so a hit needs a decision.
 *  5. The SDK auto-memory folder used before the 2026-11-07 opt-out and the decisions
 *     folder: count only (the local script's `scanOnly`); a hit needs a decision.
 *  6. The remote memory service is never contacted (fixed line).
 *  7. Journal, provider logs, local backups, offsite mirror: one fixed line each with
 *     the retention the configuration and scripts state.
 *
 * Output: the mode, counts, table and column names, codes. Never a value, a row id, a
 * path, a file name or a commit id. The paths acted on go to the root-only `--log`
 * file. Lines the code's own functions print through `console.*` while the run is on
 * (they can name a path, or echo a remote error body) are redirected into that file
 * too, each cut at LIB_LINE_CAP characters. NOT redirected: output written straight to
 * the descriptors (the structured logger) and anything printed while this file's own
 * imports load. That is why the script refuses unless the wrapper started it (it sets
 * MC_PRUNE_OUTSIDE_WRAPPER=1): the wrapper keeps the raw output in a root-only file and
 * shows only lines that pass its count-line filter.
 *
 * Settings: the same environment names the service reads (COMMIT_DB_KEY for the search
 * database, the embedding names for `generateEmbedding`, DRIVE_KB_FOLDER_ID and the
 * GOOGLE_* names for the drive). Nothing loads a settings file here: the operator's
 * wrapper starts this with `tsx --env-file=<the service's environment file>`. Only
 * presence is printed (`settings search_db=present ...`), never a value. Every git child
 * gets only PATH, HOME and LANG.
 *
 * Usage (all locations are required; nothing is defaulted), through the wrapper only:
 *   tsx --env-file=.env scripts/prune-mailbox-passwords-outside.ts --db <file> \
 *     --repo <dir> --sdk-memory <dir> --decisions <dir> --log <file> [--apply] [--confirm-delete <n>]
 * The `--log` name must be `mc-prune-mailbox-passwords-<UTC stamp>-outside-acted.log`
 * and must not exist yet (it is created with mode 600).
 * Exit: 0 clean run (`nothing to change`, the dry-run hint, or an apply that acted with
 * no failure: run it again to see it clean); 1 finished with failures or a decision
 * needed (`finished with failures: problems=N`); 2 refused (nothing written).
 */

import type BetterSqlite3 from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readdirSync, realpathSync, statSync, writeSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "node:util";
import { PASSWORD_WITHHELD_PLACEHOLDER } from "../src/lib/v8-4/password-gate.js";
import { requireOperatorContext } from "../src/lib/operator-gate.js";
import { isMainModule as isEntryModule } from "../src/lib/is-main-module.js";
import { closeDatabase, openDatabaseReadOnly } from "../src/db/index.js";
import { Refusal, errorCode, hasKnownRun, scanOnly, type ScanCount } from "./prune-mailbox-passwords.js";

const TAG = "[prune-mailbox-passwords-outside]";

/** More deletions than this in one run need `--confirm-delete <exact count>`. */
export const DELETE_BOUND = 50;
/** Rows per page when listing a remote table. */
export const PAGE = 500;
/** No listing reads more pages than this (no unbounded loop). */
export const MAX_PAGES = 2000;
/** A library line kept in the acted log is cut at this many characters. */
export const LIB_LINE_CAP = 300;
/** The variable the wrapper sets; without it the script refuses. */
export const WRAPPER_MARKER = "MC_PRUNE_OUTSIDE_WRAPPER";
/** The search database's REST base, as src/db/pgvector.ts and src/db/kb-backup.ts spell it (neither exports it). */
const REST = "https://db.mycommit.net/rest/v1";
const EVOLUTION_LOG = "docs/EVOLUTION-LOG.md";
/** The code paths whose working-tree state must match HEAD (scripts/lib/code-paths.sh). */
export const CODE_PATHS = ["src/", "scripts/", "package.json", "package-lock.json", "tsconfig*.json"] as const;
/** The acted log of one run; earlier ones in the same folder carry the drive state. */
export const ACTED_LOG_RE = /^mc-prune-mailbox-passwords-\d{8}T\d{6}Z-outside-acted\.log$/;
/** The only file-header lines of `git log -p -- docs/EVOLUTION-LOG.md` (fixed prefixes). */
const HISTORY_HEADER_RE = /^(---|\+\+\+) (a\/docs\/EVOLUTION-LOG\.md|b\/docs\/EVOLUTION-LOG\.md|\/dev\/null)$/;

export type RemoteTable = "kb_entries" | "jarvis_kb_backup";

export interface RemoteRow {
  path: string;
  title: string;
  content: string;
}

export interface LocalRow {
  path: string;
  title: string;
  content: string;
  tags: string[];
  qualifier: string;
  priority: number;
  condition: string | null;
  updatedAt: string;
}

/** Everything that leaves the process. Tests pass mocks; `realDeps` uses the code's own functions. */
export interface OutsideDeps {
  settings: { searchDb: boolean; embedding: boolean; drive: boolean };
  /** Every row's path, title and content (read only). */
  list(table: RemoteTable): Promise<RemoteRow[]>;
  /** One row by path, or null when there is none (read only). */
  get(table: RemoteTable, path: string): Promise<RemoteRow | null>;
  /** `syncToPgvector` from the local row (re-embeds, upserts by path). */
  resync(row: LocalRow): void | Promise<void>;
  /** `pgDelete`: the search row of that path is deleted. */
  deleteSearchRow(path: string): Promise<boolean>;
  /** Waits for the re-syncs started above. */
  settle(): Promise<void>;
  /** `reformatDriveFiles({ exactPath })`: true only when that path's drive file was rewritten. */
  reupload(path: string): Promise<boolean>;
  /** `git log -p` of the activity log; throws when git fails. */
  gitLog(repo: string): string;
}

export interface OutsideOptions {
  /** The handle from openDatabaseReadOnly. */
  db: BetterSqlite3.Database;
  repo: string;
  sdkMemory: string;
  decisions: string;
  apply: boolean;
  confirmDelete?: number;
  /** `path\0updated_at` of drive re-uploads in earlier runs' acted logs. */
  driveDone: ReadonlySet<string>;
  /** One record per path acted on (root-only log, never the screen). */
  acted: (record: unknown[]) => void;
  log: (line: string) => void;
}

export interface OutsideResult {
  ok: boolean;
  problems: number;
  /** Dry run: what an apply would do. Apply: what it did. */
  pending: number;
}

/** Hit in a title/content pair: either alone, or a value cut between the two. */
export function pairHit(title: string, content: string, fps: ReadonlySet<string>): boolean {
  return hasKnownRun(title, fps) || hasKnownRun(content, fps) || hasKnownRun(title + content, fps);
}

/** Lines of a text that hold a known value. */
export function linesHit(text: string, fps: ReadonlySet<string>): number {
  let n = 0;
  for (const line of text.split("\n")) if (hasKnownRun(line, fps)) n++;
  return n;
}

/** Added and removed lines of the activity log's `git log -p` that hold a known value. */
export function historyLinesHit(patch: string, fps: ReadonlySet<string>): number {
  let n = 0;
  for (const line of patch.split("\n")) {
    if (HISTORY_HEADER_RE.test(line)) continue;
    if ((line.startsWith("+") || line.startsWith("-")) && hasKnownRun(line.slice(1), fps)) n++;
  }
  return n;
}

function text(v: unknown): string {
  if (typeof v === "string") return v;
  if (Buffer.isBuffer(v)) return v.toString("utf8");
  return v == null ? "" : String(v);
}

function tagsOf(v: unknown): string[] {
  try {
    const t = JSON.parse(text(v) || "[]") as unknown;
    return Array.isArray(t) ? t.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

interface Local {
  fps: Set<string>;
  rows: Map<string, LocalRow>;
  driveMapped: Set<string>;
}

const hasTable = (db: BetterSqlite3.Database, t: string): boolean =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t) !== undefined;

/** The fingerprint table, the KB rows and the drive map, through the read-only handle. */
function readLocal(db: BetterSqlite3.Database): Local {
  if (!hasTable(db, "mailbox_password_seen")) throw new Refusal("SEEN_TABLE_ABSENT");
  if (!hasTable(db, "jarvis_files")) throw new Refusal("KB_TABLE_ABSENT");
  const fps = new Set(
    (db.prepare("SELECT fingerprint FROM mailbox_password_seen").all() as Array<{ fingerprint: string }>).map(
      (r) => r.fingerprint,
    ),
  );
  const rows = new Map<string, LocalRow>();
  for (const r of db
    .prepare("SELECT path, title, content, tags, qualifier, priority, condition, updated_at FROM jarvis_files")
    .iterate() as Iterable<Record<string, unknown>>) {
    const path = text(r.path);
    rows.set(path, {
      path,
      title: text(r.title),
      content: text(r.content),
      tags: tagsOf(r.tags),
      qualifier: text(r.qualifier) || "reference",
      priority: typeof r.priority === "number" ? r.priority : 50,
      condition: r.condition == null ? null : text(r.condition),
      updatedAt: text(r.updated_at),
    });
  }
  const driveMapped = new Set<string>();
  if (hasTable(db, "drive_file_map")) {
    for (const r of db.prepare("SELECT path FROM drive_file_map").iterate() as Iterable<{ path: unknown }>) {
      driveMapped.add(text(r.path));
    }
  }
  return { fps, rows, driveMapped };
}

/** The row of `path` as it is now, or null. */
function rowNow(db: BetterSqlite3.Database, path: string): { title: string; content: string; updatedAt: string } | null {
  const r = db.prepare("SELECT title, content, updated_at FROM jarvis_files WHERE path = ?").get(path) as
    | Record<string, unknown>
    | undefined;
  return r ? { title: text(r.title), content: text(r.content), updatedAt: text(r.updated_at) } : null;
}

const presence = (b: boolean): string => (b ? "present" : "absent");

function scanLine(name: string, s: ScanCount): string {
  const notes = [
    s.missing ? "missing" : "",
    s.overCap > 0 ? `over_cap=${s.overCap}` : "",
    s.unreadable > 0 ? `unreadable=${s.unreadable}` : "",
    s.symlinks > 0 ? `symlinks_not_followed=${s.symlinks}` : "",
  ].filter(Boolean);
  return `${TAG} ${name} files=${s.files} hits=${s.hits}${notes.length > 0 ? ` ${notes.join(" ")}` : ""} (count only; a hit needs a decision)`;
}

export async function runOutside(opts: OutsideOptions, deps: OutsideDeps): Promise<OutsideResult> {
  const log = opts.log;
  const started = Date.now();
  const local = readLocal(opts.db);
  const fps = local.fps;
  if (!deps.settings.searchDb) throw new Refusal("SETTINGS_ABSENT", "search_db");

  let failures = 0;
  let decisions = 0;
  let pending = 0;
  const localClean = (r: { title: string; content: string }): boolean => !pairHit(r.title, r.content, fps);

  // ── read everything first: a refusal below leaves nothing written ──
  const listOrCode = async (t: RemoteTable): Promise<RemoteRow[] | string> => {
    try {
      return await deps.list(t);
    } catch (err) {
      return errorCode(err);
    }
  };
  const search = await listOrCode("kb_entries");
  const backup = await listOrCode("jarvis_kb_backup");

  const resync: LocalRow[] = [];
  const orphans: string[] = [];
  let searchHits = 0;
  let searchDirtyLocal = 0;
  if (typeof search !== "string") {
    for (const r of search) {
      if (!pairHit(r.title, r.content, fps)) continue;
      searchHits++;
      const l = local.rows.get(r.path);
      if (!l) orphans.push(r.path);
      else if (localClean(l)) resync.push(l);
      else searchDirtyLocal++;
    }
  }

  const resyncPaths = new Set(resync.map((r) => r.path));
  const driveCandidates: LocalRow[] = [];
  let driveDirtyLocal = 0;
  let driveDone = 0;
  for (const l of local.rows.values()) {
    if (!local.driveMapped.has(l.path)) continue;
    if (!resyncPaths.has(l.path) && !l.content.includes(PASSWORD_WITHHELD_PLACEHOLDER) && !l.title.includes(PASSWORD_WITHHELD_PLACEHOLDER)) continue;
    if (!localClean(l)) driveDirtyLocal++;
    else if (opts.driveDone.has(`${l.path}\0${l.updatedAt}`)) driveDone++;
    else driveCandidates.push(l);
  }

  if (opts.apply) {
    if (opts.confirmDelete !== undefined && opts.confirmDelete !== orphans.length) {
      log(`${TAG} REFUSED: --confirm-delete does not match would_delete=${orphans.length}; nothing written`);
      throw new Refusal("CONFIRM_MISMATCH");
    }
    if (orphans.length > DELETE_BOUND && opts.confirmDelete === undefined) {
      log(
        `${TAG} REFUSED: would_delete=${orphans.length} is above the bound of ${DELETE_BOUND}; check the fingerprint table, then repeat the run with --confirm-delete ${orphans.length}; nothing written`,
      );
      throw new Refusal("DELETE_BOUND");
    }
  }

  log(`${TAG} mode=${opts.apply ? "apply" : "dry-run"}`);
  log(
    `${TAG} settings search_db=${presence(deps.settings.searchDb)} embedding=${presence(deps.settings.embedding)} drive=${presence(deps.settings.drive)}`,
  );
  log(`${TAG} fingerprints=${fps.size}`);

  // ── 1. search copy ──
  if (typeof search === "string") {
    failures++;
    log(`${TAG} search_copy table=kb_entries read_failed code=${search}`);
  } else {
    log(
      `${TAG} search_copy table=kb_entries rows=${search.length} hits=${searchHits} with_local_row=${resync.length + searchDirtyLocal} without_local_row=${orphans.length} local_row_not_clean=${searchDirtyLocal}`,
    );
    failures += searchDirtyLocal;
    if (searchDirtyLocal > 0) {
      log(`${TAG} search_copy local_row_not_clean=${searchDirtyLocal}: finish the local removal first, then run this again`);
    }
    if (!opts.apply) {
      pending += resync.length + orphans.length;
      log(`${TAG} search_copy would_resync=${resync.length} would_delete=${orphans.length} delete_bound=${DELETE_BOUND}`);
    } else if (resync.length + orphans.length > 0) {
      if (resync.length > 0 && !deps.settings.embedding) {
        // A re-sync without the embedding settings would replace each row's embedding with none.
        failures += resync.length;
        log(`${TAG} search_copy resync_skipped=${resync.length} (embedding settings absent)`);
      }
      let resyncFailed = 0;
      const resynced: string[] = [];
      if (deps.settings.embedding) {
        for (const r of resync) {
          try {
            await deps.resync(r);
            resynced.push(r.path);
            opts.acted(["resynced", r.path]);
          } catch {
            resyncFailed++;
          }
        }
      }
      let deleteFailed = 0;
      const deleted: string[] = [];
      for (const p of orphans) {
        let ok = false;
        try {
          ok = await deps.deleteSearchRow(p);
        } catch {
          ok = false;
        }
        if (ok) {
          deleted.push(p);
          opts.acted(["deleted", p]);
        } else deleteFailed++;
      }
      try {
        await deps.settle();
      } catch {
        // each row is read back below
      }
      let verified = 0;
      let notVerified = 0;
      for (const p of resynced) {
        try {
          const back = await deps.get("kb_entries", p);
          if (back && !pairHit(back.title, back.content, fps)) verified++;
          else notVerified++;
        } catch {
          notVerified++;
        }
      }
      for (const p of deleted) {
        try {
          if ((await deps.get("kb_entries", p)) === null) verified++;
          else notVerified++;
        } catch {
          notVerified++;
        }
      }
      failures += resyncFailed + deleteFailed + notVerified;
      pending += resynced.length + deleted.length;
      log(
        `${TAG} search_copy resynced=${resynced.length} deleted=${deleted.length} verified=${verified} failed=${resyncFailed + deleteFailed} not_verified=${notVerified}`,
      );
    }
  }

  // ── 2. nightly backup copy ──
  if (typeof backup === "string") {
    failures++;
    log(`${TAG} backup_copy table=jarvis_kb_backup read_failed code=${backup}`);
  } else {
    let hits = 0;
    let fixed = 0;
    let dirty = 0;
    let orphan = 0;
    for (const r of backup) {
      if (!pairHit(r.title, r.content, fps)) continue;
      hits++;
      const l = local.rows.get(r.path);
      if (!l) orphan++;
      else if (localClean(l)) fixed++;
      else dirty++;
    }
    failures += dirty;
    decisions += orphan;
    log(
      `${TAG} backup_copy table=jarvis_kb_backup rows=${backup.length} hits=${hits} fixed_by_nightly_push=${fixed} local_row_not_clean=${dirty} needs_decision=${orphan} (count only: the nightly push at 22:30 service time rewrites every path that has a local row; the code has no delete for this table)`,
    );
  }

  // ── 3. drive mirror ──
  if (!opts.apply) {
    pending += driveCandidates.length;
    log(
      `${TAG} drive_copy to_reupload=${driveCandidates.length} already_reuploaded=${driveDone} local_row_not_clean=${driveDirtyLocal}`,
    );
  } else {
    let reuploaded = 0;
    let failed = 0;
    let changed = 0;
    let redo = 0;
    if (driveCandidates.length > 0 && !deps.settings.drive) {
      failed = driveCandidates.length;
      log(`${TAG} drive_copy reupload_skipped=${failed} (drive settings absent)`);
    } else {
      for (const l of driveCandidates) {
        const before = rowNow(opts.db, l.path);
        if (!before || before.updatedAt !== l.updatedAt || !localClean(before)) {
          changed++;
          continue;
        }
        let ok = false;
        try {
          ok = await deps.reupload(l.path);
        } catch {
          ok = false;
        }
        if (!ok) {
          failed++;
          continue;
        }
        if (rowNow(opts.db, l.path)?.updatedAt !== l.updatedAt) {
          redo++;
          continue;
        }
        reuploaded++;
        opts.acted(["drive_reuploaded", l.path, l.updatedAt]);
      }
    }
    failures += failed + changed + redo;
    pending += reuploaded;
    log(
      `${TAG} drive_copy reuploaded=${reuploaded} failed=${failed} changed_since_listing=${changed} to_redo=${redo} already_reuploaded=${driveDone} local_row_not_clean=${driveDirtyLocal}`,
    );
  }
  failures += driveDirtyLocal;
  log(`${TAG} drive_copy old revisions stay until the drive expires them or the operator removes them by hand`);

  // ── 4. activity log in the repository ──
  {
    let current = 0;
    let history = 0;
    let note = "";
    const file = join(opts.repo, EVOLUTION_LOG);
    if (existsSync(file)) {
      try {
        current = linesHit(readFileSync(file, "utf8"), fps);
      } catch (err) {
        failures++;
        note += ` current_read_failed code=${errorCode(err)}`;
      }
    } else note += " current_missing";
    try {
      history = historyLinesHit(deps.gitLog(opts.repo), fps);
    } catch (err) {
      failures++;
      note += ` history_read_failed code=${errorCode(err)}`;
    }
    decisions += current + history;
    log(
      `${TAG} evolution_log current_lines_hit=${current} history_lines_hit=${history}${note} (count only; the history is public, so a hit needs a decision)`,
    );
  }

  // ── 5. earlier sinks on disk ──
  for (const [name, dir, pos] of [
    ["sdk_memory", opts.sdkMemory, 1],
    ["decisions", opts.decisions, 2],
  ] as const) {
    const s = scanOnly(dir, pos, fps);
    decisions += s.hits;
    failures += s.overCap + s.unreadable;
    log(scanLine(name, s));
  }

  // ── 6 and 7. fixed lines ──
  log(`${TAG} memory_service=not_contacted`);
  log(`${TAG} journal ages out: MaxRetentionSec=30day SystemMaxUse=1G (journald.conf), and watchdog.sh vacuums it to 200M when the disk is full; it cannot be cleared here`);
  log(`${TAG} provider_logs the embedding and model providers keep their own logs; they cannot be cleared here`);
  log(
    `${TAG} local_backups age out: kb-janitor keeps 4 snapshots (KEEP_BACKUPS=4), backup-db.sh deletes daily copies after 7 days (-mtime +7), the state bundle after 7 days (RETAIN_DAYS=7, it holds the archive folder), the database dump after 3 days (-mtime +3); deploy pre-migrate copies and the first wrapper snapshot are never pruned: delete them by hand`,
  );
  log(`${TAG} offsite_mirror follows deletions on the next nightly pull, except the VPS-backup-preserved folders; it cannot be cleared here`);

  const problems = failures + decisions;
  log(`${TAG} failures=${failures} needs_decision=${decisions}`);
  if (problems > 0) {
    log(`${TAG} finished with failures: problems=${problems} (see the notes above); fix them and run the same command again`);
  } else if (pending > 0) {
    log(
      opts.apply
        ? `${TAG} acted=${pending}: run the same command again; it must find nothing to do`
        : `${TAG} dry run — nothing written; pass --apply to act`,
    );
  } else {
    log(`${TAG} nothing to change`);
  }
  log(`${TAG} timing ms=${Date.now() - started}`);
  return { ok: problems === 0, problems, pending };
}

// ── remote reads (the search database's REST interface; read only) ────────

class CodeError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function rowOf(v: unknown): RemoteRow {
  const r = (v ?? {}) as Record<string, unknown>;
  return { path: text(r.path), title: text(r.title), content: text(r.content) };
}

/** Total from a PostgREST `Content-Range: 0-499/1234` header, or null. */
export function rangeTotal(h: string | null): number | null {
  const m = /\/(\d+)$/.exec(h ?? "");
  return m ? Number(m[1]) : null;
}

type FetchLike = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;

/**
 * Every row of a table, keyset-paged by path (`path=gt.<last>`, `order=path`). Each
 * response must carry a total (rows at or after the cursor); the listing must end
 * with rows read = rows before the last page + that page's total. Anything else, or
 * the page cap reached, is LISTING_INCOMPLETE.
 */
export async function listTable(
  table: RemoteTable,
  fetchImpl: FetchLike,
  headers: Record<string, string>,
  limits: { page: number; maxPages: number } = { page: PAGE, maxPages: MAX_PAGES },
): Promise<RemoteRow[]> {
  const out: RemoteRow[] = [];
  let last: string | null = null;
  for (let page = 0; page < limits.maxPages; page++) {
    const cursor = last === null ? "" : `&path=gt.${encodeURIComponent(last)}`;
    const res = await fetchImpl(`${REST}/${table}?select=path,title,content&order=path${cursor}&limit=${limits.page}`, {
      headers: { ...headers, Prefer: "count=exact" },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new CodeError(`HTTP_${res.status}`);
    const total = rangeTotal(res.headers.get("content-range"));
    const rows = (await res.json()) as unknown;
    if (total === null || !Array.isArray(rows)) throw new CodeError("LISTING_INCOMPLETE");
    if (total < rows.length) throw new CodeError("LISTING_INCOMPLETE");
    const before = out.length;
    for (const r of rows) out.push(rowOf(r));
    if (rows.length < limits.page) {
      if (before + total !== out.length) throw new CodeError("LISTING_INCOMPLETE");
      return out;
    }
    last = out[out.length - 1]!.path;
  }
  throw new CodeError("LISTING_INCOMPLETE");
}

/** One row by exact path, or null. */
export async function getRow(
  table: RemoteTable,
  path: string,
  fetchImpl: FetchLike,
  headers: Record<string, string>,
): Promise<RemoteRow | null> {
  const res = await fetchImpl(`${REST}/${table}?path=eq.${encodeURIComponent(path)}&select=path,title,content&limit=1`, {
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new CodeError(`HTTP_${res.status}`);
  const rows = (await res.json()) as unknown;
  if (!Array.isArray(rows)) throw new CodeError("READ_UNREADABLE");
  return rows.length > 0 ? rowOf(rows[0]) : null;
}

// ── git (minimal environment, fixed flags) ─────────────────────────────────

/** The environment of every git child: PATH, HOME and LANG only. */
export function gitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of ["PATH", "HOME", "LANG"] as const) if (env[k] !== undefined) out[k] = env[k];
  return out;
}

/** Flags in front of every git command: no fsmonitor hook, no signature check, fixed diff prefixes. */
const GIT_FIXED = [
  "-c",
  "core.fsmonitor=",
  "-c",
  "log.showSignature=false",
  "-c",
  "diff.noprefix=false",
  "-c",
  "diff.mnemonicPrefix=false",
];

/** The argv of the activity log's history read. */
export function historyArgv(repo: string): string[] {
  return [
    "-C",
    repo,
    ...GIT_FIXED,
    "log",
    "-p",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "--format=",
    "--",
    EVOLUTION_LOG,
  ];
}

function git(argv: string[]): string {
  const r = spawnSync("git", argv, { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024, env: gitEnv() });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new CodeError(`GIT_EXIT_${r.status ?? "SIGNAL"}`);
  return r.stdout;
}

/** The exit code of a git command (null when it did not run or was killed); output dropped. */
function gitExit(argv: string[]): number | null {
  const r = spawnSync("git", argv, { stdio: "ignore", env: gitEnv() });
  return r.error ? null : r.status;
}

/** Every change ever committed to the activity log, as `git log -p` prints it (no commit headers). */
export function evolutionLogHistory(repo: string): string {
  return git(historyArgv(repo));
}

/** The argv of the working-tree check; `--no-optional-locks`: it never refreshes the index file. */
export function statusArgv(repo: string): string[] {
  return ["--no-optional-locks", "-C", repo, ...GIT_FIXED, "status", "--porcelain=v1", "--", ...CODE_PATHS];
}

/**
 * Why the code this process runs may differ from the code the service runs; null when
 * it does not. `codeRoot` is the repository this file lives in.
 */
export function buildRefusal(repo: string, codeRoot: string): string | null {
  try {
    if (realpathSync(repo) !== realpathSync(codeRoot)) return "REPO_MISMATCH";
  } catch {
    return "REPO_MISMATCH";
  }
  let info: unknown;
  try {
    info = JSON.parse(readFileSync(join(repo, "dist", "build-info.json"), "utf8"));
  } catch {
    return "BUILD_MISMATCH";
  }
  const b = (info ?? {}) as Record<string, unknown>;
  // The commit comes from a file: only a full hex sha ever reaches a git command line.
  const built = b.commit;
  if (typeof built !== "string" || !/^[0-9a-f]{40}$/.test(built) || b.dirty !== false) return "BUILD_MISMATCH";
  // The built commit must be in the repository, and the code at HEAD must be the code
  // that was built (commits touching nothing under the code paths, e.g. docs, pass).
  if (gitExit(["-C", repo, ...GIT_FIXED, "cat-file", "-e", `${built}^{commit}`]) !== 0) return "BUILD_MISMATCH";
  const diff = ["-C", repo, ...GIT_FIXED, "diff", "--quiet", "--no-ext-diff", "--no-textconv", built, "HEAD", "--", ...CODE_PATHS];
  if (gitExit(diff) !== 0) return "BUILD_MISMATCH";
  let status: string;
  try {
    status = git(statusArgv(repo));
  } catch {
    return "TREE_NOT_CLEAN";
  }
  return status.trim() === "" ? null : "TREE_NOT_CLEAN";
}

// ── the code's own functions, for the operator's run ───────────────────────

export async function realDeps(): Promise<OutsideDeps> {
  const pg = await import("../src/db/pgvector.js");
  const sync = await import("../src/db/pgvector-sync.js");
  const emb = await import("../src/inference/embeddings.js");
  const drive = await import("../src/db/drive-sync.js"); // settings only; the re-upload is reuploadExact
  const google = await import("../src/google/auth.js");
  const headers = (): Record<string, string> => {
    const key = pg.getApiKey();
    if (!key) throw new CodeError("SETTINGS_ABSENT");
    return pg.supabaseHeaders(key);
  };
  return {
    settings: {
      searchDb: pg.isPgvectorEnabled(),
      embedding: emb.isEmbeddingEnabled(),
      drive: drive.isDriveSyncEnabled() && google.isGoogleConfigured(),
    },
    list: (table) => listTable(table, fetch, headers()),
    get: (table, path) => getRow(table, path, fetch, headers()),
    resync(r) {
      sync.syncToPgvector(r.path, r.title, r.content, r.tags, r.qualifier, r.priority, r.condition);
    },
    deleteSearchRow: (p) => pg.pgDelete(p),
    settle: () => sync.settlePgvectorSyncs(),
    reupload: reuploadExact,
    gitLog: evolutionLogHistory,
  };
}

/**
 * The drive head of exactly `path`, rewritten by `reformatDriveFiles({ exactPath })`. It
 * reads the row and the map through getDatabase() (the read-only handle); its own guard
 * refuses unless that handle is on the live database file. True only for one file
 * rewritten and none failed: nothing selected, no drive id, a refusal are all false.
 */
export async function reuploadExact(path: string): Promise<boolean> {
  const drive = await import("../src/db/drive-sync.js");
  const r = await drive.reformatDriveFiles({ exactPath: path });
  return r.refused !== true && r.updated === 1 && r.failed === 0;
}

/** `path\0updated_at` of every drive re-upload in the other acted logs of `dir`. */
export function readDriveDone(dir: string, self: string): Set<string> {
  const out = new Set<string>();
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of names) {
    if (n === self || !ACTED_LOG_RE.test(n)) continue;
    let body = "";
    try {
      body = readFileSync(join(dir, n), "utf8");
    } catch {
      continue;
    }
    for (const line of body.split("\n")) {
      try {
        const r = JSON.parse(line) as unknown;
        if (Array.isArray(r) && r[0] === "drive_reuploaded" && typeof r[1] === "string" && typeof r[2] === "string") {
          out.add(`${r[1]}\0${r[2]}`);
        }
      } catch {
        // not a record
      }
    }
  }
  return out;
}

// ── entry ──────────────────────────────────────────────────────────────────

export type Args = {
  apply: boolean;
  confirmDelete?: number;
  db: string;
  repo: string;
  sdkMemory: string;
  decisions: string;
  log: string;
};

const VALUE_FLAGS = ["--db", "--repo", "--sdk-memory", "--decisions", "--log", "--confirm-delete"] as const;
const REQUIRED = ["--db", "--repo", "--sdk-memory", "--decisions", "--log"] as const;
const FLAG_NAME_RE = /^--[a-z][a-z-]*$/;

/** An error names a flag or a position, never a value. */
export function parseArgs(argv: string[]): Args | { error: string } {
  let apply = false;
  const vals: Record<string, string | undefined> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--apply") apply = true;
    else if ((VALUE_FLAGS as readonly string[]).includes(a)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) return { error: `missing value for ${a}` };
      if (vals[a] !== undefined) return { error: `repeated ${a}` };
      vals[a] = v;
      i++;
    } else {
      const name = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
      return { error: FLAG_NAME_RE.test(name) ? `unexpected argument: ${name}` : `unexpected argument at position ${i + 1}` };
    }
  }
  const missing = REQUIRED.filter((f) => !vals[f]);
  if (missing.length > 0) return { error: `missing ${missing.join(" ")}` };
  let confirmDelete: number | undefined;
  if (vals["--confirm-delete"] !== undefined) {
    if (!/^\d{1,6}$/.test(vals["--confirm-delete"])) return { error: "--confirm-delete needs a whole number" };
    if (!apply) return { error: "--confirm-delete needs --apply" };
    confirmDelete = Number(vals["--confirm-delete"]);
  }
  return {
    apply,
    confirmDelete,
    db: vals["--db"]!,
    repo: vals["--repo"]!,
    sdkMemory: vals["--sdk-memory"]!,
    decisions: vals["--decisions"]!,
    log: vals["--log"]!,
  };
}

type MainDeps = {
  requireOperatorContext: (tag: string, opts: { tty: boolean }) => void;
  deps: () => Promise<OutsideDeps>;
  out: (line: string) => void;
  err: (line: string) => void;
  env: NodeJS.ProcessEnv;
  /** The repository this file lives in (the code that runs). */
  codeRoot: string;
};

/** Operator entry: the gate runs before anything else. Resolves to the exit code. */
export async function main(
  argv: string[] = process.argv.slice(2),
  m: MainDeps = {
    requireOperatorContext,
    deps: realDeps,
    out: (l) => process.stdout.write(`${l}\n`),
    err: (l) => process.stderr.write(`${l}\n`),
    env: process.env,
    codeRoot: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  },
): Promise<number> {
  m.requireOperatorContext("prune-mailbox-passwords-outside", { tty: false });
  if (m.env[WRAPPER_MARKER] !== "1") {
    m.err(`${TAG} REFUSED code=NOT_UNDER_WRAPPER — run it through the operator wrapper; nothing written`);
    return 2;
  }
  const args = parseArgs(argv);
  if ("error" in args) {
    m.err(`${TAG} ${args.error}`);
    return 2;
  }
  const self = basename(args.log);
  if (!ACTED_LOG_RE.test(self)) {
    m.err(`${TAG} REFUSED code=LOG_NAME — nothing written`);
    return 2;
  }
  let fd: number;
  try {
    if (!statSync(dirname(args.log)).isDirectory()) throw new Error("not a folder");
    fd = openSync(args.log, "wx", 0o600);
  } catch (err) {
    m.err(`${TAG} REFUSED code=LOG_OPEN_${errorCode(err)} — nothing written`);
    return 2;
  }
  const record = (r: unknown[]): void => {
    writeSync(fd, `${JSON.stringify(r)}\n`);
  };
  // Lines the code's own functions print through console.* can name a path: into the log.
  const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  const toLog = (...a: unknown[]): void => record(["lib", format(...a).slice(0, LIB_LINE_CAP)]);
  console.log = console.info = console.warn = console.error = console.debug = toLog;
  let dbOpen = false;
  try {
    const why = buildRefusal(args.repo, m.codeRoot);
    if (why) throw new Refusal(why);
    let db: BetterSqlite3.Database;
    try {
      db = openDatabaseReadOnly(args.db);
    } catch (err) {
      const code = errorCode(err);
      throw new Refusal(code === "SCHEMA_MISMATCH" || code === "DB_ALREADY_OPEN" ? code : "DB_UNREADABLE");
    }
    dbOpen = true;
    const deps = await m.deps();
    const r = await runOutside(
      {
        db,
        repo: args.repo,
        sdkMemory: args.sdkMemory,
        decisions: args.decisions,
        apply: args.apply,
        confirmDelete: args.confirmDelete,
        driveDone: readDriveDone(dirname(args.log), self),
        acted: record,
        log: m.out,
      },
      deps,
    );
    return r.ok ? 0 : 1;
  } catch (err) {
    if (err instanceof Refusal) {
      m.err(`${TAG} REFUSED code=${err.code}${err.detail ? ` name=${err.detail}` : ""} — nothing written`);
      return 2;
    }
    m.err(`${TAG} ERROR code=${errorCode(err)} — run the same command again; acted paths so far are in the log`);
    return 1;
  } finally {
    if (dbOpen) {
      try {
        const drive = await import("../src/db/drive-sync.js");
        await drive.settleDriveSyncs();
      } catch {
        // the run's result stands
      }
      closeDatabase();
    }
    Object.assign(console, saved);
    closeSync(fd);
  }
}

/** True only when this file is the process entry point (never when a test imports it). */
export function isMainModule(): boolean {
  return isEntryModule(import.meta.url);
}

if (isMainModule()) process.exitCode = await main();
