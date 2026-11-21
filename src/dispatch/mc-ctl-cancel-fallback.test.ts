/**
 * The operator tool's cancel (`mc-ctl cancel`) writes straight into the
 * database when the service does not answer. That fallback must treat as
 * ended exactly the statuses the service's own cancel treats as ended, or it
 * rewrites a task (or subtask) that already ended — for example one that
 * completed with concerns — to `cancelled` and loses how the work ended.
 *
 * The script is read as text only: nothing here starts a shell or runs it.
 * The ended set comes from `cancelTask` on the real schema: every status the
 * built `tasks` table allows is tried, and the ones it refuses to cancel are
 * the ended ones. The fallback's transaction is then executed against a
 * throwaway database file in a folder this test creates and removes.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import { getEventBus } from "../lib/event-bus.js";
import { cancelTask } from "./dispatcher.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = readFileSync(join(ROOT, "mc-ctl"), "utf8");

/** Fixed old timestamps, so a write is seen without comparing with the clock. */
const OLD_UPDATED = "2000-01-01 00:00:00";
const OLD_COMPLETED = "2000-01-02 03:04:05";

/** Every match of a global pattern; the caller asserts how many it expects. */
function allMatches(text: string, re: RegExp): RegExpExecArray[] {
  const out: RegExpExecArray[] = [];
  for (let m = re.exec(text); m !== null; m = re.exec(text)) out.push(m);
  return out;
}

/** The body of cmd_cancel, from its opening line to the first closing brace line. */
function cancelBody(): string {
  const opener = "\ncmd_cancel() {\n";
  const starts = allMatches(SCRIPT, /\ncmd_cancel\(\) \{\n/g);
  expect(starts, "cmd_cancel must be defined exactly once").toHaveLength(1);
  const start = SCRIPT.indexOf(opener) + opener.length;
  const end = SCRIPT.indexOf("\n}\n", start);
  expect(end, "cmd_cancel must have a closing brace line").toBeGreaterThan(start);
  return SCRIPT.slice(start, end);
}

/** The fallback's early check: the first pattern of the case on the status it read. */
function earlyCheck(body: string): { statuses: string[]; at: number; branch: string } {
  const found = allMatches(
    body,
    /case "\$current_status" in\n([ \t]*)([^)\n]+)\)\n([\s\S]*?);;/g,
  );
  expect(found, "the early check must appear exactly once").toHaveLength(1);
  const m = found[0];
  const statuses = m[2].split("|").map((s) => s.trim());
  expect(statuses.every((s) => /^[a-z_]+$/.test(s))).toBe(true);
  return { statuses, at: m.index, branch: m[3] };
}

/** The fallback's transaction: the text of its one unquoted heredoc. */
function transaction(body: string): { sql: string; at: number } {
  const found = allMatches(body, /sqlite3 "\$DB_PATH" <<EOF\n([\s\S]*?)\nEOF\n/g);
  expect(found, "the fallback transaction must appear exactly once").toHaveLength(1);
  return { sql: found[0][1], at: found[0].index };
}

/** The fallback's status read: the SQL of its one `current_status=$(sqlite3 …)` line. */
function statusRead(body: string): string {
  const found = allMatches(body, /current_status=\$\(sqlite3 "\$DB_PATH" "([^"\n]*)"/g);
  expect(found, "the status read must appear exactly once").toHaveLength(1);
  return found[0][1];
}

/**
 * SQL text from the script with the shell's only expansion done: the task id.
 * Anything else the shell would process in an unquoted heredoc or a
 * double-quoted string ($, a backtick, a backslash) is refused.
 */
