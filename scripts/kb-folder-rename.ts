/**
 * kb-folder-rename.ts — rename one KB folder `projects/<old>/` → `projects/<new>/`
 * at the SOURCE (the `jarvis_files` registry), not with `mv`.
 *
 * Why: the disk folder is only a mirror; a disk-only `mv` leaves the registry
 * rows behind and the hourly kb-reindex walk re-adds the new disk paths as
 * duplicates. Same mechanism as scripts/cleanup-jarvis-kb.ts moves:
 *
 *   1. moveFile(old, new)          -> registry path + FTS, mirrors the NEW disk
 *                                     file, pgvector re-embed, markIndexDirty.
 *   2. syncDeleteFromKbMirror(old) -> removes the OLD disk file.
 *   3. pgDelete(old) (awaited)     -> removes the old embedding (when enabled).
 *   4. after the loop, the old disk file of EVERY row now under new is removed
 *      (covers a crash between a registry move and its disk delete).
 *   5. rmdirSync on the now-empty old dirs, deepest first (never recursive);
 *      a dir that is not empty is printed and the script exits 3.
 *
 * Also moves the `projects` row keys `kb_folder` / `kb_path` / `kb_readme`
 * that equal or start with the old folder. Links inside file CONTENT are
 * counted, never rewritten (manual).
 *
 * Idempotent: a run cut short (terminal disconnect, crash) is finished by
 * re-running the same command. Rows already under new are not a refusal;
 * only a remaining move whose target already exists under new is.
 *
 * Usage (operator terminal, from the repo root):
 *   npx tsx scripts/kb-folder-rename.ts projects/<old>/ projects/<new>/ --dry-run
 *   npx tsx scripts/kb-folder-rename.ts projects/<old>/ projects/<new>/
 *
 * Exit: 0 done / dry run · 1 refused or a move failed · 2 the operator gate
 * refused · 3 a non-empty old dir was left behind.
 *
 * Not handled: the Google Drive mirror (drive_file_map keeps the old paths;
 * scripts/reconcile-kb-drive.ts). The NEW-path pgvector embedding is started
 * by moveFile in the background and can be lost at process.exit; restore it
 * with `npx tsx src/db/pgvector-backfill.ts` (idempotent upsert on path).
 *
 * Recommended (as for the cleanup script): stop the mission-control service
 * first, so the hourly kb-reindex ritual cannot walk the folder mid-rename.
 * Before the first move, mc.db and the old folder are backed up and the
 * restore recipe is printed.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmdirSync, realpathSync, statSync, statfsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getDatabase } from "../src/db/index.js";
import {
  getKbMirrorWriteDir,
  isLiveDatabaseFile,
  moveFile,
  syncDeleteFromKbMirror,
} from "../src/db/jarvis-fs.js";
import { pgDelete, isPgvectorEnabled } from "../src/db/pgvector.js";
import { updateProject } from "../src/db/projects.js";
import { requireOperatorContext } from "../src/lib/operator-gate.js";
import { isMainModule } from "../src/lib/is-main-module.js";

const ARG_RE = /^projects\/[A-Za-z0-9][A-Za-z0-9_-]*\/?$/;
/** The folder rule KB_README_RE (src/projects/record.ts) accepts. */
const NEW_RE = /^projects\/[a-z0-9][a-z0-9-]*\/$/;
const KB_KEYS = ["kb_folder", "kb_path", "kb_readme"] as const;
/** Same live db as src/db/jarvis-fs.ts LIVE_DB_PATH. */
const LIVE_DB_PATH = "/root/claude/mission-control/data/mc.db";

export interface RenameArgs {
  oldDir: string; // normalised: trailing slash
  newDir: string;
  dryRun: boolean;
}

