/**
 * S6 WS1 — `mc-ctl project <slug> [--days 30]`: one project's record, from
 * its record-declared schedules (spec docs/planning/s6-project-contract-spec-2026-10-11.md §4).
 *
 * READ-ONLY: opens the db with better-sqlite3 `{ readonly: true,
 * fileMustExist: true }` and never calls `initDatabase` / `getDatabase`.
 * Numbers, ids and the record's own fields only — never a task title,
 * description, output, schedule prompt or `result_summary`.
 *
 * Attribution in this slice is BY SCHEDULE ONLY: tasks tagged
 * `schedule:<id>` for an id in the record's `schedules[]`, plus their
 * sub-tasks (`parent_task_id`, any depth). There are no `project_slug`
 * columns yet (WS2), so chat, ritual and inbound work is not counted.
 */

import Database from "better-sqlite3";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  STALE_DAYS,
  SCAN_WINDOW_DAYS,
  isStallExempt,
  lastDayLogMention,
  loadDatedDayLogs,
  matchTermsFor,
} from "../src/detection/stalled-projects.js";
import { projectRecordRelPath } from "../src/projects/record.js";

export const UNAUDITED_COST_LINE =
  "(unaudited — run ./mc-ctl audit-claim before quoting)";

type Db = Database.Database;

interface Row {
  slug: string;
  name: string;
  status: string;
  config: string | null;
}

