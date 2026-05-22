/**
 * cleanup-jarvis-kb.ts — remove machine noise from the Jarvis Knowledge Base.
 *
 * WHY THIS IS DB-SIDE, NOT `rm`:
 * The folder /root/claude/jarvis-kb/ is only a MIRROR. The source of truth is
 * the `jarvis_files` SQLite table; search runs on the `jarvis_files_fts` FTS5
 * index; there is also a pgvector embedding mirror. Deleting files on disk
 * with `rm` leaves the DB rows, the FTS index, and the embeddings intact —
 * recall would not improve at all. This script deletes at the source:
 *
 *   1. DELETE FROM jarvis_files   -> the FTS5 index self-maintains via the
 *                                    jarvis_files_ad AFTER DELETE trigger.
 *   2. syncDeleteFromKbMirror()   -> removes the disk mirror file.
 *   3. pgDelete()  (awaited)      -> removes the pgvector embedding.
 *
 * Usage:
 *   npx tsx scripts/cleanup-jarvis-kb.ts            # dry run (default)
 *   npx tsx scripts/cleanup-jarvis-kb.ts --apply    # execute
 *
 * --apply needs COMMIT_DB_KEY in the environment for the pgvector layer.
 * Without it, the DB + FTS + disk cleanup still runs correctly and pgvector
 * is reported as SKIPPED (clean it later once creds are present).
 *
 * NOT fully handled here: the Google Drive mirror (1,000+ rate-limited calls —
 * see scripts/reconcile-kb-drive.ts), and a relocated row's NEW-path pgvector
 * embedding (moveFile's re-embed is fire-and-forget; restored on next edit or
 * via scripts/backfill-kb-drive.ts). NorthStar/ and directives/ are untouched.
 *
 * Recommended: stop the mission-control service first, so there is no
 * concurrent writer and the hourly kb-reindex ritual cannot race the deletes.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, rmdirSync, realpathSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { initDatabase, getDatabase, closeDatabase } from "../src/db/index.js";
import { syncDeleteFromKbMirror, moveFile } from "../src/db/jarvis-fs.js";
import { pgDelete, isPgvectorEnabled } from "../src/db/pgvector.js";

const DB_PATH = process.env.MC_DB_PATH ?? "./data/mc.db";
const KB_ROOT = process.env.JARVIS_KB_MIRROR_DIR ?? "/root/claude/jarvis-kb";
const BACKUP_DIR = "/root/backups";
const APPLY = process.argv.includes("--apply");
const TS = new Date().toISOString().replace(/[:.]/g, "-");

/** Prefixes whose authority lies elsewhere — never deleted or moved. */
const PROTECTED = ["NorthStar/", "directives/"];

interface Row {
  path: string;
  content: string;
}

function isProtected(p: string): boolean {
  return PROTECTED.some((pre) => p.startsWith(pre));
}

// ---------------------------------------------------------------------------
// Classification — pure, decided from DB rows only. Exported for unit tests.
// ---------------------------------------------------------------------------

/** Noise to DELETE. Returns the reason, or null if the row is a keeper. */
export function deleteReason(r: Row): string | null {
  if (isProtected(r.path)) return null;
  // workspace/ auto-persist task dumps — by CONTENT marker, never by filename.
  if (r.path.startsWith("workspace/") && r.content.startsWith("[AUTO-PERSIST"))
    return "workspace auto-persist dump";
  // tuning-hash micro-files: knowledge/execution-patterns/YYYY-MM-DD-<hex>.md
  if (
    /^knowledge\/execution-patterns\/\d{4}-\d{2}-\d{2}-[0-9a-f]+\.md$/.test(
      r.path,
    )
  )
    return "execution-patterns tuning hash";
  // dead session logs — distilled into logs/day-logs/, last write 2026-04-06.
  if (r.path.startsWith("logs/sessions/")) return "dead session log";
  // old machine compaction snapshots.
  if (r.path.startsWith("compaction/")) return "machine compaction snapshot";
  return null;
}