export function parseArgs(argv: string[]): RenameArgs | { error: string } {
  const pos: string[] = [];
  let dryRun = false;
  for (const a of argv) {
    if (a === "--dry-run") dryRun = true;
    else if (a.startsWith("--")) return { error: `unknown flag ${a}` };
    else pos.push(a);
  }
  if (pos.length !== 2)
    return { error: "usage: kb-folder-rename.ts <projects/old/> <projects/new/> [--dry-run]" };
  for (const p of pos)
    if (!ARG_RE.test(p)) return { error: `refused: ${p} is not a KB folder projects/<name>/` };
  const [oldDir, newDir] = pos.map((p) => (p.endsWith("/") ? p : `${p}/`));
  if (oldDir === newDir) return { error: "refused: old and new are the same folder" };
  if (!NEW_RE.test(newDir!))
    return { error: `refused: ${newDir} must be lowercase projects/<a-z0-9->/` };
  return { oldDir: oldDir!, newDir: newDir!, dryRun };
}

export interface ProjectKeyMove {
  slug: string;
  patch: Record<string, string>;
}

export interface RenamePlan {
  moves: Array<{ from: string; to: string }>;
  /** Rows already under new (a resumed run). */
  alreadyMoved: number;
  /** Old dirs (KB-relative, trailing slash) deepest first, the root last. */
  oldDirs: string[];
  subfolders: number;
  contentLinks: number;
  projectKeys: ProjectKeyMove[];
}

/** Rewrite a kb key value under the old folder, or null when it is not one. */
function movedValue(v: unknown, oldDir: string, newDir: string): string | null {
  if (typeof v !== "string") return null;
  if (v === oldDir.slice(0, -1)) return newDir.slice(0, -1);
  if (v.startsWith(oldDir)) return newDir + v.slice(oldDir.length);
  return null;
}

/** Registry paths under a folder (GLOB: case-sensitive; [A-Za-z0-9_-] has no metacharacters). */
function pathsUnder(dir: string): string[] {
  return (
    getDatabase().prepare("SELECT path FROM jarvis_files WHERE path GLOB ? ORDER BY path").all(`${dir}*`) as Array<{
      path: string;
    }>
  ).map((r) => r.path);
}

/** Read-only: what the rename would do, or why it is refused. */
export function planRename(args: RenameArgs): RenamePlan | { error: string } {
  const db = getDatabase();
  const oldPaths = pathsUnder(args.oldDir);
  const newPaths = pathsUnder(args.newDir);
  if (oldPaths.length === 0 && newPaths.length === 0)
    return { error: `refused: no registry rows under ${args.oldDir} or ${args.newDir}` };

  const moves = oldPaths.map((p) => ({ from: p, to: args.newDir + p.slice(args.oldDir.length) }));
  const taken = new Set(newPaths);
  const collisions = moves.filter((m) => taken.has(m.to));
  if (collisions.length > 0)
    return {
      error: `refused: ${collisions.length} remaining move(s) would overwrite a row under ${args.newDir}: ${collisions
        .map((m) => m.to)
        .join(", ")}`,
    };

  // Dirs of every old path, including the rows a previous run already moved.
  const oldEquivalents = [...oldPaths, ...newPaths.map((p) => args.oldDir + p.slice(args.newDir.length))];
  const dirs = new Set<string>();
  for (const p of oldEquivalents) {
    for (let d = dirname(p); d.length + 1 > args.oldDir.length; d = dirname(d)) dirs.add(`${d}/`);
  }
  const subs = [...dirs].sort((a, b) => b.split("/").length - a.split("/").length || a.localeCompare(b));

  const contentLinks = (
    db.prepare("SELECT COUNT(*) AS n FROM jarvis_files WHERE instr(content, ?) > 0").get(args.oldDir) as {
      n: number;
    }
  ).n;

  const projRows = db
    .prepare(
      `SELECT slug, json_extract(config,'$.kb_folder') AS kb_folder,
              json_extract(config,'$.kb_path') AS kb_path,
              json_extract(config,'$.kb_readme') AS kb_readme
         FROM projects ORDER BY slug`,
    )
    .all() as Array<Record<string, unknown> & { slug: string }>;
  const projectKeys: ProjectKeyMove[] = [];
  for (const p of projRows) {
    const patch: Record<string, string> = {};
    for (const k of KB_KEYS) {
      const v = movedValue(p[k], args.oldDir, args.newDir);
      if (v !== null) patch[k] = v;
    }
    if (Object.keys(patch).length > 0) projectKeys.push({ slug: p.slug, patch });
  }

  return {
    moves,
    alreadyMoved: newPaths.length,
    oldDirs: [...subs, args.oldDir],
    subfolders: subs.length,
    contentLinks,
    projectKeys,
  };
}

