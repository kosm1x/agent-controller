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

// Runs for the task_completion_facts cases (schema 18): task_id, status,
// created_at, metadata, output, error. Each ritual is one case.
const FACT_TASKS: [string, string, string, string, string, string | null][] = [
  ["fx-pref", "completed_with_concerns", MID, '{"ritualId":"fx-pref"}', '{"text":"pref reply"}', null],
  ["fx-blank", "completed_with_concerns", MID, '{"ritualId":"fx-blank"}', '{"text":"blank reply"}', null],
  ["fx-null", "completed_with_concerns", MID, '{"ritualId":"fx-null"}', '{"text":"null reply"}', null],
  ["fx-reply", "completed_with_concerns", MID, '{"ritualId":"fx-reply"}', '{"text":"reply only"}', null],
  ["fx-b1", "completed", "2026-11-11 12:00:00", '{"ritualId":"fx-builds"}', "{}", null],
  ["fx-b2", "completed_with_concerns", "2026-11-12 12:00:00", '{"ritualId":"fx-builds"}', '{"text":"reply b2"}', null],
  ["fx-b3", "completed", "2026-11-13 12:00:00", '{"ritualId":"fx-builds"}', "{}", null],
  ["fx-b4", "running", "2026-11-14 12:00:00", '{"ritualId":"fx-builds"}', "{}", null],
  ["fx-b5", "failed", "2026-11-15 12:00:00", '{"ritualId":"fx-builds"}', "{}", "thrown"],
  ["fx-old", "completed_with_concerns", "2026-10-01 12:00:00", '{"ritualId":"fx-old"}', "{}", null],
];
// task_id, concern_detail
const FACT_OUTCOMES: [string, string][] = [
  ["fx-pref", "outcome text"],
  ["fx-blank", "outcome kept"],
  ["fx-null", "outcome for null"],
];
// task_id, build, concern_detail. created_at is far from every task's own
// time (and inside the window for fx-old, whose task is outside it), so a
// query that read it anywhere would move dates or runs.
const FACTS: [string, string | null, string | null][] = [
  ["fx-pref", "aaa1111", "facts text"],
  ["fx-blank", "aaa1111", "  "],
  ["fx-null", "bbb2222", null],
  ["fx-reply", "bbb2222", null],
  ["fx-b1", "bbb2222", null],
  ["fx-b2", "aaa1111", "concern b2"],
  ["fx-b3", "bbb2222", null],
  ["fx-b4", "ccc3333", null],
  ["fx-old", "ddd4444", "old"],
];
const FACTS_CREATED: Record<string, string> = { "fx-old": MID };

/**
 * "base": the original fixture, no facts table. "facts": plus FACT_TASKS,
 * their outcomes and the task_completion_facts table. "no-table": the same
 * tasks and outcomes as "facts" on a database without that table.
 */
