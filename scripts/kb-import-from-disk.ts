/**
 * Import an operator's hand edit of a KB file from the disk mirror into its existing
 * jarvis_files row. Managed namespaces (MANAGED_NAMESPACES in src/db/jarvis-reindex.ts)
 * are never refreshed by the hourly disk walk, so a hand edit of e.g. `directives/` stays
 * on disk only until it goes through upsertFile here. This tool never creates rows.
 * The import is a user edit: updated_at AND user_edit_time bump. Two passes: one FAIL
 * path means nothing is written. pgvector/Drive copies refresh only when the run has the
 * service env (COMMIT_DB_KEY, DRIVE_KB_FOLDER_ID): run it from a subshell that sources it.
 *
 * Usage:
 *   npx tsx scripts/kb-import-from-disk.ts --path <rel> [--path <rel> …]           # dry run
 *   npx tsx scripts/kb-import-from-disk.ts --path <rel> [--path <rel> …] --apply   # write + verify
 */

import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { initDatabase, closeDatabase } from "../src/db/index.js";
import { getFile, getKbMirrorWriteDir, upsertFile } from "../src/db/jarvis-fs.js";
import { requireOperatorContext } from "../src/lib/operator-gate.js";

type Plan = { path: string; fail: string | null; disk: string; changed: number };

function refusal(path: string): string | null {
  if (path.startsWith("/") || path.split("/").includes("..")) return "path must be relative inside the KB";
  if (path.startsWith("NorthStar/")) return "NorthStar/ is a retired namespace";
  if (/^skills\/[^/]+\/SKILL\.md$/.test(path)) return "skills/<name>/SKILL.md is critic-gated; not imported here";
  return null;
}

function plan(path: string, mirrorDir: string | null): Plan {
  const p: Plan = { path, fail: refusal(path), disk: "", changed: 0 };
  if (p.fail) return p;
  const row = getFile(path);
  if (!row) return { ...p, fail: "no registry row; new files register through upsertFile with an explicit qualifier" };
  if (mirrorDir === null) return { ...p, fail: "no mirror for this db" };
  const file = join(mirrorDir, path);
  try {
    // The mirror file itself, never what a link points at (no content is printed for a refusal).
    const st = lstatSync(file);
    if (st.isSymbolicLink()) return { ...p, fail: "disk file is a symlink" };
    if (!st.isFile()) return { ...p, fail: "disk path is not a regular file" };
    if (st.nlink > 1) return { ...p, fail: "disk file has more than one hard link" };
    if (!realpathSync(file).startsWith(realpathSync(mirrorDir) + sep)) {
      return { ...p, fail: "disk file resolves outside the mirror" };
    }
    p.disk = readFileSync(file, "utf-8");
  } catch {
    return { ...p, fail: "disk file missing or unreadable" };
  }
  const before = row.content.split("\n");
  const after = p.disk.split("\n");
  for (let i = 0; i < Math.max(before.length, after.length); i++) if (before[i] !== after[i]) p.changed++;
  return p;
}

export function runImport(opts: { apply: boolean; paths: string[] }): { ok: boolean } {
  const mirrorDir = getKbMirrorWriteDir();
  const plans = opts.paths.map((path) => plan(path, mirrorDir));
  const blocked = plans.some((p) => p.fail !== null);
  let ok = !blocked;
  for (const p of plans) {
    const row = p.fail ? null : getFile(p.path);
    if (!row) {
      console.log(`FAIL ${p.path} ${p.fail ?? "no registry row"}`);
      continue;
    }
    if (row.content === p.disk) {
      console.log(`PASS ${p.path} nothing-to-do`);
      continue;
    }
    const before = row.content.split("\n");
    const after = p.disk.split("\n");
    for (let i = 0; i < Math.max(before.length, after.length); i++) {
      if (before[i] === after[i]) continue;
      if (before[i] !== undefined) console.log(`  ${p.path}:${i + 1} - ${before[i]}`);
      if (after[i] !== undefined) console.log(`  ${p.path}:${i + 1} + ${after[i]}`);
    }
    const counts = `changedLines=${p.changed} lines=${before.length}->${after.length}`;
    if (!opts.apply || blocked) {
      console.log(`${blocked ? "FAIL" : "PASS"} ${p.path} ${counts}${blocked ? " (not written: a path failed)" : " (dry run)"}`);
      continue;
    }
    const tags = JSON.parse(row.tags) as string[];
    const related = JSON.parse(row.related_to) as string[];
    upsertFile(p.path, row.title, p.disk, tags, row.qualifier, row.priority, row.condition, related);
    const verified = getFile(p.path)?.content === p.disk;
    if (!verified) ok = false;
    console.log(`${verified ? "PASS" : "FAIL"} ${p.path} ${counts}${verified ? " imported" : " (row differs after write)"}`);
  }
  return { ok };
}

/** `--path <rel>` (repeatable) and `--apply`; anything else is an error. */
export function parseArgs(argv: string[]): { paths: string[]; apply: boolean } | { error: string } {
  const paths: string[] = [];
  let apply = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--apply") apply = true;
    else if (argv[i] === "--path" && argv[i + 1] && !argv[i + 1]!.startsWith("--")) paths.push(argv[++i]!);
    else return { error: `unexpected argument: ${argv[i]}` };
  }
  return paths.length > 0 ? { paths, apply } : { error: "at least one --path <rel> is required" };
}

type MainDeps = {
  requireOperatorContext: (tag: string, opts: { tty: boolean }) => void;
  initDatabase: (path: string) => unknown;
  closeDatabase: () => void;
  runImport: (opts: { apply: boolean; paths: string[] }) => { ok: boolean };
};

/** Operator entry: the gate runs before any db/KB side effect. Returns the exit code. */
export function main(
  argv: string[] = process.argv.slice(2),
  deps: MainDeps = { requireOperatorContext, initDatabase, closeDatabase, runImport },
): number {
  deps.requireOperatorContext("kb-import-from-disk", { tty: false });
  const args = parseArgs(argv);
  if ("error" in args) {
    console.error(`[kb-import] ${args.error}`);
    return 1;
  }
  deps.initDatabase(process.env.MC_DB_PATH ?? "./data/mc.db");
  const { ok } = deps.runImport(args);
  deps.closeDatabase();
  if (!args.apply) console.log("[kb-import] dry run — pass --apply to write");
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

// No process.exit: the fire-and-forget pgvector/Drive syncs drain before exit.
if (isMainModule()) process.exitCode = main();
