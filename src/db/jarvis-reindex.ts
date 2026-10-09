/**
 * Reindex jarvis_files from the FS mirror.
 *
 * Architecture: SQLite is source of truth, FS at /root/claude/jarvis-kb/ is
 * a mirror. External writers (shell_exec, manual edits, batch migrations)
 * sometimes drop files into the FS that bypass `upsertFile()` and become
 * invisible to Jarvis's tools. This module walks the FS, finds files
 * missing from the DB, and upserts them so the DB regains parity. Rows whose
 * disk copy is newer AND different get their content refreshed (item 11).
 *
 * Used by:
 *  - `scripts/reindex-jarvis-kb.ts` (manual / one-off)
 *  - `src/rituals/scheduler.ts` (hourly auto-reindex)
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { getDatabase } from "./index.js";
import { upsertFile, getFile, getJarvisKbRoot } from "./jarvis-fs.js";
import { errMsg } from "../lib/err-msg.js";

/**
 * Path prefixes (relative to kbRoot) whose authority lies elsewhere and must
 * NOT be auto-restored by the hourly kb-reindex walk.
 *
 * `NorthStar/` — authority is the `jarvis_files` registry (written through the
 * file tools). It was once synced from the COMMIT app (retired 2026-10-06); a
 * disk-only file here is a stale orphan. Letting kb-reindex resurrect them
 * creates the 2026-05-12 loop where wipes are undone within the hour.
 *
 * `directives/` — standing orders. Authority is the proposal flow
 * (`jarvis_propose_directive` → `jarvis_apply_proposal`) or an operator-side
 * `upsertFile`; the model-facing file tools refuse the prefix
 * (`standingOrdersGuard`). A disk-only file here is therefore either a stale
 * orphan or a write that dodged the guard (shell / editor) — importing it would
 * turn that into a live standing order (audit R1-C3, 2026-09-01).
 */
export const MANAGED_NAMESPACES = ["NorthStar/", "directives/"];

/**
 * Skill definitions (`skills/<name>/SKILL.md`) register only through the
 * critic-gated `jarvis_file_write` path (src/skills/kb-file.ts). A disk-only
 * SKILL.md (shell / editor write) imported here would be registered by the
 * next boot scan with the critic skipped, so the walk never imports one.
 * Other files under skills/ (REFERENCE.md, …) are imported as usual.
 */
export const MANAGED_FILE_RE = /^skills\/[^/]+\/SKILL\.md$/i;

/**
 * Prefixes the walk never REFRESHES from disk (a missing file still imports).
 * `logs/day-logs/` — append authority is the registry via the messaging
 * router; the 4 disk stubs of 2026-09 were `shell_exec` leftovers.
 */
export const REFRESH_EXEMPT = ["logs/day-logs/"];

/** The refusal sentence for a model write under `logs/day-logs/` (all writers share it). */
export const DAY_LOG_MANAGED =
  "logs/day-logs/ is mechanically managed (verbatim interaction log). Write the narrative companion to logs/day-narratives/ instead.";