function buildDb(path: string, variant: "base" | "facts" | "no-table" = "base"): void {
  const tasks = variant === "base" ? TASKS : [...TASKS, ...FACT_TASKS];
  const inserts = tasks.map(
    (t) => `INSERT INTO tasks (task_id, status, created_at, metadata, output, error) VALUES (${t.map(lit).join(", ")});`,
  );
  if (variant !== "base") {
    for (const o of FACT_OUTCOMES) inserts.push(`INSERT INTO task_outcomes (task_id, concern_detail) VALUES (${o.map(lit).join(", ")});`);
  }
  if (variant === "facts") {
    inserts.push(`CREATE TABLE task_completion_facts (task_id TEXT PRIMARY KEY, build TEXT, concern_detail TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));`);
    for (const f of FACTS) {
      const created = FACTS_CREATED[f[0]] ?? "2026-12-31 23:59:59";
      inserts.push(
        `INSERT INTO task_completion_facts (task_id, build, concern_detail, created_at) VALUES (${[...f, created].map(lit).join(", ")});`,
      );
    }
  }
  const r = spawnSync("/usr/bin/sqlite3", ["-init", "/dev/null", "-bail", path], {
    input: `${SCHEMA}\n${inserts.join("\n")}\n`,
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
    // The first sqlite3 call (the task_completion_facts probe, a plain SELECT) fails
    // with its reason on stderr; whatever it printed on stdout is never echoed.
    expect(r.stderr.trim()).toMatch(/^complaints-digest: sqlite3 failed on .*notes\.txt: .*file is not a database/);
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

describe("task_completion_facts (schema 18 on), and databases without it", () => {
  // Output of the unmodified tool (commit 835a686c) on the "no-table" fixture
  // with --now NOW, text and --json: sha256 of stdout.
  const BEFORE_TEXT_SHA = "a52ef51ae6f33fec65bb53eef62b7b71814f95ce26c521784cbd4245fcb444a9";
  const BEFORE_JSON_SHA = "9d8a9dd73efb1edf24319e40f3cb33a2f34c8f1cc833d6160bf27839add44caa";
  const TYPE_KEYS = ["complaintsLastN", "concerns", "evidence", "failed", "key", "name", "runs", "strip", "tooFewRuns", "tools", "trigger", "unverified"];
  const EVIDENCE_KEYS = ["date", "id", "source", "text"];
  const hash = (s: string): string => createHash("sha256").update(s).digest("hex");
  const built = new Set<string>();
  const run = (variant: "facts" | "no-table", json: boolean) => {
    const path = join(dir, `${variant}.db`);
    if (!built.has(path)) buildDb(path, variant);
    built.add(path);
    const r = wrapper(["--db", path, "--now", NOW, ...(json ? ["--json"] : [])]);
    expect(r.status, r.stderr).toBe(0);
    return r.stdout;
  };
  const byKey = (stdout: string) => Object.fromEntries((JSON.parse(stdout) as Digest).types.map((t) => [t.key, t]));

  it("concern text: facts detail first; blank or NULL facts detail falls back to task_outcomes, then the reply", () => {
    const k = byKey(run("facts", true));
    const ev = (key: string) => k[key].evidence.map((e) => [e.source, e.text, e.build]);
    expect(ev("ritual:fx-pref")).toEqual([["concern", "facts text", "aaa1111"]]);
    expect(ev("ritual:fx-blank")).toEqual([["concern", "outcome kept", "aaa1111"]]);
    expect(ev("ritual:fx-null")).toEqual([["concern", "outcome for null", "bbb2222"]]);
    // A NULL facts detail on a run that ended with concerns: still a concern run (status is from tasks).
    expect([k["ritual:fx-reply"].concerns, ev("ritual:fx-reply")]).toEqual([1, [["reply", "reply only", "bbb2222"]]]);
  }, 60_000);

  it("build per run and per type; status, time and window come from tasks, never from the facts row", () => {
    const facts = byKey(run("facts", true));
    const before = byKey(run("no-table", true));
    const t = facts["ritual:fx-builds"];
    expect(t.builds).toEqual(["bbb2222", "aaa1111", "ccc3333"]);
    expect(t.buildRuns).toEqual([
      { build: "bbb2222", runs: 2, concern: 0 },
      { build: "aaa1111", runs: 1, concern: 1 },
      { build: "ccc3333", runs: 1, concern: 0 },
      { build: null, runs: 1, concern: 0 },
    ]);
    expect(t.evidence.map((e) => [e.date, e.id, e.source, e.text, e.build])).toEqual([
      ["2026-11-15", "fx-b5", "reply", "thrown", null],
      ["2026-11-12", "fx-b2", "concern", "concern b2", "aaa1111"],
    ]);
    // The facts row of the still-running fx-b4 changes no count.
    const counts = (x: typeof t) => [x.runs, x.concerns, x.failed, x.strip, x.complaintsLastN];
    expect(counts(t)).toEqual([5, 1, 1, ".C.?F", 2]);
    expect(counts(t)).toEqual(counts(before["ritual:fx-builds"]));
    // fx-old: its task is outside the window, its facts row inside; it stays out.
    expect(Object.keys(facts).sort()).toEqual(Object.keys(before).sort());
    expect(facts["ritual:fx-old"]).toBeUndefined();
    expect([facts["ritual:both"].builds, facts["ritual:both"].evidence]).toEqual([[], []]);
    expect(facts["ritual:bad-out"].evidence.map((e) => e.build)).toEqual([null]);
  }, 60_000);

  it("text output: the build after each evidence run id, and one builds line per type", () => {
    const out = run("facts", false);
    expect(out).toContain("\nritual:fx-builds  fx-builds\n");
    expect(out).toContain(
      "  builds, oldest first: bbb2222 2 runs / 0 concern · aaa1111 1 run / 1 concern · ccc3333 1 run / 0 concern · no build 1 run / 0 concern\n",
    );
    expect(out).toContain("    2026-11-15 fx-b5 @- [reply] thrown\n");
    expect(out).toContain("    2026-11-12 fx-b2 @aaa1111 [concern] concern b2\n");
    expect(out).toContain("    2026-11-10 fx-pref @aaa1111 [concern] facts text\n");
    expect(out.match(/^ {2}builds, oldest first: none recorded$/gm)).toHaveLength(6);
  }, 60_000);

  it("--last 3: the builds line counts only the strip's 3 runs (aaa1111 drops out)", () => {
    const path = join(dir, "facts-last.db");
    buildDb(path, "facts");
    const r = wrapper(["--db", path, "--now", NOW, "--last", "3", "--min", "1", "--type", "ritual:fx-builds"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("  last 3: [.?F]");
    expect(r.stdout).toContain("  builds, oldest first: bbb2222 1 run / 0 concern · ccc3333 1 run / 0 concern · no build 1 run / 0 concern\n");
  }, 60_000);

  it("a database without the table: exit 0, the same text and JSON as the tool before the change", () => {
    const text = run("no-table", false);
    const json = run("no-table", true);
    expect(text).not.toMatch(/builds, oldest first| @/);
    expect(text).toContain("    2026-11-10 fx-pref [concern] outcome text\n");
    expect(hash(text)).toBe(BEFORE_TEXT_SHA);
    expect(hash(json)).toBe(BEFORE_JSON_SHA);
  }, 60_000);

  it("JSON keys: the existing ones are unchanged; the facts table adds only builds, buildRuns and evidence build", () => {
    const keys = (stdout: string) => {
      const d = JSON.parse(stdout) as Digest;
      const t = d.types.find((x) => x.key === "ritual:fx-builds");
      if (!t) throw new Error("no ritual:fx-builds");
      return {
        top: Object.keys(d).sort(),
        type: Object.keys(t).sort(),
        unverified: Object.keys(t.unverified).sort(),
        tools: Object.keys(t.tools).sort(),
        evidence: Object.keys(t.evidence[0]).sort(),
      };
    };
    const old = { top: ["days", "last", "min", "now", "types"], unverified: ["recurring", "runsWithAudit", "runsWithUnverified"], tools: ["cleanRuns", "concernRuns", "diffs"] };
    expect(keys(run("no-table", true))).toEqual({ ...old, type: TYPE_KEYS, evidence: EVIDENCE_KEYS });
    expect(keys(run("facts", true))).toEqual({ ...old, type: [...TYPE_KEYS, "buildRuns", "builds"].sort(), evidence: [...EVIDENCE_KEYS, "build"].sort() });
  }, 60_000);

  it("every sqlite3 call in the wrapper keeps -init /dev/null -safe -readonly -bail and -- before the path", () => {
    const calls = readFileSync(WRAPPER, "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("#"))
      .map((l) => l.replace("complaints-digest: sqlite3 failed", ""))
      .filter((l) => /sqlite3/.test(l));
    expect(calls.length).toBeGreaterThan(0);
    for (const l of calls) {
      expect(l).toContain("/usr/bin/sqlite3 -init /dev/null -safe -readonly -bail ");
      expect(l).toMatch(/ -- "\$DB"/);
    }
  });
});
