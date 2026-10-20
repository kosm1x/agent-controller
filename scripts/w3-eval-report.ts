/**
 * V9 W3 step 2 — `mc-ctl eval [days] [--json]`: the read-only internal eval
 * report (src/eval/queries.ts + src/eval/report.ts; inventory
 * docs/planning/v9-w3-inventory-2026-10-09.md §7, rulings 2026-10-18).
 *
 * READ-ONLY: the operator gate runs first, then the db opens with
 * better-sqlite3 `{ readonly: true, fileMustExist: true }`; never
 * `initDatabase` / `getDatabase`, no writes, no LLM calls. Past 90 d it also
 * reads `<db dir>/archive/tasks-retention-*.jsonl.gz` (read-only). Operator
 * W1 labels come from docs/planning/v9-w1-labels.md next to this script's
 * repo (read-only; a missing file means no labels).
 *
 * Exit codes: 0 report printed · 1 bad args · 2 operator gate refused (the
 * gate exits the process) · 3 db missing or a query failed.
 *
 * Usage: npx tsx scripts/w3-eval-report.ts [days | --days N] [--json] [--db <path>]
 */

import Database from "better-sqlite3";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { requireOperatorContext } from "../src/lib/operator-gate.js";
import { readW1Labels } from "../src/eval/labels.js";
import { collectEval, liveTaskDays } from "../src/eval/queries.js";
import { buildReportModel, renderJson, renderMarkdown } from "../src/eval/report.js";

export const DEFAULT_DAYS = 90;

export function parseArgs(argv: string[]): { days: number; json: boolean; db: string | null } | { error: string } {
  let days = DEFAULT_DAYS;
  let json = false;
  let db: string | null = null;
  let sawDays = false;
  const setDays = (v: string | undefined): string | null => {
    if (sawDays) return "days given twice";
    if (!v || !/^[1-9]\d{0,3}$/.test(v)) return "days must be a positive integer (1-9999)";
    sawDays = true;
    days = Number(v);
    return null;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    let err: string | null = null;
    if (a === "--json") json = true;
    else if (a === "--days") err = setDays(argv[++i]);
    else if (a.startsWith("--days=")) err = setDays(a.slice("--days=".length));
    else if (a === "--db") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) return { error: "--db needs a path" };
      db = v;
    } else if (a.startsWith("-")) return { error: `unknown flag ${a}` };
    else err = setDays(a);
    if (err) return { error: err };
  }
  return { days, json, db };
}

export interface MainDeps {
  requireOperatorContext: (tag: string, opts: { tty: boolean }) => void;
  openDb: (path: string) => Database.Database;
  now: () => Date;
  print: (s: string) => void;
  env: NodeJS.ProcessEnv;
  labelsPath: string;
}

export const defaultDeps: MainDeps = {
  requireOperatorContext,
  openDb: (path) => new Database(path, { readonly: true, fileMustExist: true }),
  now: () => new Date(),
  print: (s) => process.stdout.write(s),
  env: process.env,
  labelsPath: join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "planning", "v9-w1-labels.md"),
};

/**
 * Where the live-retention value came from. `mc-ctl eval` sets
 * W3_LIVE_DAYS_SOURCE (service = the key read from the service's .env,
 * default = absent there); a direct run reports its own shell env.
 */
export function liveDaysSource(env: NodeJS.ProcessEnv): "service env" | "shell env" | "default" {
  if (env.W3_LIVE_DAYS_SOURCE === "service") return "service env";
  if (env.W3_LIVE_DAYS_SOURCE === "default") return "default";
  return env.TASKS_RETENTION_DAYS ? "shell env" : "default";
}

/** Operator entry: gate → args → read-only open → report. Returns the exit code. */
export function main(argv: string[] = process.argv.slice(2), deps: MainDeps = defaultDeps): number {
  deps.requireOperatorContext("w3-eval-report", { tty: false });
  const args = parseArgs(argv);
  if ("error" in args) {
    console.error(`[w3-eval-report] ${args.error}`);
    console.error("usage: mc-ctl eval [days] [--json]   |   scripts/w3-eval-report.ts [--days N] [--json] [--db <path>]");
    return 1;
  }
  const dbPath = args.db ?? deps.env.MC_DB_PATH ?? "./data/mc.db";
  let db: Database.Database | null = null;
  let text: string;
  try {
    db = deps.openDb(dbPath);
    const data = collectEval(db, {
      days: args.days,
      now: deps.now(),
      archiveDir: join(dirname(dbPath), "archive"),
      labels: readW1Labels(deps.labelsPath),
      liveDays: liveTaskDays(deps.env),
      liveDaysSource: liveDaysSource(deps.env),
    });
    const model = buildReportModel(data);
    text = args.json ? renderJson(model) : renderMarkdown(model);
  } catch (err) {
    console.error(`[w3-eval-report] ${dbPath}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    return 3;
  } finally {
    db?.close();
  }
  deps.print(text);
  return 0;
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

if (isMainModule()) process.exitCode = main();