function fillId(sql: string, id: string): string {
  expect(sql).toContain("${id}");
  const filled = sql.split("${id}").join(id);
  expect(filled).not.toMatch(/[$`\\]/);
  return filled;
}

function transactionFor(id: string): string {
  return fillId(transaction(cancelBody()).sql, id);
}

function statusReadFor(id: string): string {
  return fillId(statusRead(cancelBody()), id);
}

let folder: string;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "mc-cancel-fallback-"));
  const dbPath = join(folder, "cancel.db");
  expect(resolve(dbPath).startsWith(resolve(folder) + sep)).toBe(true);
  initDatabase(dbPath);
});

afterEach(() => {
  closeDatabase();
  rmSync(folder, { recursive: true, force: true });
});

function insertTask(
  taskId: string,
  status: string,
  opts: { parent?: string; completedAt?: string | null; updatedAt?: string } = {},
): void {
  getDatabase()
    .prepare(
      `INSERT INTO tasks (task_id, parent_task_id, spawn_type, title, description, status, updated_at, completed_at)
       VALUES (?, ?, ?, ?, 'synthetic', ?, ?, ?)`,
    )
    .run(
      taskId,
      opts.parent ?? null,
      opts.parent ? "subtask" : "root",
      `title ${taskId}`,
      status,
      opts.updatedAt ?? OLD_UPDATED,
      opts.completedAt ?? null,
    );
}

function insertRun(runId: string, taskId: string, status: string, completedAt: string | null): void {
  getDatabase()
    .prepare(
      `INSERT INTO runs (run_id, task_id, agent_type, status, input, completed_at)
       VALUES (?, ?, 'fast', ?, '{}', ?)`,
    )
    .run(runId, taskId, status, completedAt);
}

type Row = { status: string; updated_at: string | null; completed_at: string | null };

function taskRow(taskId: string): Row {
  const row = getDatabase()
    .prepare("SELECT status, updated_at, completed_at FROM tasks WHERE task_id = ?")
    .get(taskId) as Row | undefined;
  expect(row, `task ${taskId} must exist`).toBeDefined();
  return row!;
}

function runRow(runId: string): { status: string; completed_at: string | null } {
  const row = getDatabase()
    .prepare("SELECT status, completed_at FROM runs WHERE run_id = ?")
    .get(runId) as { status: string; completed_at: string | null } | undefined;
  expect(row, `run ${runId} must exist`).toBeDefined();
  return row!;
}

/** Every status the built tasks table accepts, read back from its CHECK. */
function allStatuses(): string[] {
  const { sql } = getDatabase()
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'")
    .get() as { sql: string };
  const found = allMatches(sql, /\bstatus\s+TEXT[^\n]*?CHECK\s*\(\s*status\s+IN\s*\(([^)]*)\)\s*\)/g);
  expect(found, "the tasks table must carry one CHECK on status").toHaveLength(1);
  const values = allMatches(found[0][1], /'([^']+)'/g).map((m) => m[1]);
  expect(values).toContain("running");
  expect(values).toContain("cancelled");
  return values;
}

/**
 * The statuses the service's cancel refuses: one root task per status, no run
 * and no runner. The event bus is never set up here, so when the service's
 * cancel announces a cancel, the bus throws; that throw IS caught inside the
 * service's cancel function. This derivation therefore passes only while that
 * function keeps catching it: if it stops, the throw reaches this test and
 * fails it loudly (nothing here catches it).
 */
function endedByService(): Set<string> {
  expect(() => getEventBus()).toThrow();
  const ended = new Set<string>();
  for (const status of allStatuses()) {
    const id = `derive-${status}`;
    insertTask(id, status);
    const cancelled = cancelTask(id);
    // The row agrees with the answer: a refused cancel leaves it as it was.
    expect(taskRow(id).status).toBe(cancelled ? "cancelled" : status);
    if (!cancelled) ended.add(status);
  }
  expect(ended.size).toBeGreaterThan(0);
  expect(ended.has("cancelled")).toBe(true);
  expect(ended.size).toBeLessThan(allStatuses().length);
  return ended;
}

describe("mc-ctl cancel fallback", () => {
  it("lists in the early-check pattern exactly the statuses the service's cancel treats as ended", () => {
    const ended = endedByService();
    const { statuses } = earlyCheck(cancelBody());
    expect(new Set(statuses)).toEqual(ended);
    expect(statuses).toHaveLength(ended.size);
  });

  it("cancels the parent and every open direct subtask, and leaves ended subtasks and other tasks as they were", () => {
    const ended = endedByService();
    const statuses = allStatuses();

    // Neighbours on both sides of the parent's id, each with a live subtask and run.
    for (const root of ["p-aaa", "p-zzz"]) {
      insertTask(root, "running");
      insertTask(`${root}-child`, "running", { parent: root });
      insertRun(`r-${root}`, root, "running", null);
    }
    insertTask("p-mid", "running");
    insertRun("r-mid-live", "p-mid", "running", null);
    insertRun("r-mid-done", "p-mid", "completed", OLD_COMPLETED);
    for (const status of statuses) {
      insertTask(`s-${status}`, status, {
        parent: "p-mid",
        completedAt: ended.has(status) ? OLD_COMPLETED : null,
      });
    }

    getDatabase().exec(transactionFor("p-mid"));

    const parent = taskRow("p-mid");
    expect(parent.status).toBe("cancelled");
    expect(parent.updated_at).not.toBe(OLD_UPDATED);
    expect(parent.completed_at).not.toBeNull();

    expect(runRow("r-mid-live").status).toBe("cancelled");
    expect(runRow("r-mid-live").completed_at).not.toBeNull();
    expect(runRow("r-mid-done")).toEqual({ status: "completed", completed_at: OLD_COMPLETED });

    for (const status of statuses) {
      const sub = taskRow(`s-${status}`);
      if (ended.has(status)) {
        expect(sub, `ended subtask ${status} keeps its status`).toEqual({
          status,
          updated_at: OLD_UPDATED,
          completed_at: OLD_COMPLETED,
        });
      } else {
        expect(sub.status, `open subtask ${status} is cancelled`).toBe("cancelled");
        expect(sub.updated_at).not.toBe(OLD_UPDATED);
        expect(sub.completed_at).not.toBeNull();
      }
    }

    const concerns = taskRow("s-completed_with_concerns");
    expect(concerns.status).toBe("completed_with_concerns");
    expect(concerns.completed_at).toBe(OLD_COMPLETED);

    for (const root of ["p-aaa", "p-zzz"]) {
      expect(taskRow(root)).toEqual({ status: "running", updated_at: OLD_UPDATED, completed_at: null });
      expect(taskRow(`${root}-child`)).toEqual({ status: "running", updated_at: OLD_UPDATED, completed_at: null });
      expect(runRow(`r-${root}`)).toEqual({ status: "running", completed_at: null });
    }
  });

  it("names a parent that ended with concerns in the early check, whose branch returns before the transaction (text check only, the shell is not run)", () => {
    const body = cancelBody();
    const check = earlyCheck(body);
    expect(check.statuses).toContain("completed_with_concerns");
    expect(check.branch).toMatch(/\breturn 0\b/);
    expect(check.at).toBeLessThan(transaction(body).at);
  });

  it("a parent that ended before the write keeps its status and end time; its running runs and open direct subtasks are still cancelled", () => {
    // The status is read before the transaction, so a task can end in between.
    const ended = [...endedByService()].sort();
    const stamps = ended.map((status, i) => ({
      status,
      id: `e-${status}`,
      updatedAt: `2000-01-0${i + 1} 01:00:00`,
      completedAt: `2000-01-0${i + 1} 02:00:00`,
    }));
    for (const p of stamps) {
      insertTask(p.id, p.status, { updatedAt: p.updatedAt, completedAt: p.completedAt });
      insertRun(`r-${p.id}`, p.id, "running", null);
      insertTask(`c-${p.id}`, "queued", { parent: p.id });
    }

    for (const p of stamps) getDatabase().exec(transactionFor(p.id));

    for (const p of stamps) {
      expect(taskRow(p.id), `ended parent ${p.status} is kept`).toEqual({
        status: p.status,
        updated_at: p.updatedAt,
        completed_at: p.completedAt,
      });
      // What the transaction does today to the rest of an ended parent's rows.
      expect(runRow(`r-${p.id}`).status).toBe("cancelled");
      expect(taskRow(`c-${p.id}`).status).toBe("cancelled");
    }
  });

  it("reads the status of the requested task only, and every ended status it returns is one the early check stops on", () => {
    const ended = endedByService();
    const stopsOn = earlyCheck(cancelBody()).statuses;
    const statuses = allStatuses();
    for (const status of statuses) insertTask(`q-${status}`, status);

    for (const status of statuses) {
      const rows = getDatabase().prepare(statusReadFor(`q-${status}`)).all();
      expect(rows, `status read for a ${status} task`).toEqual([{ status }]);
      if (ended.has(status)) expect(stopsOn).toContain(status);
    }
  });
});