export interface ReindexResult {
  /** Files on disk under the mirror root. */
  fsCount: number;
  /** Rows currently in jarvis_files. */
  dbCount: number;
  /** Files on disk not present in DB before this run. */
  drift: number;
  /** Files actually upserted (drift minus errors). */
  upserted: number;
  /** Registry rows whose content was refreshed from a newer, different disk copy. */
  refreshed: number;
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

/** Item 11 (W1 false positive): the registry path of an absolute disk path, or null. */
export function kbRegistryPath(resolvedAbs: string): string | null {
  const root = getJarvisKbRoot().replace(/\/+$/, "") + "/";
  if (!resolvedAbs.startsWith(root) || !/\.md$/i.test(resolvedAbs)) return null;
  return resolvedAbs.slice(root.length);
}

/**
 * Which copy is newer beyond the 2 s tolerance: `updated_at` has 1 s
 * resolution and the mirror write follows the DB write within ms, so a
 * normal write reads "same". Throws on a NULL `updated_at`.
 */
function newerCopy(updatedAt: string, mtimeMs: number): "disk" | "registry" | "same" {
  const updatedMs = Date.parse(updatedAt.replace(" ", "T") + "Z");
  if (mtimeMs > updatedMs + 2000) return "disk";
  if (updatedMs > mtimeMs + 2000) return "registry";
  return "same";
}

/**
 * Item 11: the registry row for `rel` is newer than its disk copy AND differs
 * from it — a disk write would push a stale copy over it (file_edit refuses;
 * the walk never refreshes that direction).
 */
export function registryNewerThanDisk(
  rel: string,
  diskContent: string,
  mtimeMs: number,
): boolean {
  const row = getFile(rel);
  return (
    !!row &&
    newerCopy(row.updated_at, mtimeMs) === "registry" &&
    row.content !== diskContent
  );
}

/** Item 11: a tool's disk write under the KB root reaches the registry too. */
export function upsertFromDiskWrite(rel: string, content: string): void {
  const prior = getFile(rel);
  upsertFile(
    rel,
    prior?.title ?? deriveTitle(content, rel),
    content,
    prior ? (JSON.parse(prior.tags) as string[]) : [],
    prior?.qualifier ?? deriveQualifier(rel),
    prior?.priority ?? 50,
    prior?.condition ?? null,
    prior ? (JSON.parse(prior.related_to) as string[]) : [],
  );
}

/**
 * Walk the mirror dir and upsert any FS-only .md files into jarvis_files.
 * Idempotent: if every FS file is already in the DB, returns drift=0 and
 * doesn't touch the DB.
 */
export function reindexJarvisKb(opts?: { kbRoot?: string }): ReindexResult {
  const start = Date.now();
  // Same resolver as the mirror (env override → vitest throwaway → live KB);
  // a second hardcoded live path here bypassed the test guard (qa R1 W2).
  const kbRoot = opts?.kbRoot ?? getJarvisKbRoot();

  const fsFiles = walkKbDir(kbRoot);
  const fsRel = new Set(
    fsFiles
      .map((f) => relative(kbRoot, f))
      .filter((p) => !MANAGED_NAMESPACES.some((ns) => p.startsWith(ns)))
      .filter((p) => !MANAGED_FILE_RE.test(p)),
  );

  const db = getDatabase();
  const dbUpdatedAt = new Map(
    (
      db.prepare("SELECT path, updated_at FROM jarvis_files").all() as Array<{
        path: string;
        updated_at: string;
      }>
    ).map((r) => [r.path, r.updated_at]),
  );
  const dbPaths = new Set(dbUpdatedAt.keys());

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

  // Disk-newer rows: content moves, the row's metadata stays. Registry-newer
  // rows are never touched (that direction is a per-file operator ruling).
  let refreshed = 0;
  for (const rel of fsRel) {
    const updatedAt = dbUpdatedAt.get(rel);
    if (updatedAt === undefined) continue;
    if (REFRESH_EXEMPT.some((p) => rel.startsWith(p))) continue;
    try {
      const full = join(kbRoot, rel);
      // mtime is only a pre-filter; content equality is the real test.
      if (newerCopy(updatedAt, statSync(full).mtimeMs) !== "disk") continue;
      const diskContent = readFileSync(full, "utf-8");
      const row = getFile(rel);
      if (!row || row.content === diskContent) continue;
      upsertFile(
        rel,
        row.title,
        diskContent,
        JSON.parse(row.tags) as string[],
        row.qualifier,
        row.priority,
        row.condition,
        JSON.parse(row.related_to) as string[],
        { skipUserEdit: true },
      );
      refreshed++;
    } catch (err) {
      console.warn(`[kb-reindex] refresh failed for ${rel}: ${errMsg(err)}`);
      errored++;
    }
  }

  return {
    fsCount: fsRel.size,
    dbCount: dbPaths.size,
    drift: fsOnly.length,
    upserted,
    refreshed,
    errored,
    durationMs: Date.now() - start,
  };
}
