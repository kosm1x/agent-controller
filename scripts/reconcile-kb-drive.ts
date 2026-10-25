/**
 * reconcile-kb-drive.ts — trash Google Drive files orphaned by KB deletes.
 *
 * deleteFile() trashes a row's Drive copy inline, but a bulk DB-side cleanup
 * (cleanup-jarvis-kb.ts) deliberately skips the Drive leg — 1,000+ rate-limited
 * API calls do not belong in that path. The result: drive_file_map rows whose
 * `path` no longer exists in jarvis_files. This script is that follow-up — it
 * trashes each orphaned Drive file and drops its map row.
 *
 *   npx tsx --env-file=.env scripts/reconcile-kb-drive.ts                              # dry run: every orphan (overview)
 *   npx tsx --env-file=.env scripts/reconcile-kb-drive.ts --prefix=<p> [--limit=<n>]   # dry run: one batch
 *   npx tsx --env-file=.env scripts/reconcile-kb-drive.ts --prefix=<p> --limit=<n> --apply   # trash that batch
 *
 *   --prefix=<p>  case-sensitive `startsWith` on the map path (`/`, `root/`,
 *                 `workspace/`, `knowledge/execution-patterns/2026-05`, ...).
 *   --limit=<n>   at most n orphans (digits only), in path order. Applied rows
 *                 leave the map, so a rerun with the same flags takes the next n.
 *   --apply       REFUSED (exit 2) unless --prefix is non-empty, --limit is
 *                 1..300 and the open db is the live mc.db: there is never a
 *                 full-Drive run (queue 3z). Each path is re-checked against
 *                 jarvis_files right before its trash (SKIP-LIVE if re-created).
 *
 * Env: nothing loads dotenv; src/google/auth.ts reads GOOGLE_CLIENT_ID,
 * GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN from process.env, so pass
 * `--env-file=.env` to tsx as above (never shell-source .env). Resumable: a
 * map row is dropped only AFTER its Drive file is settled, so a re-run retries
 * exactly the failures. Drive "trash" is recoverable for 30 days.
 */

import { initDatabase, getDatabase, closeDatabase } from "../src/db/index.js";
import { isLiveDatabaseFile, LIVE_DB_PATH, openDbFile } from "../src/db/live-db.js";
import { googleFetch } from "../src/google/client.js";
import { requireOperatorContext } from "../src/lib/operator-gate.js";
import { isMainModule } from "../src/lib/is-main-module.js";

const DB_PATH = process.env.MC_DB_PATH ?? "./data/mc.db";
const CONCURRENCY = 5;
/** Most Drive files one --apply run may trash. */
export const APPLY_LIMIT_MAX = 300;
/** Dry run without --limit lists only this many paths. */
const DRY_RUN_SHOW = 15;

export interface Orphan {
  path: string;
  drive_id: string;
}

export interface Flags {
  apply: boolean;
  prefix?: string;
  limit?: number;
  unknown: string[];
}

/** Pure: argv (without node + script) → flags. Only the `--flag=value` form is recognised; a limit is digits only. */
export function parseFlags(argv: string[]): Flags {
  const flags: Flags = { apply: false, unknown: [] };
  for (const a of argv) {
    if (a === "--apply") flags.apply = true;
    else if (a.startsWith("--prefix=")) flags.prefix = a.slice("--prefix=".length);
    else if (a.startsWith("--limit=")) {
      const v = a.slice("--limit=".length);
      flags.limit = /^\d+$/.test(v) ? Number(v) : Number.NaN;
    } else flags.unknown.push(a);
  }
  return flags;
}

/** Pure: why --apply must not run with these flags, or null. */
export function validateApplyFlags(f: { prefix?: string; limit?: number }): string | null {
  if (f.prefix === undefined || f.prefix === "")
    return "--apply needs a non-empty --prefix=<kb path prefix> (no full-Drive run)";
  if (f.limit === undefined) return `--apply needs --limit=<n> (1..${APPLY_LIMIT_MAX})`;
  if (!Number.isInteger(f.limit) || f.limit < 1 || f.limit > APPLY_LIMIT_MAX)
    return `--limit must be an integer 1..${APPLY_LIMIT_MAX} with --apply (got ${f.limit})`;
  return null;
}

