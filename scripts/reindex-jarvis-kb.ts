/**
 * Reindex jarvis_files table from the FS mirror at /root/claude/jarvis-kb/.
 *
 * Architecture: SQLite is source of truth, FS is a mirror. External writers
 * (shell_exec, manual edits, batch migrations) can drop files into the FS
 * that bypass `upsertFile()` and stay invisible to Jarvis's tools. This
 * script walks the FS, finds .md files missing from the DB, and upserts
 * them so the DB regains parity with disk.
 *
 * Usage:
 *   npx tsx scripts/reindex-jarvis-kb.ts            # dry run (default)
 *   npx tsx scripts/reindex-jarvis-kb.ts --apply    # actually upsert
 *
 * The hourly ritual at src/rituals/scheduler.ts#scheduleKbReindex runs the
 * same code automatically — this script is for one-off / verification use.
 */

import { initDatabase, closeDatabase, getDatabase } from "../src/db/index.js";
import { reindexJarvisKb, walkKbDir } from "../src/db/jarvis-reindex.js";
import type { ReindexResult } from "../src/db/jarvis-reindex.js";
import { relative } from "node:path";
import { requireOperatorContext } from "../src/lib/operator-gate.js";
import { isMainModule as isEntryModule } from "../src/lib/is-main-module.js";
import { drainKbWrites } from "../src/db/kb-write-drain.js";

export type ReindexDeps = {
  initDatabase: (path: string) => unknown;
  closeDatabase: () => void;
  getDatabase: () => { prepare: (sql: string) => { all: () => unknown[] } };
  reindexJarvisKb: (opts: { kbRoot: string }) => ReindexResult;
  walkKbDir: (dir: string) => string[];
  drainKbWrites: () => Promise<void>;
  log: (line: string) => void;
};

const realDeps: ReindexDeps = {
  initDatabase,
  closeDatabase,
  getDatabase,
  reindexJarvisKb,
  walkKbDir,
  drainKbWrites,
  log: (line) => console.log(line),
};

function dryRun(deps: ReindexDeps, kbRoot: string, dbPath: string): void {
  deps.initDatabase(dbPath);
  const fsFiles = deps.walkKbDir(kbRoot);
  const fsRel = new Set(fsFiles.map((f) => relative(kbRoot, f)));
  const db = deps.getDatabase();
  const dbPaths = new Set(
    (
      db.prepare("SELECT path FROM jarvis_files").all() as Array<{
        path: string;
      }>
    ).map((r) => r.path),
  );
  const fsOnly = [...fsRel].filter((p) => !dbPaths.has(p));
  deps.log(
    `[reindex] FS=${fsRel.size} DB=${dbPaths.size} fs-only=${fsOnly.length} mode=DRY-RUN`,
  );
  if (fsOnly.length > 0) {
    const byDir = new Map<string, number>();
    for (const p of fsOnly) {
      const top = p.split("/")[0];
      byDir.set(top, (byDir.get(top) ?? 0) + 1);
    }
    for (const [dir, n] of [...byDir.entries()].sort(([, a], [, b]) => b - a)) {
      deps.log(`  ${dir.padEnd(15)} ${n}`);
    }
    deps.log("\n[reindex] dry run — pass --apply to upsert");
  } else {
    deps.log("[reindex] no drift — DB and FS in sync");
  }
  deps.closeDatabase();
}

async function apply(deps: ReindexDeps, kbRoot: string, dbPath: string): Promise<void> {
  deps.initDatabase(dbPath);
  const result = deps.reindexJarvisKb({ kbRoot });
  deps.log(
    `[reindex] FS=${result.fsCount} DB=${result.dbCount} drift=${result.drift} upserted=${result.upserted} errored=${result.errored} (${result.durationMs}ms) mode=APPLY`,
  );
  // upsertFile's syncs + INDEX.md outlive the call (new projects/<x>/ rows change INDEX): drain while the db is open.
  if (result.upserted + result.refreshed > 0) await deps.drainKbWrites();
  deps.closeDatabase();
}

/** Dry run or --apply body; the operator gate is the caller's (main). Env is read per call. */
export async function runReindex(opts: { apply: boolean; deps?: ReindexDeps }): Promise<void> {
  const deps = opts.deps ?? realDeps;
  const kbRoot = process.env.JARVIS_KB_MIRROR_DIR ?? "/root/claude/jarvis-kb";
  const dbPath = process.env.MC_DB_PATH ?? "./data/mc.db";
  if (opts.apply) await apply(deps, kbRoot, dbPath);
  else dryRun(deps, kbRoot, dbPath);
}

/** Operator entry: the S6 item 3c gate runs before any db/KB side effect. */
export async function main(
  argv: string[] = process.argv.slice(2),
  deps: { requireOperatorContext: (tag: string, opts: { tty: boolean }) => void; reindex?: ReindexDeps } = {
    requireOperatorContext,
  },
): Promise<void> {
  deps.requireOperatorContext("reindex-jarvis-kb", { tty: false });
  await runReindex({ apply: argv.includes("--apply"), deps: deps.reindex });
}

/** True only when this file is the process entry point (never when a test imports it). */
export function isMainModule(): boolean {
  return isEntryModule(import.meta.url);
}

if (isMainModule()) await main();
