/**
 * S6 WS1 — `mc-ctl project <slug>` report. A synthetic FILE db under the test
 * tmpdir (built with the real schema, then closed) is opened by the report
 * read-only. Pins: counts match the seeded rows, numbers only (no titles,
 * descriptions, outputs, prompts, result_summary), unknown slug exits 1, the
 * db is opened `{ readonly: true, fileMustExist: true }`, and `initDatabase` /
 * `getDatabase` are never called by the report.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import Database from "better-sqlite3";
import { tmpdir } from "node:os";
import { join } from "node:path";

const spies = vi.hoisted(() => ({
  opens: [] as Array<{ path: unknown; opts: unknown }>,
  initDatabase: vi.fn(),
  getDatabase: vi.fn(),
}));

vi.mock("better-sqlite3", async (importOriginal) => {
  const Actual = ((await importOriginal()) as { default: new (...a: unknown[]) => unknown }).default;
  function Wrapped(this: unknown, path: unknown, opts: unknown) {
    spies.opens.push({ path, opts });
    return new Actual(path, opts);
  }
  Wrapped.prototype = Actual.prototype;
  return { default: Wrapped };
});

vi.mock("../src/db/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/db/index.js")>();
  spies.initDatabase.mockImplementation(actual.initDatabase);
  spies.getDatabase.mockImplementation(actual.getDatabase);
  return { ...actual, initDatabase: spies.initDatabase, getDatabase: spies.getDatabase };
});

import { closeDatabase, getDatabase, initDatabase } from "../src/db/index.js";
import { ensureScheduledTasksTable } from "../src/rituals/dynamic.js";
import { ensureV84Tables } from "../src/lib/v8-4/schema.js";
import { UNAUDITED_COST_LINE, parseArgs, runProjectReport } from "./project-report.js";

const SECRETISH = "MARKER-" + "t".repeat(10); // must never appear in output
let dir: string;
let dbPath: string;

function buildFixture(): void {
  initDatabase(dbPath);
  try {
    seedFixture();
  } finally {
    closeDatabase();
  }
}

function seedFixture(): void {
  const db = getDatabase();
  ensureScheduledTasksTable(); // created lazily in prod, outside the migration runner
  ensureV84Tables(db);
  const ins = (sql: string, ...p: unknown[]) => db.prepare(sql).run(...p);
  ins(
    `INSERT INTO projects (id, slug, name, status, config) VALUES (?,?,?,?,?)`,
    "p1",
    "acme-radar",
    "Acme Radar",
    "active",
    JSON.stringify({
      schedules: ["sched-a", "sched-gone"],
      aliases: ["inkwell"],
      repos: [{ path: "/srv/work/acme", role: "primary" }],
      kb_folder: "projects/acme-radar/",
      kb_readme: "projects/acme/README.md",
    }),
  );
  ins(`INSERT INTO projects (id, slug, name, status, config) VALUES ('p2','quiet-one','Quiet One','active','{"stall_exempt":true}')`);
  ins(
    `INSERT INTO jarvis_files (id, path, title, content, qualifier) VALUES ('r1','projects/acme-radar/project.md','rec','x','reference')`,
  );
  ins(
    `INSERT INTO scheduled_tasks (schedule_id, name, description, cron_expr, active) VALUES ('sched-a', ?, ?, '0 9 * * 1', 1)`,
    SECRETISH,
    SECRETISH,
  );
  const task = (id: string, status: string, ageDays: number, tags: string[] | null, parent: string | null = null) =>
    ins(
      `INSERT INTO tasks (task_id, parent_task_id, title, description, status, output, metadata, created_at)
       VALUES (?,?,?,?,?,?,?, datetime('now', ?))`,
      id,
      parent,
      SECRETISH,
      SECRETISH,
      status,
      SECRETISH,
      tags ? JSON.stringify({ tags }) : null,
      `-${ageDays} days`,
    );
  task("t1", "completed", 1, ["schedule:sched-a", "weekly"]); // 7 d + 30 d
  task("t2", "failed", 10, ["schedule:sched-a"]); // 30 d only
  task("t3", "completed", 60, ["schedule:sched-a"]); // outside 30 d
  task("t1-c1", "completed", 1, null, "t1"); // sub-task
  task("t1-c1-g", "completed_with_concerns", 1, null, "t1-c1"); // sub-sub-task
  task("other", "completed", 1, ["schedule:sched-other"]); // another schedule
  task("bad-meta", "completed", 1, null);
  db.prepare(`UPDATE tasks SET metadata = 'not json' WHERE task_id = 'bad-meta'`).run();

  const run = (taskId: string, status: string, ageDays: number) =>
    ins(
      `INSERT INTO schedule_runs (schedule_id, task_id, spawned_at, status, result_summary) VALUES ('sched-a', ?, datetime('now', ?), ?, ?)`,
      taskId,
      `-${ageDays} days`,
      status,
      SECRETISH,
    );
  run("t1", "completed", 1);
  run("t2", "failed", 10);
  run("t1", "delivery_miss", 2);
  run("t3", "completed", 60);

  const gate = (taskId: string, gateId: string, state: string) =>
    ins(
      `INSERT INTO task_gates (task_id, gate_id, criterion, state, source) VALUES (?,?,?,?, 'submission')`,
      taskId,
      gateId,
      SECRETISH,
      state,
    );
  gate("t1", "G1", "met");
  gate("t1-c1", "G2", "met");
  gate("t2", "G3", "failed");
  gate("t2", "G4", "abandoned");
  gate("t3", "G5", "failed"); // outside the window
  const cost = (taskId: string, usd: number) =>
    ins(`INSERT INTO cost_ledger (run_id, task_id, agent_type, cost_usd) VALUES ('r', ?, 'fast', ?)`, taskId, usd);
  cost("t1", 0.5);
  cost("t1-c1-g", 0.25);
  cost("t2", 1);
  cost("other", 9);

  const day = (offset: number, content: string) =>
    ins(
      `INSERT INTO jarvis_files (id, path, title, content, qualifier) VALUES (?, ?, 'dl', ?, 'workspace')`,
      `dl${offset}`,
      `logs/day-logs/2026-06-${String(23 - offset).padStart(2, "0")}.md`,
      content,
    );
  day(0, "nothing relevant");
  day(3, "hoy avancé en inkwell"); // alias-only mention, 3 d before the newest
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-projreport-test-"));
  process.env.JARVIS_KB_MIRROR_DIR = join(dir, "kb");
  dbPath = join(dir, "synthetic.db");
  buildFixture();
  spies.opens.length = 0;
  spies.initDatabase.mockClear();
  spies.getDatabase.mockClear();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.JARVIS_KB_MIRROR_DIR;
});

function run(argv: string[]): { code: number; out: string[] } {
  const out: string[] = [];
  const code = runProjectReport(argv, dbPath, (l: string) => out.push(l));
  return { code, out };
}

describe("project-report", () => {
  it("counts by schedule attribution: runs, tasks (+ sub-tasks) by status 7 d · 30 d, gates, cost", () => {
    const { code, out } = run(["acme-radar"]);
    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).toContain(
      "Attribution: tasks.project_slug UNION tag schedule:<id> (+ sub-tasks), deduped by task_id. Attribution columns: present, first attributed task none yet; older rows are schedule-tag only.",
    );
    expect(text).toContain("record: yes (projects/acme-radar/project.md)");
    expect(text).toContain("repos: /srv/work/acme (primary)");
    expect(text).toContain("schedules: sched-a, sched-gone");
    expect(text).toContain("kb_readme: projects/acme/README.md");
    expect(text).toMatch(/sched-a: active · runs=3 failed=1 delivery_miss=1 · last run=\d{4}-\d{2}-\d{2} /);
    expect(text).toContain("sched-gone: MISSING from scheduled_tasks · runs=0 failed=0 delivery_miss=0 · last run=never");
    expect(out).toContain("  completed: 2 · 2");
    expect(out).toContain("  completed_with_concerns: 1 · 1");
    expect(out).toContain("  failed: 0 · 1");
    expect(out).toContain("  total: 3 · 4");
    expect(out).toContain(
      "  by source (7 d·30 d): schedule=0·0 parent=0·0 ritual=0·0 inbound=0·0 chat=0·0 thread=0·0 classifier=0·0 tag-only=3·4",
    );
    expect(out).toContain("  met=2 failed=1 abandoned=1 pending=0");
    expect(out).toContain(`  $1.7500 over 3 ledger rows ${UNAUDITED_COST_LINE}`);
    expect(UNAUDITED_COST_LINE).toBe("(unaudited — run ./mc-ctl audit-claim before quoting)");
  });

  it("S6 WS2 UNION: a column-only task, a tag-only task and a task with both are each counted once; by source; gates and cost follow", () => {
    initDatabase(dbPath);
    try {
      const db = getDatabase();
      const task = (id: string, status: string, ageDays: number, slug: string, source: string, tags: string[] | null) =>
        db
          .prepare(
            `INSERT INTO tasks (task_id, title, description, status, metadata, project_slug, project_source, created_at)
             VALUES (?,?,?,?,?,?,?, datetime('now', ?))`,
          )
          .run(id, SECRETISH, SECRETISH, status, tags ? JSON.stringify({ tags }) : null, slug, source, `-${ageDays} days`);
      task("col-only", "completed", 2, "acme-radar", "chat", null);
      task("both", "completed", 1, "acme-radar", "schedule", ["schedule:sched-a"]);
      task("old-col", "failed", 20, "acme-radar", "chat", null);
      task("other-col", "completed", 1, "other-proj", "chat", null);
      db.prepare(
        `INSERT INTO task_gates (task_id, gate_id, criterion, state, source) VALUES ('col-only', 'G9', ?, 'met', 'submission')`,
      ).run(SECRETISH);
      const cost = db.prepare(
        `INSERT INTO cost_ledger (run_id, task_id, agent_type, cost_usd) VALUES ('r', ?, 'fast', ?)`,
      );
      cost.run("both", 2);
      cost.run("other-col", 5);
    } finally {
      closeDatabase();
    }
    const { out } = run(["acme-radar"]);
    const text = out.join("\n");
    expect(text).toMatch(/Attribution columns: present, first attributed task \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2};/);
    expect(out).toContain("  completed: 4 · 4");
    expect(out).toContain("  completed_with_concerns: 1 · 1");
    expect(out).toContain("  failed: 0 · 2");
    expect(out).toContain("  total: 5 · 7");
    expect(out).toContain(
      "  by source (7 d·30 d): schedule=1·1 parent=0·0 ritual=0·0 inbound=0·0 chat=1·2 thread=0·0 classifier=0·0 tag-only=3·4",
    );
    expect(out).toContain("  met=3 failed=1 abandoned=1 pending=0");
    expect(out).toContain(`  $3.7500 over 4 ledger rows ${UNAUDITED_COST_LINE}`);
    expect(text).not.toContain(SECRETISH);
  });

  it("before the v9 migration (no columns): the schedule-tag path alone, all tag-only", () => {
    const raw = new Database(dbPath);
    raw.exec(`
      DROP INDEX idx_tasks_project_slug_created;
      ALTER TABLE tasks DROP COLUMN project_slug;
      ALTER TABLE tasks DROP COLUMN project_source;
    `);
    raw.close();
    const { code, out } = run(["acme-radar"]);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("Attribution columns: absent (schema < v9); older rows are schedule-tag only.");
    expect(out).toContain("  total: 3 · 4");
    expect(out).toContain(
      "  by source (7 d·30 d): schedule=0·0 parent=0·0 ritual=0·0 inbound=0·0 chat=0·0 thread=0·0 classifier=0·0 tag-only=3·4",
    );
  });

  it("--days narrows the window", () => {
    const { out } = run(["acme-radar", "--days", "7"]);
    expect(out).toContain("  total: 3 · 3");
    expect(out.join("\n")).toMatch(/sched-a: active · runs=2 failed=0 delivery_miss=1/);
  });

  it("day-log: last mention via record aliases, stall state from the exported detector logic", () => {
    const { out } = run(["acme-radar"]);
    expect(out).toContain("  last mention: 2026-06-20 (3 d before the newest day-log)");
    expect(out).toContain("  stall state: moving");
    const quiet = run(["quiet-one"]).out;
    expect(quiet).toContain("  record: no (projects/quiet-one/project.md)");
    expect(quiet).toContain("  stall state: exempt (stall_exempt)");
    expect(quiet).toContain("  (the record lists no schedules)");
    expect(quiet).toContain("  total: 0 · 0");
  });

  it("prints numbers only: never a title, description, output, schedule prompt, criterion or result_summary", () => {
    for (const slug of ["acme-radar", "quiet-one"]) {
      expect(run([slug]).out.join("\n")).not.toContain(SECRETISH);
    }
  });

  it("unknown slug: exit 1 with one line", () => {
    const { code, out } = run(["no-such-project"]);
    expect(code).toBe(1);
    expect(out).toEqual(['No project "no-such-project" in the projects table.']);
    expect(run([]).code).toBe(1);
    expect(run(["a1", "--days", "zero"]).code).toBe(1);
  });

  it("opens the db read-only (readonly + fileMustExist) and never calls initDatabase/getDatabase", () => {
    const before = statSync(dbPath).mtimeMs;
    run(["acme-radar"]);
    run(["no-such-project"]);
    expect(spies.opens.length).toBe(2);
    for (const o of spies.opens) {
      expect(o.path).toBe(dbPath);
      expect(o.opts).toEqual({ readonly: true, fileMustExist: true });
    }
    expect(spies.initDatabase).not.toHaveBeenCalled();
    expect(spies.getDatabase).not.toHaveBeenCalled();
    expect(statSync(dbPath).mtimeMs).toBe(before);
  });

  it("a missing db file is an error, not a new empty db", () => {
    expect(() => runProjectReport(["acme-radar"], join(dir, "absent.db"), () => {})).toThrow();
  });

  it("parseArgs", () => {
    expect(parseArgs(["acme-radar"])).toEqual({ slug: "acme-radar", days: 30 });
    expect(parseArgs(["acme-radar", "--days=14"])).toEqual({ slug: "acme-radar", days: 14 });
    expect(parseArgs(["acme-radar", "--x"])).toHaveProperty("error");
  });
});
