/**
 * validate-shell-gate-diff — extraction, window, dedupe, grouping, exit code and
 * redaction, on a synthetic temp DB only (the live mc.db is never opened).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractShellCommands,
  readShellCommands,
  diffCommands,
  exitCodeFor,
  redactCommand,
  formatReport,
  parseArgs,
  type Validator,
} from "./validate-shell-gate-diff.js";

const call = (command: string) => ({ name: "shell_exec", input: { command } });

describe("extractShellCommands", () => {
  it("finds shell_exec calls in any nesting, SDK and OpenAI shapes, JSON-in-string included", () => {
    const text = JSON.stringify({
      toolCalls: [call("ls -la"), { name: "file_read", input: { command: "not me" } }],
      trace: [
        { type: "x", messages: [{ role: "assistant", tool_calls: [{ function: { name: "shell_exec", arguments: JSON.stringify({ command: "docker ps" }) } }] }] },
      ],
      nested: JSON.stringify({ calls: [{ tool: "mcp__jarvis__shell_exec", args: { command: "git status" } }] }),
    });
    expect(extractShellCommands(text).sort()).toEqual(["docker ps", "git status", "ls -la"]);
  });

  it("ignores non-JSON text, other tools, empty commands", () => {
    expect(extractShellCommands("shell_exec ran ls")).toEqual([]);
    expect(extractShellCommands(null)).toEqual([]);
    expect(extractShellCommands(JSON.stringify({ name: "shell_exec", input: { command: "  " } }))).toEqual([]);
    expect(extractShellCommands(JSON.stringify({ name: "http_fetch", input: { command: "x" }, note: "shell_exec" }))).toEqual([]);
  });
});

describe("readShellCommands on a synthetic temp DB", () => {
  let dir: string;
  let path: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "shell-gate-diff-test-"));
    path = join(dir, "synthetic.db");
    const w = new Database(path);
    w.exec(`
      CREATE TABLE runs (run_id TEXT, output TEXT, trace TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE tasks (task_id TEXT, output TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE tool_approvals (id INTEGER PRIMARY KEY, tool TEXT, args_json TEXT, requested_at TEXT DEFAULT (datetime('now')));
    `);
    const run = w.prepare("INSERT INTO runs (run_id, output, trace, created_at) VALUES (?, ?, ?, COALESCE(?, datetime('now')))");
    run.run("r1", JSON.stringify({ toolCalls: [call("docker ps"), call("ls")] }), null, null);
    run.run("r2", JSON.stringify({ toolCalls: [call("docker ps")] }), JSON.stringify([call("docker cp a:/x /y")]), null);
    run.run("r-old", JSON.stringify({ toolCalls: [call("echo outside-window")] }), null, "2020-01-01 00:00:00");
    w.prepare("INSERT INTO tasks (task_id, output) VALUES (?, ?)").run("t1", JSON.stringify({ calls: [call("ls")] }));
    const ta = w.prepare("INSERT INTO tool_approvals (tool, args_json) VALUES (?, ?)");
    ta.run("shell_exec", JSON.stringify({ command: "docker exec supabase-db psql" }));
    ta.run("gmail_send", JSON.stringify({ command: "not a shell call" }));
    w.close();
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("collects the window, dedupes, counts per source, skips missing tables, and stays read-only", () => {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    db.pragma("query_only = ON");
    try {
      const pop = readShellCommands(db, 30);
      expect(pop.total).toBe(6);
      expect(pop.commands.sort()).toEqual(["docker cp a:/x /y", "docker exec supabase-db psql", "docker ps", "ls"]);
      expect(pop.perSource).toEqual({
        "runs.output": 3,
        "runs.trace": 1,
        "tasks.output": 1,
        "tool_approvals.args_json": 1,
      });
      expect(() => db.exec("DELETE FROM runs")).toThrow(); // read-only handle
      // A window reaching back past 2020 picks up the old row.
      expect(readShellCommands(db, 3650).commands).toContain("echo outside-window");
    } finally {
      db.close();
    }
  });
});

describe("diffCommands / exitCodeFor", () => {
  const DOCKER = "`docker cp` is refused — container file access and new containers are operator-only (operator ruling 2026-10-01)";
  const ref: Validator = (c) => (c.startsWith("rm ") || c === "docker frob-old" ? { allowed: false, reason: "old rule" } : { allowed: true });
  const current: Validator = (c) => {
    if (c.startsWith("docker cp")) return { allowed: false, reason: DOCKER };
    if (c === "cat ${X:+SECRET_Y}") return { allowed: false, reason: "secret expansion" };
    if (c === "docker frob-old") return { allowed: true };
    if (c === "throws") throw new Error("boom");
    return ref(c);
  };

  it("groups docker refusals, docker newly allowed and non-docker differences", () => {
    const diffs = diffCommands(["ls", "docker cp a:/x /y", "docker ps", "rm -rf x"], current, ref);
    expect(diffs.map((d) => [d.command, d.group])).toEqual([["docker cp a:/x /y", "docker-refused-per-ruling"]]);
    expect(exitCodeFor({ commands: ["ls"] }, diffs)).toBe(0);

    const more = diffCommands(["cat ${X:+SECRET_Y}", "docker frob-old", "throws"], current, ref);
    expect(more.map((d) => [d.command, d.group])).toEqual([
      ["cat ${X:+SECRET_Y}", "non-docker"],
      ["docker frob-old", "docker-newly-allowed"],
      ["throws", "non-docker"], // a throw counts as refused, never as allowed
    ]);
    expect(more[2]!.current.reason).toMatch(/validator threw: boom/);
    expect(exitCodeFor({ commands: ["x"] }, more)).toBe(1);
    expect(exitCodeFor({ commands: [] }, [])).toBe(2);
  });
});

describe("redaction and report", () => {
  // Runtime-assembled synthetic values (public repo).
  const longTok = ["Zq9", "x".repeat(20), "7Kp"].join("");
  const pw = ["syn", "pass", "123"].join("-");

  it("masks credential assignments, URL userinfo and long mixed tokens; keeps ordinary text", () => {
    const cmd = `PGPASSWORD=${pw} psql postgres://u:${pw}@db/x -c 'select 1' && curl -H "x: ${longTok}" /root/claude/mission-control`;
    const r = redactCommand(cmd);
    expect(r).not.toContain(pw);
    expect(r).not.toContain(longTok);
    expect(r).toContain("[redacted:");
    expect(r).toContain("/root/claude/mission-control");
    expect(r).toContain("select 1");
  });

  it("prints counts and groups; --no-redact shows the text as logged", () => {
    const diffs = [{ command: `docker cp ${longTok} /y`, group: "docker-refused-per-ruling" as const, current: { allowed: false, reason: "r" }, ref: { allowed: true } }];
    const pop = { total: 3, commands: ["a", "b"], perSource: { "runs.output": 3 } };
    const red = formatReport(pop, diffs, { days: 30, ref: "main", redact: true });
    expect(red).toMatch(/total: 3\ndistinct: 2\ndiffering: 1/);
    expect(red).toContain("## docker-refused-per-ruling (1)");
    expect(red).toContain("## docker-newly-allowed (0)");
    expect(red).toContain("## non-docker (0)");
    expect(red).not.toContain(longTok);
    expect(formatReport(pop, diffs, { days: 30, ref: "main", redact: false })).toContain(longTok);
  });

  it("parses flags: --run gate, --days bounds, redact default on", () => {
    expect(parseArgs([])).toMatchObject({ run: false, days: 30, ref: "main", redact: true });
    expect(parseArgs(["--run", "--days", "7", "--ref", "b402df9", "--no-redact"])).toMatchObject({ run: true, days: 7, ref: "b402df9", redact: false });
    expect(() => parseArgs(["--days", "0"])).toThrow();
    expect(() => parseArgs(["--days"])).toThrow();
    expect(() => parseArgs(["--bogus"])).toThrow();
  });
});
