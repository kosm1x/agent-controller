/**
 * The operator tool's status screen (`mc-ctl status`) prints a quick line of
 * task counts. Its completed count covers both finished states, the plain one
 * and completed-with-concerns, and the concerns count is shown beside it.
 *
 * The script is read as text only: nothing here starts a shell or runs it.
 * The two count queries are cut from the status command and executed against
 * a throwaway database file in a folder this test creates and removes.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";

const MC_CTL = join(dirname(fileURLToPath(import.meta.url)), "../../mc-ctl");
const SCRIPT = readFileSync(MC_CTL, "utf8");

/** Every match of a global pattern; the caller asserts how many it expects. */
function allMatches(text: string, re: RegExp): RegExpExecArray[] {
  const out: RegExpExecArray[] = [];
  for (let m = re.exec(text); m !== null; m = re.exec(text)) out.push(m);
  return out;
}

/** The body of cmd_status, from its opening line to the first closing brace line. */
function statusBody(): string {
  const opener = "\ncmd_status() {\n";
  const starts = allMatches(SCRIPT, /\ncmd_status\(\) \{\n/g);
  expect(starts, "cmd_status must be defined exactly once").toHaveLength(1);
  const start = SCRIPT.indexOf(opener) + opener.length;
  const end = SCRIPT.indexOf("\n}\n", start);
  expect(end, "cmd_status must have a closing brace line").toBeGreaterThan(start);
  return SCRIPT.slice(start, end);
}

/**
 * The SQL of the one `<name>=$(sql_raw "…" 2>/dev/null || echo "0")` line in
 * cmd_status, fallback included. Anything the shell would process in a
 * double-quoted string ($, a backtick, a backslash) is refused, so the text
 * run here is the text the shell passes on.
 */
function countSql(name: string): string {
  const re = new RegExp(`^    ${name}=\\$\\(sql_raw "([^"\\n]*)" 2>/dev/null \\|\\| echo "0"\\)$`, "gm");
  const found = allMatches(statusBody(), re);
  expect(found, `the ${name}= count must appear exactly once`).toHaveLength(1);
  const sql = found[0][1];
  expect(sql).not.toMatch(/[$`\\]/);
  return sql;
}

/** The one line that prints the task counts. */
function tasksEchoLine(): string {
  const found = allMatches(statusBody(), /^    echo -e "  Tasks: [^\n]*$/gm);
  expect(found, "the Tasks line must appear exactly once").toHaveLength(1);
  return found[0][0];
}

let folder: string;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "mc-status-count-"));
  const dbPath = join(folder, "status.db");
  expect(resolve(dbPath).startsWith(resolve(folder) + sep)).toBe(true);
  initDatabase(dbPath);
});

afterEach(() => {
  closeDatabase();
  rmSync(folder, { recursive: true, force: true });
});

/** Every status the built tasks table accepts, read back from its CHECK. */
function allStatuses(): string[] {
  const { sql } = getDatabase()
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'")
    .get() as { sql: string };
  const found = allMatches(sql, /\bstatus\s+TEXT[^\n]*?CHECK\s*\(\s*status\s+IN\s*\(([^)]*)\)\s*\)/g);
  expect(found, "the tasks table must carry one CHECK on status").toHaveLength(1);
  const values = allMatches(found[0][1], /'([^']+)'/g).map((m) => m[1]);
  expect(values).toContain("completed");
  expect(values).toContain("completed_with_concerns");
  return values;
}

/** 3 plain completed rows, 2 completed with concerns, 1 row of every other status. */
function insertRows(): number {
  const rowsPer = (status: string): number =>
    status === "completed" ? 3 : status === "completed_with_concerns" ? 2 : 1;
  const insert = getDatabase().prepare(
    "INSERT INTO tasks (task_id, title, description, status) VALUES (?, ?, 'synthetic', ?)",
  );
  let n = 0;
  for (const status of allStatuses()) {
    for (let i = 0; i < rowsPer(status); i++) {
      insert.run(`t-${status}-${i}`, `title ${status} ${i}`, status);
      n++;
    }
  }
  return n;
}

function count(sql: string): number {
  const row = getDatabase().prepare(sql).raw().get() as unknown[];
  expect(row).toHaveLength(1);
  return Number(row[0]);
}

describe("mc-ctl status quick line", () => {
  it("counts both finished states as completed and the completed_with_concerns rows as concerns", () => {
    const inserted = insertRows();
    expect(count("SELECT COUNT(*) FROM tasks")).toBe(inserted);
    expect(count(countSql("completed"))).toBe(5);
    expect(count(countSql("concerns"))).toBe(2);
  });

  it("declares concerns local and prints its count in an uncoloured bracket after the completed count", () => {
    expect(statusBody()).toMatch(/^    local total running completed concerns failed$/m);
    expect(tasksEchoLine()).toBe(
      '    echo -e "  Tasks:      ${total} total, ${GREEN}${completed}${NC} completed (${concerns} with concerns), ${CYAN}${running}${NC} running, ${RED}${failed}${NC} failed"',
    );
  });
});