/** Misplaced real content to MOVE. Returns the new path, or null. */
export function moveTarget(path: string): string | null {
  if (isProtected(path)) return null;
  if (path === "knowledge/execution-patterns/algebra-progress.md")
    return "knowledge/learning/algebra-progress.md";
  if (path.startsWith("knowledge-base/"))
    return "knowledge/" + path.slice("knowledge-base/".length);
  if (path.startsWith("mexiconecesario/"))
    return (
      "projects/mexico-necesario-ac/docs/" +
      path.slice("mexiconecesario/".length)
    );
  if (path.startsWith("data-intelligence/"))
    return (
      "projects/data-intelligence/" + path.slice("data-intelligence/".length)
    );
  if (path.startsWith("root/")) return "knowledge/domain/" + basename(path);
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function mapPool<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let i = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (i < items.length) {
        const idx = i++;
        await fn(items[idx]);
      }
    },
  );
  await Promise.all(workers);
}

function tryRmdir(rel: string): void {
  try {
    rmdirSync(`${KB_ROOT}/${rel}`);
  } catch {
    /* not empty or already gone — fine */
  }
}

/** True when this file is the process entry point (not imported by a test). */
function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return (
      realpathSync(process.argv[1]) ===
      realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  initDatabase(DB_PATH);
  const db = getDatabase();

  const rows = db
    .prepare("SELECT path, content FROM jarvis_files")
    .all() as Row[];

  const toDelete: Array<{ path: string; reason: string }> = [];
  const rawMoves: Array<{ from: string; to: string }> = [];
  for (const r of rows) {
    const reason = deleteReason(r);
    if (reason) {
      toDelete.push({ path: r.path, reason });
      continue;
    }
    const target = moveTarget(r.path);
    if (target) rawMoves.push({ from: r.path, to: target });
  }

  // ---- move-collision guard ----------------------------------------------
  // moveFile() DELETEs an existing target before renaming onto it — a silent
  // overwrite. Drop any move whose target already exists as a row, or that
  // collides with another move's target; surface it instead of destroying it.
  const allPaths = new Set(rows.map((r) => r.path));
  const targetCount = new Map<string, number>();
  for (const m of rawMoves)
    targetCount.set(m.to, (targetCount.get(m.to) ?? 0) + 1);
  const toMove: Array<{ from: string; to: string }> = [];
  const moveCollisions: Array<{ from: string; to: string; why: string }> = [];
  for (const m of rawMoves) {
    if (allPaths.has(m.to))
      moveCollisions.push({ ...m, why: "target path already exists" });
    else if ((targetCount.get(m.to) ?? 0) > 1)
      moveCollisions.push({ ...m, why: "another move targets the same path" });
    else toMove.push(m);
  }

  // ---- report -------------------------------------------------------------
  const mode = APPLY ? "APPLY" : "DRY-RUN";
  console.log(`\n=== Jarvis KB cleanup — ${mode} — ${TS} ===`);
  console.log(`DB: ${DB_PATH}   rows: ${rows.length}`);
  console.log(
    `pgvector layer: ${isPgvectorEnabled() ? "enabled" : "SKIPPED (no COMMIT_DB_KEY)"}\n`,
  );

  const byReason = new Map<string, number>();
  for (const d of toDelete)
    byReason.set(d.reason, (byReason.get(d.reason) ?? 0) + 1);
  console.log(`DELETE — ${toDelete.length} rows:`);
  for (const [reason, n] of [...byReason].sort((a, b) => b[1] - a[1]))
    console.log(`  ${String(n).padStart(5)}  ${reason}`);

  console.log(`\nMOVE — ${toMove.length} rows:`);
  for (const m of toMove) console.log(`  ${m.from}  ->  ${m.to}`);
  if (moveCollisions.length > 0) {
    console.log(
      `\nMOVE COLLISIONS — ${moveCollisions.length} SKIPPED (would overwrite a row):`,
    );
    for (const m of moveCollisions)
      console.log(`  ${m.from}  ->  ${m.to}   [${m.why}]`);
  }

  const keep = rows.length - toDelete.length;
  console.log(
    `\nKEEP: ${keep} rows  (incl. NorthStar/, directives/, real notes)`,
  );

  if (!APPLY) {
    console.log(`\nDry run — no changes. Re-run with --apply to execute.`);
    closeDatabase();
    return;
  }

  // ---- backup (apply only) ------------------------------------------------
  mkdirSync(BACKUP_DIR, { recursive: true });
  const dbBackup = `${BACKUP_DIR}/mc-db-pre-kbcleanup-${TS}.db`;
  console.log(`\n[backup] mc.db -> ${dbBackup}`);
  await db.backup(dbBackup);
  const kbBackup = `${BACKUP_DIR}/jarvis-kb-pre-kbcleanup-${TS}.tar.gz`;
  console.log(`[backup] KB folder -> ${kbBackup}`);
  execFileSync("tar", ["-czf", kbBackup, "-C", "/", "root/claude/jarvis-kb"]);
  console.log(`[backup] done.`);

  // ---- moves first (so a moved file is never caught by a later delete) ----
  let moved = 0;
  for (const m of toMove) {
    if (moveFile(m.from, m.to)) {
      // moveFile mirrors the NEW disk path but does not remove the OLD one.
      syncDeleteFromKbMirror(m.from);
      if (isPgvectorEnabled()) await pgDelete(m.from);
      moved++;
    } else {
      console.warn(`[move] FAILED (source missing?): ${m.from}`);
    }
  }
  console.log(`\n[move] ${moved}/${toMove.length} relocated.`);

  // ---- deletes ------------------------------------------------------------
  const del = db.prepare("DELETE FROM jarvis_files WHERE path = ?");
  let deleted = 0;
  for (const d of toDelete) {
    del.run(d.path); // FTS5 self-maintains via the AFTER DELETE trigger
    syncDeleteFromKbMirror(d.path);
    deleted++;
  }
  console.log(
    `[delete] ${deleted} rows removed from jarvis_files (+ FTS + disk).`,
  );

  // pgvector deletes — awaited, concurrency-limited, so they finish before exit
  if (isPgvectorEnabled()) {
    let pg = 0;
    let pgFailed = 0;
    await mapPool(toDelete, 8, async (d) => {
      // pgDelete returns false (never throws) on any failure — count it,
      // because the SQLite row is already gone and a re-run will NOT retry.
      if (await pgDelete(d.path)) pg++;
      else pgFailed++;
    });
    console.log(`[delete] ${pg} pgvector embeddings removed.`);
    if (pgFailed > 0)
      console.log(
        `[delete] WARNING: ${pgFailed} pgvector delete(s) FAILED — those ` +
          `embeddings are now orphaned (their SQLite rows are already gone). ` +
          `Inspect kb_entries for paths absent from jarvis_files.`,
      );
  } else {
    console.log(
      `[delete] pgvector SKIPPED — ${deleted} embeddings remain. ` +
        `Re-run with COMMIT_DB_KEY set, or reconcile separately.`,
    );
  }

  // ---- tidy now-empty mirror dirs ----------------------------------------
  for (const d of [
    "logs/sessions",
    "compaction",
    "knowledge/execution-patterns",
    "knowledge-base/denue-intel",
    "knowledge-base",
    "mexiconecesario",
    "data-intelligence",
    "root/claude/knowledge",
    "root/claude",
    "root",
  ])
    tryRmdir(d);

  // ---- verify -------------------------------------------------------------
  const after = (
    db.prepare("SELECT COUNT(*) AS n FROM jarvis_files").get() as { n: number }
  ).n;
  const fts = (
    db.prepare("SELECT COUNT(*) AS n FROM jarvis_files_fts").get() as {
      n: number;
    }
  ).n;
  const driveOrphans = (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM drive_file_map WHERE path NOT IN (SELECT path FROM jarvis_files)",
      )
      .get() as { n: number }
  ).n;

  console.log(`\n=== done ===`);
  console.log(`jarvis_files: ${rows.length} -> ${after}`);
  console.log(
    `FTS5 index:   ${fts}  ${fts === after ? "(in sync)" : "(MISMATCH — investigate)"}`,
  );
  console.log(
    `Drive mirror: ${driveOrphans} orphaned files left in drive_file_map ` +
      `(follow-up: scripts/reconcile-kb-drive.ts).`,
  );
  if (moveCollisions.length > 0)
    console.log(
      `Move collisions: ${moveCollisions.length} relocation(s) skipped — ` +
        `resolve by hand (see MOVE COLLISIONS above).`,
    );
  console.log(
    `Restore if needed: cp ${dbBackup} ${DB_PATH}  (with the service stopped).`,
  );

  closeDatabase();
}

// Only auto-run when invoked as a script — importing for unit tests must not
// trigger a real cleanup.
if (isMainModule()) {
  main().catch((err) => {
    console.error("[cleanup-jarvis-kb] FAILED:", err);
    process.exitCode = 1;
  });
}