export interface RunOptions {
  /** Where the pre-apply backups go. */
  backupDir: string;
  /** The live mc.db (default: the service's); tests point it elsewhere. */
  liveDbPath?: string;
  log?: (line: string) => void;
}

/** Why apply must not start, or null. Checked before any write. */
function applyRefusal(args: RenameArgs, kbRoot: string | null, liveDbPath: string): string | null {
  // Without a mirror dir the old disk files would stay and the reindex walk
  // would re-add them as registry rows: refuse rather than half-rename.
  if (kbRoot === null) return "KB mirror disabled for this db";
  if (process.env.JARVIS_KB_MIRROR_DIR !== undefined && isLiveDatabaseFile(getDatabase().name, liveDbPath))
    return `JARVIS_KB_MIRROR_DIR is set while the open db is the live ${liveDbPath}; unset it`;
  const oldAbs = `${kbRoot}/${args.oldDir}`;
  const newAbs = `${kbRoot}/${args.newDir}`;
  if (existsSync(oldAbs) && existsSync(newAbs) && realpathSync(oldAbs) === realpathSync(newAbs))
    return `${oldAbs} and ${newAbs} are the same directory on disk`;
  return null;
}

/** Plan, print, and (unless --dry-run) apply. Returns the exit code. */
export async function runRename(argv: string[], opts: RunOptions): Promise<number> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const args = parseArgs(argv);
  if ("error" in args) {
    console.error(`[kb-folder-rename] ${args.error}`);
    return 1;
  }
  const plan = planRename(args);
  if ("error" in plan) {
    console.error(`[kb-folder-rename] ${plan.error}`);
    return 1;
  }
  const kbRoot = getKbMirrorWriteDir();

  log(`=== kb-folder-rename ${args.oldDir} -> ${args.newDir} — ${args.dryRun ? "DRY-RUN" : "APPLY"} ===`);
  log(`mirror root: ${kbRoot ?? "DISABLED"}`);
  log(`rows: ${plan.moves.length}   subfolders: ${plan.subfolders}   already under ${args.newDir}: ${plan.alreadyMoved}`);
  for (const m of plan.moves) log(`  ${m.from}  ->  ${m.to}`);
  log(`content links to ${args.oldDir}: ${plan.contentLinks} row(s) — links not rewritten (manual)`);
  log(`projects rows with kb keys under ${args.oldDir}: ${plan.projectKeys.length}`);
  for (const p of plan.projectKeys)
    for (const [k, v] of Object.entries(p.patch)) log(`  ${p.slug}.${k}  ->  ${v}`);

  if (args.dryRun) {
    log(`Dry run — no changes. Re-run without --dry-run to apply.`);
    return 0;
  }

  const refusal = applyRefusal(args, kbRoot, opts.liveDbPath ?? LIVE_DB_PATH);
  if (refusal !== null || kbRoot === null) {
    console.error(`[kb-folder-rename] refused: ${refusal}; nothing changed`);
    return 1;
  }

  // ---- backup (same precaution as cleanup-jarvis-kb), before any move -----
  const db = getDatabase();
  const dbFile = db.memory ? "" : resolve(db.name);
  let dbBytes = 0;
  try {
    dbBytes = dbFile ? statSync(dbFile).size : 0;
  } catch {
    /* unreadable size → no free-space floor */
  }
  const vfs = statfsSync(dirname(opts.backupDir));
  if (vfs.bavail * vfs.bsize < 2 * dbBytes) {
    console.error(`[kb-folder-rename] refused: less than 2x the db size (${dbBytes} B) free in ${opts.backupDir}; nothing changed`);
    return 1;
  }
  mkdirSync(opts.backupDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dbBackup = `${opts.backupDir}/mc-db-pre-kbrename-${ts}.db`;
  await db.backup(dbBackup);
  log(`[backup] ${dbBackup}`);
  const kbBackup = `${opts.backupDir}/kb-folder-pre-kbrename-${ts}.tar.gz`;
  const oldOnDisk = existsSync(`${kbRoot}/${args.oldDir}`);
  if (oldOnDisk) {
    execFileSync("tar", ["-czf", kbBackup, "-C", kbRoot, args.oldDir]);
    log(`[backup] ${kbBackup}`);
  } else log(`[backup] ${kbRoot}/${args.oldDir} not on disk — nothing to archive`);
  log(`[restore] to finish an interrupted run: re-run this same command.`);
  log(
    `[restore] to undo instead (service stopped): cp ${dbBackup} ${dbFile || "<db file>"}` +
      (oldOnDisk ? ` ; tar -xzf ${kbBackup} -C ${kbRoot}` : "") +
      ` ; then delete the partial new dir ${kbRoot}/${args.newDir} by hand`,
  );

  // ---- per file: registry + new disk file, then old disk file -------------
  let moved = 0;
  for (const m of plan.moves) {
    if (moveFile(m.from, m.to)) {
      syncDeleteFromKbMirror(m.from);
      if (isPgvectorEnabled()) await pgDelete(m.from);
      moved++;
    } else {
      console.error(`[kb-folder-rename] move FAILED (source missing?): ${m.from}`);
    }
  }
  log(`[move] ${moved}/${plan.moves.length} relocated.`);

  // ---- old disk file of every row now under new (crash between steps) -----
  const stillOld = new Set(pathsUnder(args.oldDir));
  let swept = 0;
  for (const p of pathsUnder(args.newDir)) {
    const oldPath = args.oldDir + p.slice(args.newDir.length);
    if (stillOld.has(oldPath) || !existsSync(`${kbRoot}/${oldPath}`)) continue;
    syncDeleteFromKbMirror(oldPath);
    swept++;
  }
  log(`[sweep] ${swept} leftover old disk file(s) removed.`);

  // ---- projects row keys (the only non-KB write) --------------------------
  for (const p of plan.projectKeys) updateProject(p.slug, { config: p.patch });
  log(`[projects] ${plan.projectKeys.length} row(s) updated.`);

  // ---- now-empty old dirs, deepest first; never forced --------------------
  const leftover: string[] = [];
  for (const d of plan.oldDirs) {
    try {
      rmdirSync(`${kbRoot}/${d}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") leftover.push(d);
    }
  }

  log(
    `=== done: ${moved} row(s) moved (${plan.alreadyMoved} already), ${plan.projectKeys.length} project row(s) updated, ` +
      `${plan.contentLinks} content link row(s) left (manual) ===`,
  );
  log(
    `pgvector: new-path embeddings are re-embedded in the background and can be lost at exit — ` +
      `restore with: npx tsx src/db/pgvector-backfill.ts`,
  );
  if (leftover.length > 0) {
    for (const d of leftover) console.error(`[kb-folder-rename] NOT EMPTY, left in place: ${kbRoot}/${d}`);
    return 3;
  }
  return moved === plan.moves.length ? 0 : 1;
}

async function main(): Promise<number> {
  const { initDatabase, closeDatabase } = await import("../src/db/index.js");
  initDatabase(process.env.MC_DB_PATH ?? "./data/mc.db");
  try {
    const day = new Date().toISOString().slice(0, 10);
    return await runRename(process.argv.slice(2), {
      backupDir: `/root/claude-backups/kb-folder-rename-${day}`,
    });
  } finally {
    closeDatabase();
  }
}

if (isMainModule(import.meta.url)) {
  // An operator login session with a terminal, before any db/KB side effect.
  requireOperatorContext("kb-folder-rename", { tty: false });
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error("[kb-folder-rename] FAILED:", err);
      process.exit(1);
    },
  );
}
