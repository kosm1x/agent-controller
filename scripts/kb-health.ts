/**
 * kb-health.ts — read-only taxonomy health report for the Jarvis KB.
 *
 * Invoked by `mc-ctl kb-health`. Operationalizes two of the taxonomy-contract
 * principles from arXiv:2607.26637 (filesystem memory paper, plan B.3,
 * 2026-09-09) as counts the operator can watch week to week. It REPORTS ONLY
 * — reorganizing the KB is an operator decision (the paper's condensing
 * reorganizer halved recall correctness; see plan §5).
 *
 *   P1 sibling distinction — two files in the SAME folder whose basenames
 *      collide once normalized (case, `_` vs `-`, a trailing `-copy` /
 *      `-old` / `-backup` / `(1)` marker, extension): the duplicate
 *      signature actually observed in this KB (`northstar-recurring-tasks.md`
 *      next to `northstar_recurring_tasks.md`). Two metrics were rejected on
 *      the live registry first: token-Jaccard (22,901 pairs — every
 *      date-named series shares its non-date tokens) and stripping `-vN` /
 *      `-N` suffixes (6 of 7 hits were deliberate v1…v5 draft chains and
 *      `sprint-1`/`sprint-2` ordinals). A name-distinction rule must not
 *      punish a series whose names differ BY DESIGN.
 *   P5 structural economy — folders holding exactly one file and no
 *      subfolders: likely over-split.
 *   Size — total registry bytes; warn above KB_SIZE_WARN_BYTES, the range
 *      where the paper measured organization starting to pay for itself in
 *      search cost (so a plateau below it means the tree is not the lever).
 *
 * Reads `jarvis_files` via a read-only handle: safe while mission-control
 * runs; never writes.
 */

import Database from "better-sqlite3";
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface KbFileRow {
  path: string;
  title: string;
  size: number;
}

export interface KbHealthReport {
  files: number;
  bytes: number;
  sizeWarning: boolean;
  /** P1 — same-folder pairs whose normalized basenames collide. */
  nearDuplicates: Array<{ a: string; b: string; key: string }>;
  /** P5 — folders with exactly one file and no subfolders. */
  singleChildFolders: string[];
}

export const KB_SIZE_WARN_BYTES = 15 * 1024 * 1024;

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(SCRIPT_DIR, "..", "data", "mc.db");

/** Collision key of a file's basename: lowercase, extension off, `_`/spaces
 * → `-`, trailing copy markers off (repeatedly, so `plan-old-copy` → `plan`).
 * Version (`-v2`), ordinal (`-2`) and date suffixes are KEPT: they name a
 * series, not a copy. */
export function normalizeName(path: string): string {
  let key = path
    .slice(path.lastIndexOf("/") + 1)
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, "")
    .replace(/\s*\(\d+\)$/, "")
    .replace(/[_\s]+/g, "-");
  for (;;) {
    const next = key.replace(/-(?:copy|old|new|backup|bak|final)$/, "");
    if (next === key) break;
    key = next;
  }
  return key.replace(/-+$/, "");
}

function folderOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

export function computeKbHealth(rows: readonly KbFileRow[]): KbHealthReport {
  const byFolder = new Map<string, KbFileRow[]>();
  for (const r of rows) {
    const f = folderOf(r.path);
    const list = byFolder.get(f);
    if (list) list.push(r);
    else byFolder.set(f, [r]);
  }

  const nearDuplicates: KbHealthReport["nearDuplicates"] = [];
  for (const files of byFolder.values()) {
    const byKey = new Map<string, string[]>();
    for (const r of files) {
      const key = normalizeName(r.path);
      if (key === "") continue;
      const list = byKey.get(key);
      if (list) list.push(r.path);
      else byKey.set(key, [r.path]);
    }
    for (const [key, paths] of byKey) {
      paths.sort();
      for (let i = 1; i < paths.length; i++) {
        nearDuplicates.push({ a: paths[0], b: paths[i], key });
      }
    }
  }
  const cmp = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);
  nearDuplicates.sort((x, y) => cmp(x.a, y.a) || cmp(x.b, y.b));

  const folders = [...byFolder.keys()];
  const singleChildFolders = folders
    .filter((f) => f !== "" && byFolder.get(f)!.length === 1)
    .filter((f) => !folders.some((g) => g !== f && g.startsWith(f + "/")))
    .sort();

  const bytes = rows.reduce((n, r) => n + r.size, 0);
  return {
    files: rows.length,
    bytes,
    sizeWarning: bytes > KB_SIZE_WARN_BYTES,
    nearDuplicates,
    singleChildFolders,
  };
}

function main(): void {
  const db = new Database(DB_PATH, { readonly: true });
  const rows = db
    // CAST → bytes; LENGTH(TEXT) counts characters (4% under on this KB).
    .prepare("SELECT path, title, LENGTH(CAST(content AS BLOB)) AS size FROM jarvis_files")
    .all() as KbFileRow[];
  db.close();
  const report = computeKbHealth(rows);
  const mb = (report.bytes / 1048576).toFixed(2);

  console.log("=== KB taxonomy health (read-only) ===");
  console.log(`Files: ${report.files}   Size: ${mb} MB${report.sizeWarning ? "   WARNING: > 15 MB" : ""}`);
  console.log(`P1 sibling name collisions (normalized basename): ${report.nearDuplicates.length}`);
  for (const d of report.nearDuplicates.slice(0, 20)) {
    console.log(`  [${d.key}]  ${d.a}  <->  ${d.b}`);
  }
  if (report.nearDuplicates.length > 20) console.log(`  … ${report.nearDuplicates.length - 20} more`);
  console.log(`P5 single-file folders: ${report.singleChildFolders.length}`);
  for (const f of report.singleChildFolders.slice(0, 20)) console.log(`  ${f}/`);
  if (report.singleChildFolders.length > 20) console.log(`  … ${report.singleChildFolders.length - 20} more`);
  console.log("No auto-fix: merges/moves are operator decisions.");
}

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};
if (process.argv[1] !== undefined && real(fileURLToPath(import.meta.url)) === real(process.argv[1])) {
  main();
}