/** Pure: why this invocation (dry run or apply) must not run, or null. */
export function validateFlags(f: Flags): string | null {
  if (f.unknown.length > 0)
    return `unknown argument(s): ${f.unknown.join(" ")} (use --prefix=<p> --limit=<n> [--apply])`;
  if (f.limit !== undefined && (!Number.isInteger(f.limit) || f.limit < 1))
    return `--limit must be a positive integer (got ${f.limit})`;
  return f.apply ? validateApplyFlags(f) : null;
}

/** Pure: the orphans under `prefix` (all when absent or empty), the first `limit` of them. */
export function selectOrphans(
  rows: Orphan[],
  opts: { prefix?: string; limit?: number },
): { matched: number; selected: Orphan[] } {
  const prefix = opts.prefix ?? "";
  const hits = rows.filter((o) => o.path.startsWith(prefix));
  return {
    matched: hits.length,
    selected: opts.limit === undefined ? hits : hits.slice(0, opts.limit),
  };
}

/** Every side effect of a run, injected so the run is testable without a db or Google. */
export interface RunDeps {
  /** drive_file_map rows with no jarvis_files row, in path order. */
  listOrphans(): Orphan[];
  /** True when `path` has a jarvis_files row NOW (re-created after the listing). */
  isLiveKbPath(path: string): boolean;
  /** True when the open db is the live mc.db (the one that owns the Drive copy). */
  isLiveDb(): boolean;
  trash(o: Orphan): Promise<"trashed" | "gone">;
  /** Drop the map row — only this exact (path, drive_id) pair. */
  drop(o: Orphan): void;
  log(line: string): void;
  warn(line: string): void;
}

export interface RunResult {
  exitCode: number;
  /** The rows this run listed (dry run) or worked on (apply). */
  planned: Orphan[];
  trashed: number;
  gone: number;
  skippedLive: number;
  failed: number;
}

/** The db-backed RunDeps parts (SQL only); trash/isLiveDb/log come from main. */
export function dbDeps(
  db: ReturnType<typeof getDatabase>,
): Pick<RunDeps, "listOrphans" | "isLiveKbPath" | "drop"> {
  const list = db.prepare(
    `SELECT path, drive_id FROM drive_file_map m
      WHERE NOT EXISTS (SELECT 1 FROM jarvis_files f WHERE f.path = m.path)
      ORDER BY path`,
  );
  const live = db.prepare("SELECT 1 FROM jarvis_files WHERE path = ?");
  const dropRow = db.prepare(
    "DELETE FROM drive_file_map WHERE path = ? AND drive_id = ?",
  );
  return {
    listOrphans: () => list.all() as Orphan[],
    isLiveKbPath: (path) => live.get(path) !== undefined,
    drop: (o) => void dropRow.run(o.path, o.drive_id),
  };
}