function parseConfig(raw: string | null): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(raw ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

const placeholders = (n: number): string => Array(n).fill("?").join(", ");

/** Build the report lines; `null` when the slug has no row. Pure over `db`. */
export function buildProjectReport(db: Db, slug: string, days = 30): string[] | null {
  const row = db
    .prepare("SELECT slug, name, status, config FROM projects WHERE slug = ?")
    .get(slug) as Row | undefined;
  if (!row) return null;
  const config = parseConfig(row.config);
  const schedules = strings(config.schedules);
  const repos = Array.isArray(config.repos)
    ? (config.repos as Array<{ path?: unknown; role?: unknown }>)
        .filter((r) => r && typeof r.path === "string")
        .map((r) => `${String(r.path)} (${typeof r.role === "string" ? r.role : "?"})`)
    : [];
  const hasRecord = !!db
    .prepare("SELECT 1 FROM jarvis_files WHERE path = ?")
    .get(projectRecordRelPath(slug));
  const win = `-${days} days`;

  const out: string[] = [];
  out.push(`=== Project ${slug} (read-only) ===`);
  out.push(
    `Attribution: by schedule only (tag schedule:<id> + sub-tasks); no project_slug columns until WS2 — chat, ritual and inbound work is not counted. Windows: 7 d / ${days} d.`,
  );
  out.push("");
  out.push("Record");
  out.push(`  record: ${hasRecord ? "yes" : "no"} (${projectRecordRelPath(slug)})`);
  out.push(`  status: ${row.status}`);
  out.push(`  repos: ${repos.length === 0 ? "none" : repos.join(", ")}`);
  out.push(`  schedules: ${schedules.length === 0 ? "none" : schedules.join(", ")}`);
  out.push(`  kb_folder: ${typeof config.kb_folder === "string" ? config.kb_folder : "(unset)"}`);
  out.push(`  kb_readme: ${typeof config.kb_readme === "string" ? config.kb_readme : "(unset)"}`);

  out.push("");
  out.push(`Schedule runs (${days} d)`);
  if (schedules.length === 0) out.push("  (the record lists no schedules)");
  for (const id of schedules) {
    const exists = db
      .prepare("SELECT active FROM scheduled_tasks WHERE schedule_id = ?")
      .get(id) as { active: number } | undefined;
    const r = db
      .prepare(
        `SELECT COUNT(*) AS n,
                COALESCE(SUM(status = 'failed'), 0) AS failed,
                COALESCE(SUM(status = 'delivery_miss'), 0) AS delivery_miss
           FROM schedule_runs WHERE schedule_id = ? AND spawned_at >= datetime('now', ?)`,
      )
      .get(id, win) as { n: number; failed: number; delivery_miss: number };
    const last = db
      .prepare("SELECT MAX(spawned_at) AS t FROM schedule_runs WHERE schedule_id = ?")
      .get(id) as { t: string | null };
    out.push(
      `  ${id}: ${exists ? (exists.active ? "active" : "inactive") : "MISSING from scheduled_tasks"} · runs=${r.n} failed=${r.failed} delivery_miss=${r.delivery_miss} · last run=${last.t ?? "never"}`,
    );
  }

  // Tasks: schedule-tagged roots in the window, plus their sub-tasks.
  const ids: string[] = [];
  if (schedules.length > 0) {
    const tags = schedules.map((s) => `schedule:${s}`);
    const rows = db
      .prepare(
        `WITH RECURSIVE roots(task_id) AS (
           SELECT DISTINCT t.task_id FROM tasks t, json_each(t.metadata, '$.tags') j
            WHERE json_valid(t.metadata) AND json_type(t.metadata, '$.tags') = 'array'
              AND t.created_at >= datetime('now', ?)
              AND j.value IN (${placeholders(tags.length)})
         ), tree(task_id) AS (
           SELECT task_id FROM roots
           UNION
           SELECT c.task_id FROM tasks c JOIN tree p ON c.parent_task_id = p.task_id
         )
         SELECT task_id FROM tree`,
      )
      .all(win, ...tags) as Array<{ task_id: string }>;
    for (const r of rows) ids.push(r.task_id);
  }
  out.push("");
  out.push("Tasks by status (7 d · " + days + " d)");
  const inIds = (sql: string, ...params: unknown[]) =>
    ids.length === 0
      ? []
      : (db
          .prepare(sql.replace("__IDS__", placeholders(ids.length)))
          .all(...params, ...ids) as Array<Record<string, unknown>>);
  const byStatus = inIds(
    `SELECT status,
            COALESCE(SUM(created_at >= datetime('now', '-7 days')), 0) AS d7,
            COUNT(*) AS dn
       FROM tasks WHERE task_id IN (__IDS__) GROUP BY status ORDER BY status`,
  );
  if (byStatus.length === 0) out.push("  (none)");
  for (const s of byStatus) out.push(`  ${String(s.status)}: ${Number(s.d7)} · ${Number(s.dn)}`);
  out.push(`  total: ${byStatus.reduce((a, s) => a + Number(s.d7), 0)} · ${ids.length}`);

  out.push("");
  out.push(`Gates (${days} d)`);
  const gates = inIds(
    `SELECT state, COUNT(*) AS n FROM task_gates WHERE task_id IN (__IDS__) GROUP BY state`,
  );
  const g = (k: string) => Number(gates.find((x) => x.state === k)?.n ?? 0);
  out.push(`  met=${g("met")} failed=${g("failed")} abandoned=${g("abandoned")} pending=${g("pending")}`);

  out.push("");
  out.push(`Cost (${days} d)`);
  const cost = inIds(
    `SELECT COALESCE(SUM(cost_usd), 0) AS usd, COUNT(*) AS n FROM cost_ledger WHERE task_id IN (__IDS__)`,
  )[0];
  out.push(
    `  $${Number(cost?.usd ?? 0).toFixed(4)} over ${Number(cost?.n ?? 0)} ledger rows ${UNAUDITED_COST_LINE}`,
  );

  out.push("");
  out.push(`Day-log (newest ${SCAN_WINDOW_DAYS} day-logs; slug, name, distinctive tokens and record aliases)`);
  const dated = loadDatedDayLogs(db);
  const mention = lastDayLogMention(matchTermsFor(row, { aliases: true }), dated);
  out.push(
    `  last mention: ${mention ? `${mention.date} (${mention.daysSinceMention} d before the newest day-log)` : dated.length === 0 ? "no day-logs" : `none in the newest ${SCAN_WINDOW_DAYS}`}`,
  );
  let stall: string;
  if (isStallExempt(row.config)) stall = "exempt (stall_exempt)";
  else if (row.status !== "active") stall = `n/a (status ${row.status})`;
  else if (dated.length === 0) stall = "unknown (no day-logs)";
  else if (mention && mention.daysSinceMention <= STALE_DAYS) stall = "moving";
  else stall = `stalled (> ${STALE_DAYS} d)`;
  out.push(`  stall state: ${stall}`);
  return out;
}

export function parseArgs(argv: string[]): { slug: string; days: number } | { error: string } {
  let slug = "";
  let days = 30;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--days" || a.startsWith("--days=")) {
      const v = a === "--days" ? argv[++i] : a.slice("--days=".length);
      if (!v || !/^[1-9]\d{0,3}$/.test(v)) return { error: "--days must be a positive integer" };
      days = Number(v);
    } else if (a.startsWith("--")) return { error: `unknown flag ${a}` };
    else if (!slug) slug = a;
    else return { error: `unexpected argument ${a}` };
  }
  if (!slug) return { error: "usage: mc-ctl project <slug> [--days N]" };
  return { slug, days };
}

/** Exit code: 0 printed, 1 no such project / bad args. */
export function runProjectReport(argv: string[], dbPath: string, print = console.log): number {
  const args = parseArgs(argv);
  if ("error" in args) {
    print(args.error);
    return 1;
  }
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const lines = buildProjectReport(db, args.slug, args.days);
    if (!lines) {
      print(`No project "${args.slug}" in the projects table.`);
      return 1;
    }
    for (const l of lines) print(l);
    return 0;
  } finally {
    db.close();
  }
}

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};
if (process.argv[1] !== undefined && real(fileURLToPath(import.meta.url)) === real(process.argv[1])) {
  const dbPath = process.env.MC_DB_PATH ?? resolve(process.cwd(), "data/mc.db");
  process.exit(runProjectReport(process.argv.slice(2), dbPath));
}
