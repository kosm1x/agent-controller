/**
 * Fixture test for COMPLAINTS_SQL and scripts/complaints-digest.sh: a small
 * throwaway database is built with the sqlite3 CLI in a fresh temp directory
 * and the wrapper runs against it. Never touches any other database.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Digest } from "./digest.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WRAPPER = join(REPO, "scripts", "complaints-digest.sh");
const NOW = "2026-11-20T18:00:00Z"; // with --days 30, @since = '2026-10-21 18:00:00'
const MID = "2026-11-10 12:00:00";

const SCHEMA = `
CREATE TABLE tasks (id INTEGER PRIMARY KEY, task_id TEXT UNIQUE NOT NULL, title TEXT NOT NULL DEFAULT '',
  status TEXT, output TEXT, error TEXT, metadata TEXT, created_at TEXT);
CREATE TABLE task_trace_events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, name TEXT NOT NULL, tool TEXT);
CREATE TABLE task_outcomes (id INTEGER PRIMARY KEY, task_id TEXT NOT NULL, concern_detail TEXT);
CREATE TABLE scheduled_tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, schedule_id TEXT UNIQUE NOT NULL, name TEXT NOT NULL);
INSERT INTO scheduled_tasks (schedule_id, name) VALUES
  ('first', 'First schedule'), ('second', 'Second schedule'), ('sboth', 'Both schedule');
`;

// task_id, status, created_at, metadata, output, error
const TASKS: [string, string, string, string, string, string | null][] = [
  ["edge-since", "completed", "2026-10-21 18:00:00", '{"ritualId":"edge-since"}', "{}", null],
  ["edge-now", "completed", "2026-11-20 18:00:00", '{"ritualId":"edge-now"}', '{"text":"ok","numbers_audit":{"found":1,"unverified":["5%"]}}', null],
  ["future", "completed", "2026-11-20 18:00:01", '{"ritualId":"future"}', "{}", null],
  ["both", "completed", MID, '{"ritualId":"both","tags":["scheduled","schedule:sboth"]}', "{}", null],
  ["two-tags", "completed", MID, '{"tags":["scheduled","schedule:first","schedule:second"]}', "{}", null],
  ["generic", "completed", MID, '{"tags":["scheduled"]}', "{}", null],
  ["bad-meta", "completed", MID, "{bad", "{}", null],
  ["bad-out", "completed_with_concerns", MID, '{"ritualId":"bad-out"}', "not json{", "error one"],
  ["blank-text", "failed", MID, '{"ritualId":"blank-text"}', '{"text":" \\n\\t "}', "boom error"],
  ["real-text", "failed", MID, '{"ritualId":"real-text"}', '{"text":"real reply"}', "ignored error"],
];

const lit = (s: string | null): string => (s === null ? "NULL" : `'${s.replace(/'/g, "''")}'`);

function buildDb(path: string): void {
  const inserts = TASKS.map(
    (t) => `INSERT INTO tasks (task_id, status, created_at, metadata, output, error) VALUES (${t.map(lit).join(", ")});`,
  ).join("\n");
  const r = spawnSync("/usr/bin/sqlite3", ["-init", "/dev/null", "-bail", path], {
    input: `${SCHEMA}\n${inserts}\n`,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`fixture sqlite3 failed: ${r.stderr}`);
}

function wrapper(args: string[], env: NodeJS.ProcessEnv = process.env, cwd = REPO) {
  return spawnSync("bash", [WRAPPER, ...args], { cwd, env, encoding: "utf8", timeout: 60_000 });
}

const sha = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

let dir: string;
let db: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "complaints-wrapper-"));
  db = join(dir, "fixture.db");
  buildDb(db);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("complaints-digest.sh over a fixture database", () => {
  it("selects the right runs: window edges, ritual over schedule, first schedule tag, JSON guards, error fallback", () => {
    const r = wrapper(["--db", db, "--now", NOW, "--json"]);
    expect(r.status, r.stderr).toBe(0);
    const d = JSON.parse(r.stdout) as Digest;
    const byKey = Object.fromEntries(d.types.map((t) => [t.key, t]));
    // edge-since (exactly @since) and future (after @now) are out; edge-now (exactly @now) is in.
    // both: counted once, under the ritual. two-tags: the first schedule tag only.
    // generic ("scheduled" alone) and bad-meta (malformed metadata) are dropped.
    expect(Object.keys(byKey).sort()).toEqual([
      "ritual:bad-out",
      "ritual:blank-text",
      "ritual:both",
      "ritual:edge-now",
      "ritual:real-text",
      "schedule:first",
    ]);
    expect([byKey["schedule:first"].name, byKey["schedule:first"].runs, byKey["ritual:both"].runs]).toEqual([
      "First schedule",
      1,
      1,
    ]);
    expect(byKey["ritual:edge-now"].unverified).toEqual({ runsWithUnverified: 1, runsWithAudit: 1, recurring: [] });
    // Malformed output: the run is kept and its reply falls back to the error text.
    expect([byKey["ritual:bad-out"].concerns, byKey["ritual:bad-out"].evidence.map((e) => e.text)]).toEqual([
      1,
      ["error one"],
    ]);
    // A blank reply falls back to the error text; a real reply wins over it.
    expect(byKey["ritual:blank-text"].evidence.map((e) => e.text)).toEqual(["boom error"]);
    expect(byKey["ritual:real-text"].evidence.map((e) => e.text)).toEqual(["real reply"]);
  }, 60_000);

  it("an sqlite rc file cannot write to the database: it stays byte-identical and the digest is normal", () => {
    const target = join(dir, "attacked.db");
    buildDb(target);
    const rcHome = join(dir, "rc");
    mkdirSync(join(rcHome, "sqlite3"), { recursive: true });
    const rc = `.open ${target}\nDELETE FROM tasks;\n`;
    writeFileSync(join(rcHome, "sqlite3", "sqliterc"), rc);
    writeFileSync(join(rcHome, ".sqliterc"), rc);
    const before = sha(target);

    const clean = wrapper(["--db", target, "--now", NOW]);
    const attacked = wrapper(["--db", target, "--now", NOW], { ...process.env, XDG_CONFIG_HOME: rcHome, HOME: rcHome });

    expect(attacked.status, attacked.stderr).toBe(0);
    expect(sha(target)).toBe(before);
    expect(attacked.stdout).toContain("6 recurring type(s)");
    expect(attacked.stdout).toBe(clean.stdout);
  }, 60_000);

  it("a --db that is not a database exits non-zero with one error line and no digest", () => {
    const notDb = join(dir, "notes.txt");
    writeFileSync(notDb, "this is not a database\n".repeat(64));
    const r = wrapper(["--db", notDb, "--now", NOW]);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr.trim().split("\n")).toHaveLength(1);
    // sqlite3 prints this error on stdout, which is never echoed; stderr is empty.
    expect(r.stderr.trim()).toMatch(/^complaints-digest: sqlite3 failed on .*notes\.txt: \(no message on stderr\)$/);
  }, 60_000);

  it("-readonly is in force: a --db URI asking for read-write is refused, with no digest", () => {
    const uriDir = join(dir, "uri");
    mkdirSync(uriDir);
    // sqlite3 reads the --db value as a URI naming fixture.db; the empty file under the
    // literal name only satisfies the wrapper's "is it a file" check.
    buildDb(join(uriDir, "fixture.db"));
    writeFileSync(join(uriDir, "file:fixture.db?mode=rw"), "");
    const r = wrapper(["--db", "file:fixture.db?mode=rw", "--now", NOW], process.env, uriDir);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("access mode not allowed: rw");
  }, 60_000);

  it("the --db value goes after --: a database file named -csv is read as a file, not an option", () => {
    const dashDir = join(dir, "dash");
    mkdirSync(dashDir);
    buildDb(join(dashDir, "-csv"));
    const r = wrapper(["--db=-csv", "--now", NOW], process.env, dashDir);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("6 recurring type(s)");
  }, 60_000);

  it("--now must be a full ISO time with a zone: a bare number and a zone-less time exit 2", () => {
    for (const now of ["1", "2026-11-20T18:00:00"]) {
      const r = wrapper(["--db", db, "--now", now]);
      expect([now, r.status, r.stdout]).toEqual([now, 2, ""]);
    }
  }, 60_000);
});
