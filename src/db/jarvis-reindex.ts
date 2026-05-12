/**
 * Reindex jarvis_files from the FS mirror.
 *
 * Architecture: SQLite is source of truth, FS at /root/claude/jarvis-kb/ is
 * a mirror. External writers (shell_exec, manual edits, batch migrations)
 * sometimes drop files into the FS that bypass `upsertFile()` and become
 * invisible to Jarvis's tools. This module walks the FS, finds files
 * missing from the DB, and upserts them so the DB regains parity.
 *
 * Used by:
 *  - `scripts/reindex-jarvis-kb.ts` (manual / one-off)
 *  - `src/rituals/scheduler.ts` (hourly auto-reindex)
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { getDatabase } from "./index.js";
import { upsertFile } from "./jarvis-fs.js";

/**
 * Path prefixes (relative to kbRoot) whose authority lies elsewhere and must
 * NOT be auto-restored by the hourly kb-reindex walk.
 *
 * `NorthStar/` — synced from db.mycommit.net via `northstar_sync`. Any FS file
 * under here that is not on COMMIT is, by definition, a stale orphan. Letting
 * kb-reindex resurrect them creates the 2026-05-12 loop where wipes are undone
 * within the hour.
 */
export const MANAGED_NAMESPACES = ["NorthStar/"];

export interface ReindexResult {
  /** Files on disk under the mirror root. */
  fsCount: number;
  /** Rows currently in jarvis_files. */
  dbCount: number;
  /** Files on disk not present in DB before this run. */
  drift: number;
  /** Files actually upserted (drift minus errors). */
  upserted: number;
  /** Errored files (read failure, upsert exception). */
  errored: number;
  /** Total wall time. */
  durationMs: number;
}

/**
 * Recursively walk a directory and collect .md file paths. Skips `.git` and
 * `node_modules` to avoid scanning git internals or vendored deps. Hardened
 * against permission-denied errors on individual entries — they are skipped
 * silently instead of aborting the whole walk.
 */
export function walkKbDir(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === ".git" || entry === "node_modules") continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkKbDir(full, out);
    else if (st.isFile() && entry.endsWith(".md")) out.push(full);
  }
  return out;
}

function deriveTitle(content: string, fallback: string): string {
  const heading = content.match(/^#\s+(.+)/m);
  if (heading) return heading[1].trim();
  return fallback.replace(/\.md$/, "").replace(/[-_/]/g, " ");
}

function deriveQualifier(path: string): string {
  // Conservative defaults — operator can elevate via jarvis_file_write later.
  // 'enforce' / 'always-read' are reserved for hand-curated rules.
  if (path.startsWith("workspace/")) return "workspace";
  return "reference";
}

/**
 * Walk the mirror dir and upsert any FS-only .md files into jarvis_files.
 * Idempotent: if every FS file is already in the DB, returns drift=0 and
 * doesn't touch the DB.
 */
export function reindexJarvisKb(opts?: { kbRoot?: string }): ReindexResult {
  const start = Date.now();
  const kbRoot =
    opts?.kbRoot ??
    process.env.JARVIS_KB_MIRROR_DIR ??
    "/root/claude/jarvis-kb";

  const fsFiles = walkKbDir(kbRoot);
  const fsRel = new Set(
    fsFiles
      .map((f) => relative(kbRoot, f))
      .filter((p) => !MANAGED_NAMESPACES.some((ns) => p.startsWith(ns))),
  );

  const db = getDatabase();
  const dbPaths = new Set(
    (
      db.prepare("SELECT path FROM jarvis_files").all() as Array<{
        path: string;
      }>
    ).map((r) => r.path),
  );

  const fsOnly = [...fsRel].filter((p) => !dbPaths.has(p));
  let upserted = 0;
  let errored = 0;
  for (const rel of fsOnly) {
    try {
      const full = join(kbRoot, rel);
      const content = readFileSync(full, "utf-8");
      const title = deriveTitle(content, rel);
      const qualifier = deriveQualifier(rel);
      upsertFile(rel, title, content, [], qualifier, 50, null, [], {
        skipUserEdit: true,
      });
      upserted++;
    } catch {
      errored++;
    }
  }

  return {
    fsCount: fsRel.size,
    dbCount: dbPaths.size,
    drift: fsOnly.length,
    upserted,
    errored,
    durationMs: Date.now() - start,
  };
}