/** One run: dry run lists, apply trashes exactly the rows the same dry run lists. */
export async function runReconcile(flags: Flags, deps: RunDeps): Promise<RunResult> {
  const result: RunResult = { exitCode: 0, planned: [], trashed: 0, gone: 0, skippedLive: 0, failed: 0 };
  const { log, warn } = deps;

  if (flags.apply && !deps.isLiveDb()) {
    warn(
      `[reconcile-kb-drive] REFUSED: --apply needs the live db: the open db is not ${LIVE_DB_PATH} (run from the repo root; leave MC_DB_PATH unset)`,
    );
    result.exitCode = 2;
    return result;
  }

  const all = deps.listOrphans();
  const { matched, selected: orphans } = selectOrphans(all, flags);
  result.planned = orphans;

  log(`\n=== reconcile-kb-drive — ${flags.apply ? "APPLY" : "DRY-RUN"} ===`);
  log(`Drive orphans (in drive_file_map, not in jarvis_files): ${all.length}`);
  log(`prefix:  ${flags.prefix ? JSON.stringify(flags.prefix) : "(none — all orphans)"}`);
  log(`limit:   ${flags.limit ?? "(none)"}`);
  log(`matched: ${matched}`);

  if (!flags.apply) {
    const shown =
      flags.limit === undefined ? orphans.slice(0, DRY_RUN_SHOW) : orphans;
    for (const o of shown) log(`  TRASH  ${o.path}`);
    if (orphans.length > shown.length)
      log(`  ... and ${orphans.length - shown.length} more`);
    log(
      `\nDry run — no Drive calls made. Would trash ${orphans.length}.` +
        ` Re-run with --prefix=<p> --limit=<n> --apply.`,
    );
    return result;
  }

  log(`will trash: ${orphans.length}`);
  if (orphans.length === 0) {
    log(`\nNothing to trash under this prefix.`);
    return result;
  }

  let done = 0;
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < orphans.length) {
      const o = orphans[cursor++];
      try {
        if (deps.isLiveKbPath(o.path)) {
          // Re-created since the listing: its Drive copy is live again.
          result.skippedLive++;
          log(`  SKIP-LIVE ${o.path}`);
        } else {
          const r = await deps.trash(o);
          if (r === "trashed") result.trashed++;
          else result.gone++;
          deps.drop(o); // only after Drive is settled — keeps re-runs exact
        }
      } catch (err) {
        result.failed++;
        warn(`  ERROR ${o.path}: ${err instanceof Error ? err.message : err}`);
      }
      if (++done % 100 === 0) log(`  ... ${done}/${orphans.length}`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const after = deps.listOrphans();
  const remaining = selectOrphans(after, { prefix: flags.prefix }).matched;

  log(
    `\n[done] trashed=${result.trashed}  already-gone=${result.gone}  skipped-live=${result.skippedLive}  failed=${result.failed}`,
  );
  log(
    `Drive orphans remaining under prefix: ${remaining} (all prefixes: ${after.length})` +
      (remaining > 0
        ? "  — re-run the same command for the next batch / to retry failures."
        : "  — clean."),
  );
  return result;
}

/** Trash one Drive file. A 404 means it is already gone — treated as success. */
async function trashOne(o: Orphan): Promise<"trashed" | "gone"> {
  try {
    await googleFetch(
      `https://www.googleapis.com/drive/v3/files/${o.drive_id}`,
      {
        method: "PATCH",
        body: { trashed: true },
      },
    );
    return "trashed";
  } catch (err) {
    const msg = (
      err instanceof Error ? err.message : String(err)
    ).toLowerCase();
    if (msg.includes("404") || msg.includes("not found")) return "gone";
    throw err;
  }
}

/** The deps main() runs with; `db` is the open singleton (openDbFile reads the same one). */
export function buildMainDeps(db: ReturnType<typeof getDatabase>): RunDeps {
  return {
    ...dbDeps(db),
    isLiveDb: () => isLiveDatabaseFile(openDbFile(), LIVE_DB_PATH),
    trash: trashOne,
    log: (l) => console.log(l),
    warn: (l) => console.warn(l),
  };
}

async function main(flags: Flags): Promise<number> {
  initDatabase(DB_PATH);
  try {
    const r = await runReconcile(flags, buildMainDeps(getDatabase()));
    return r.exitCode;
  } finally {
    closeDatabase();
  }
}

if (isMainModule(import.meta.url)) {
  // S6 item 3c: operator context only (login session or operator unit), before any db/KB side effect.
  requireOperatorContext("reconcile-kb-drive", { tty: false });
  const flags = parseFlags(process.argv.slice(2));
  const refusal = validateFlags(flags);
  if (refusal) {
    console.error(`[reconcile-kb-drive] REFUSED: ${refusal}`);
    process.exit(2);
  }
  main(flags).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error("[reconcile-kb-drive] FAILED:", err);
      process.exitCode = 1;
    },
  );
}
