/**
 * S6 WS1 — `mc-ctl project <slug> [--days 30]`: one project's record, from
 * its record-declared schedules (spec docs/planning/s6-project-contract-spec-2026-10-11.md §4).
 *
 * READ-ONLY: opens the db with better-sqlite3 `{ readonly: true,
 * fileMustExist: true }` and never calls `initDatabase` / `getDatabase`.
 * Numbers, ids and the record's own fields only — never a task title,
 * description, output, schedule prompt or `result_summary`.
 *
 * Attribution (S6 WS2): the task set is `tasks.project_slug = <slug>`
 * (set once at insert since schema v9) UNION the schedule-tag path — tasks
 * tagged `schedule:<id>` for an id in the record's `schedules[]` — which
 * still covers rows inserted before the columns existed; plus sub-tasks of
 * either (`parent_task_id`, any depth). Deduped by task_id; gates and cost
 * follow the same set. No backfill writes: the UNION is the back-attribution.
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
import { deriveProjectScopeGroups } from "../src/projects/scope-groups.js";
import { VALID_GROUPS } from "../src/messaging/scope-classifier.js";
import { DEFAULT_SCOPE_PATTERNS } from "../src/messaging/scope.js";
import { PROJECT_SOURCES } from "../src/projects/attribution.js";

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
  // The columns arrive with schema v9 at deploy; before it the report runs
  // on the schedule-tag path alone instead of failing.
  const hasColumns = (
    db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>
  ).some((c) => c.name === "project_slug");
  const since = hasColumns
    ? (db
        .prepare("SELECT MIN(created_at) AS t FROM tasks WHERE project_slug IS NOT NULL")
        .get() as { t: string | null }).t
    : null;

  // S6 ruling 5a: the parent relation, ids only (no roll-up in this slice).
  const parent = typeof config.parent === "string" ? config.parent : null;
  const children = (
    db
      .prepare(
        "SELECT slug FROM projects WHERE json_valid(config) AND json_extract(config, '$.parent') = ? ORDER BY slug",
      )
      .all(slug) as Array<{ slug: string }>
  ).map((r) => r.slug);

  const out: string[] = [];
  out.push(`=== Project ${slug} (read-only) ===`);
  out.push(
    `Attribution: tasks.project_slug UNION tag schedule:<id> (+ sub-tasks), deduped by task_id. Attribution columns: ${hasColumns ? `present, first attributed task ${since ?? "none yet"}` : "absent (schema < v9)"}; older rows are schedule-tag only. Windows: 7 d / ${days} d.${children.length > 0 ? " children's tasks are not rolled up." : ""}`,
  );
  out.push("");
  out.push("Record");
  out.push(`  record: ${hasRecord ? "yes" : "no"} (${projectRecordRelPath(slug)})`);
  out.push(`  status: ${row.status}`);
  out.push(`  repos: ${repos.length === 0 ? "none" : repos.join(", ")}`);
  out.push(`  schedules: ${schedules.length === 0 ? "none" : schedules.join(", ")}`);
  out.push(`  kb_folder: ${typeof config.kb_folder === "string" ? config.kb_folder : "(unset)"}`);
  out.push(`  kb_readme: ${typeof config.kb_readme === "string" ? config.kb_readme : "(unset)"}`);
  if (parent !== null) {
    const hasRow = !!db.prepare("SELECT 1 FROM projects WHERE slug = ?").get(parent);
    out.push(`  parent: ${parent} (row: ${hasRow ? "yes" : "no"})`);
  }
  out.push(`  children: ${children.length}${children.length > 0 ? ` [${children.join(", ")}]` : ""}`);
  // S6 WS3: record-declared MCP servers (ids only) and the derived scope group.
  const caps = config.capabilities as { mcp?: unknown } | undefined;
  const mcpIds = Array.isArray(caps?.mcp)
    ? (caps.mcp as Array<{ id?: unknown }>).map((e) => (typeof e?.id === "string" ? e.id : slug))
    : [];
  const loadable = config.trusted === true ? mcpIds : [];
  out.push(`  mcp: ${mcpIds.length} declared, ${loadable.length} loadable (trusted), ids: [${mcpIds.join(", ")}]`);
  const routing = config.routing as { summary?: unknown } | undefined;
  const scope = deriveProjectScopeGroups(
    row.status === "active"
      ? [{ slug, serverIds: loadable, routing: typeof routing?.summary === "string" ? { summary: routing.summary } : undefined }]
      : [],
    new Set([...VALID_GROUPS, ...DEFAULT_SCOPE_PATTERNS.map((p) => p.group)]),
  );
  out.push(`  scope group: ${scope.groups.length > 0 ? "yes" : "no"}`);

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

  // Tasks: column-attributed roots UNION schedule-tagged roots in the
  // window, plus their sub-tasks; UNION dedupes by task_id.
  const ids: string[] = [];
  if (schedules.length > 0 || hasColumns) {
    const tags = schedules.map((s) => `schedule:${s}`);
    const roots: string[] = [];
    const params: unknown[] = [];
    if (hasColumns) {
      roots.push(
        "SELECT task_id FROM tasks WHERE project_slug = ? AND created_at >= datetime('now', ?)",
      );
      params.push(slug, win);
    }
    if (tags.length > 0) {
      roots.push(
        `SELECT t.task_id FROM tasks t, json_each(t.metadata, '$.tags') j
          WHERE json_valid(t.metadata) AND json_type(t.metadata, '$.tags') = 'array'
            AND t.created_at >= datetime('now', ?)
            AND j.value IN (${placeholders(tags.length)})`,
      );
      params.push(win, ...tags);
    }
    const rows = db
      .prepare(
        `WITH RECURSIVE roots(task_id) AS (
           ${roots.join("\n           UNION\n           ")}
         ), tree(task_id) AS (
           SELECT task_id FROM roots
           UNION
           SELECT c.task_id FROM tasks c JOIN tree p ON c.parent_task_id = p.task_id
         )
         SELECT task_id FROM tree`,
      )
      .all(...params) as Array<{ task_id: string }>;
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
  const total7 = byStatus.reduce((a, s) => a + Number(s.d7), 0);
  out.push(`  total: ${total7} · ${ids.length}`);
  // By source: each task's column value; a task with none (a pre-v9 row, or
  // an unattributed sub-task of a tagged run) is tag-only.
  const bySource = hasColumns
    ? inIds(
        `SELECT COALESCE(project_source, 'tag-only') AS source,
                COALESCE(SUM(created_at >= datetime('now', '-7 days')), 0) AS d7,
                COUNT(*) AS dn
           FROM tasks WHERE task_id IN (__IDS__) GROUP BY 1`,
      )
    : [{ source: "tag-only", d7: total7, dn: ids.length }];
  out.push(
    `  by source (7 d·${days} d): ${[...PROJECT_SOURCES, "tag-only"]
      .map((k) => {
        const r = bySource.find((x) => x.source === k);
        return `${k}=${Number(r?.d7 ?? 0)}·${Number(r?.dn ?? 0)}`;
      })
      .join(" ")}`,
  );

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
