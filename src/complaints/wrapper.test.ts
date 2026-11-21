/**
 * Fixture test for COMPLAINTS_SQL and scripts/complaints-digest.sh: a small
 * throwaway database is built with the sqlite3 CLI in a fresh temp directory
 * and the wrapper runs against it. Never touches any other database.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  status TEXT, output TEXT, error TEXT, metadata TEXT, created_at TEXT, completed_at TEXT);
CREATE TABLE task_trace_events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, name TEXT NOT NULL, tool TEXT,
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), attrs TEXT);
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
  // fx-tools: 3 clean runs with 3 exa calls, 3 concern runs with 1, so the tool profile prints.
  ...[1, 2, 3, 4, 5, 6].map((i): [string, string, string, string, string, string | null] => [
    `fx-t${i}`,
    i <= 3 ? "completed" : "completed_with_concerns",
    `2026-11-0${i} 12:00:00`,
    '{"ritualId":"fx-tools"}',
    i <= 3 ? "{}" : '{"text":"tools reply"}',
    null,
  ]),
];
// task_id, calls of tool "exa" (tool.called trace events)
const FACT_TRACE: [string, number][] = [
  ["fx-t1", 3], ["fx-t2", 3], ["fx-t3", 3], ["fx-t4", 1], ["fx-t5", 1], ["fx-t6", 1],
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
 * their outcomes and trace events, and the task_completion_facts table.
 * "no-table": the same tasks, outcomes and events as "facts" on a database
 * without that table.
 */
function buildDb(path: string, variant: "base" | "facts" | "no-table" = "base"): void {
  const tasks = variant === "base" ? TASKS : [...TASKS, ...FACT_TASKS];
  const inserts = tasks.map(
    (t) => `INSERT INTO tasks (task_id, status, created_at, metadata, output, error) VALUES (${t.map(lit).join(", ")});`,
  );
  if (variant !== "base") {
    for (const o of FACT_OUTCOMES) inserts.push(`INSERT INTO task_outcomes (task_id, concern_detail) VALUES (${o.map(lit).join(", ")});`);
    for (const [id, n] of FACT_TRACE) {
      for (let i = 0; i < n; i++) inserts.push(`INSERT INTO task_trace_events (task_id, name, tool) VALUES (${lit(id)}, 'tool.called', 'exa');`);
    }
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

// The tests here block on spawnSync, and vitest chains tests without giving the
// event loop a turn: on a slow host the worker then misses its 60 s reply
// window to the runner ("Timeout calling onTaskUpdate") with every test green.
// One turn before each test bounds that window by a single test.
beforeEach(() => new Promise<void>((resolve) => setImmediate(resolve)));

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

  it("flags are checked before any sqlite3 call: a bad flag exits 2 on a valid, a refused and a non-database --db", () => {
    const bad = ["--days", "abc", "--now", NOW];
    const valid = wrapper(["--db", db, ...bad]);
    expect([valid.status, valid.stdout, valid.stderr.trim()]).toEqual([2, "", "complaints-digest: --days must be an integer"]);
    // sqlite3 would exit 1 on this one (see the -readonly test below), so 2 shows it never ran.
    const uriDir = join(dir, "uri-flags");
    mkdirSync(uriDir);
    buildDb(join(uriDir, "fixture.db"));
    writeFileSync(join(uriDir, "file:fixture.db?mode=rw"), "");
    expect(wrapper(["--db", "file:fixture.db?mode=rw", "--now", NOW], process.env, uriDir).status).toBe(1);
    const refused = wrapper(["--db", "file:fixture.db?mode=rw", ...bad], process.env, uriDir);
    expect([refused.status, refused.stdout, refused.stderr.trim()]).toEqual([2, "", "complaints-digest: --days must be an integer"]);
    const notDb = join(dir, "flags-notes.txt");
    writeFileSync(notDb, "this is not a database\n".repeat(64));
    expect(wrapper(["--db", notDb, ...bad]).status).toBe(2);
    const good = wrapper(["--db", notDb, "--now", NOW]);
    expect(good.status).toBe(1);
    expect(good.stderr).toContain("file is not a database");
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
  // with --now NOW, text and --json: sha256 of stdout. The text differs in one
  // line only, the tool profile label ("calls" became "calls attempted").
  const BEFORE_TEXT_SHA = "e09fd233a74c5bc1bc582f8658abda98066a30e42d7fd5a7b2bd1c9cbbb1a500";
  const BEFORE_JSON_SHA = "a6de4dbbcd8a91fc086c8c45a016af814afd80983d2861af88aaf36dc45df329";
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
      { build: "bbb2222", runs: 2, concern: 0, failed: 0 },
      { build: "aaa1111", runs: 1, concern: 1, failed: 0 },
      { build: "ccc3333", runs: 1, concern: 0, failed: 0 },
      { build: null, runs: 1, concern: 0, failed: 1 },
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
      "  builds, oldest first: bbb2222 2 runs / 0 concern / 0 failed · aaa1111 1 run / 1 concern / 0 failed · ccc3333 1 run / 0 concern / 0 failed · no build 1 run / 0 concern / 1 failed\n",
    );
    expect(out).toContain("    2026-11-15 fx-b5 @- [reply] thrown\n");
    expect(out).toContain("    2026-11-12 fx-b2 @aaa1111 [concern] concern b2\n");
    expect(out).toContain("    2026-11-10 fx-pref @aaa1111 [concern] facts text\n");
    expect(out.match(/^ {2}builds, oldest first: none recorded$/gm)).toHaveLength(7);
  }, 60_000);

  it("--last 3: the builds line counts only the strip's 3 runs (aaa1111 drops out)", () => {
    const path = join(dir, "facts-last.db");
    buildDb(path, "facts");
    const r = wrapper(["--db", path, "--now", NOW, "--last", "3", "--min", "1", "--type", "ritual:fx-builds"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("  last 3: [.?F]");
    expect(r.stdout).toContain(
      "  builds, oldest first: bbb2222 1 run / 0 concern / 0 failed · ccc3333 1 run / 0 concern / 0 failed · no build 1 run / 0 concern / 1 failed\n",
    );
  }, 60_000);

  it("a database without the table: exit 0, JSON byte-identical to the tool before the change, text but for the tools label", () => {
    const text = run("no-table", false);
    const json = run("no-table", true);
    expect(text).not.toMatch(/builds, oldest first| @/);
    expect(text).toContain("    2026-11-10 fx-pref [concern] outcome text\n");
    expect(hash(json)).toBe(BEFORE_JSON_SHA);
    const label = /^ {2}tools, mean calls attempted per run \(clean n=3 \/ concern n=3\):$/gm;
    expect(text.match(label)).toHaveLength(1);
    expect(hash(text.replace(label, "  tools, mean calls per run (clean n=3 / concern n=3):"))).toBe(BEFORE_TEXT_SHA);
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

  it("sqlite3 runs in one pinned form: one call line, two literal modes, two call sites, no other option", () => {
    const code = readFileSync(WRAPPER, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => !l.startsWith("#"))
      .map((l) => l.replace("complaints-digest: sqlite3 failed", "").replace("complaints-digest: sqlite_ro takes", ""));
    // The only sqlite3 command line, exactly: any option outside this set is red.
    expect(code.filter((l) => /sqlite3/.test(l))).toEqual([
      '/usr/bin/sqlite3 -init /dev/null -safe -readonly -bail "$mode" -- "$DB" 2>"$errf" && return',
    ]);
    // $mode is only ever one of these two literals.
    expect(code.filter((l) => /\bmode\b/.test(l) && !/sqlite3/.test(l))).toEqual([
      "local mode",
      "list) mode=-list ;;",
      "json) mode=-json ;;",
    ]);
    // The function takes exactly one word (case "$*"), and its call sites name a mode and nothing else.
    expect(code.filter((l) => /sqlite_ro/.test(l)).map((l) => l.replace(/<<<".*"\)"/, '<<<"…")"'))).toEqual([
      "sqlite_ro() {",
      'facts="$(sqlite_ro list <<<"…")" || exit 1',
      'rows="$(sqlite_ro json <<<"…")" || exit 1',
    ]);
    expect(code).toContain('case "$*" in');
  });
});

describe("--verdict: a prediction closed by code", () => {
  // Ritual "vr" around S = 2026-11-15T12:00:00Z. v0 is one second before S;
  // v3 was cancelled; v5 waits for context. Builds come from task_completion_facts.
  const VR: [string, string, string, string, string | null][] = [
    ["v0", "completed_with_concerns", "2026-11-15 11:59:59", '{"text":"v0 reply"}', null],
    ["v1", "completed", "2026-11-15 12:00:00", "{}", null],
    ["v2", "completed_with_concerns", "2026-11-16 12:00:00", '{"text":"v2 reply"}', null],
    ["v3", "cancelled", "2026-11-17 12:00:00", "{}", null],
    ["v4", "failed", "2026-11-18 12:00:00", "{}", "v4 boom"],
    ["v5", "needs_context", "2026-11-19 12:00:00", "{}", null],
    ["v6", "completed_with_concerns", "2026-11-19 13:00:00", '{"text":"v6 reply"}', null],
    // Queued in the second of NOW: left for the next check.
    ["v7", "completed_with_concerns", "2026-11-20 18:00:00", '{"text":"v7 reply"}', null],
  ];
  const VR_FACTS: [string, string, string | null][] = [
    ["v1", "aaa1111", null],
    ["v2", "aaa1111", "v2 facts concern"],
    ["v4", "bbb2222", null],
    ["v6", "aaa1111", null],
  ];
  const S = "2026-11-15T12:00:00Z";
  const VERDICT_KEYS = ["builds", "cancelled", "complaints", "counted", "deferred", "ignoredAfterN", "inFlight", "maxComplaints", "now", "runList", "runs", "since", "strip", "type", "unknown", "verdict"];
  let vdb: string;
  const sidecars = () => [`${vdb}-wal`, `${vdb}-shm`].filter((p) => existsSync(p));
  const clearSidecars = () => {
    for (const p of [`${vdb}-wal`, `${vdb}-shm`]) rmSync(p, { force: true });
  };
  const verdict = (args: string[], path = vdb) => wrapper(["--db", path, "--now", NOW, "--verdict", ...args]);
  const json = (args: string[], path = vdb) => {
    const r = verdict([...args, "--json"], path);
    expect(r.status, r.stderr).toBe(0);
    return JSON.parse(r.stdout);
  };

  beforeAll(() => {
    // WAL mode: any sqlite3 open of the file leaves -wal and -shm beside it,
    // which is how the flag-error test proves no database was opened.
    vdb = join(dir, "verdict.db");
    const inserts = VR.map(
      ([id, status, created, output, error]) =>
        `INSERT INTO tasks (task_id, status, created_at, metadata, output, error) VALUES (${[id, status, created, '{"ritualId":"vr"}', output, error].map(lit).join(", ")});`,
    );
    inserts.push("CREATE TABLE task_completion_facts (task_id TEXT PRIMARY KEY, build TEXT, concern_detail TEXT, created_at TEXT);");
    for (const f of VR_FACTS) inserts.push(`INSERT INTO task_completion_facts (task_id, build, concern_detail) VALUES (${f.map(lit).join(", ")});`);
    const r = spawnSync("/usr/bin/sqlite3", ["-init", "/dev/null", "-bail", vdb], {
      input: `PRAGMA journal_mode=WAL;\n${SCHEMA}\n${inserts.join("\n")}\n`,
      encoding: "utf8",
    });
    if (r.status !== 0) throw new Error(`fixture sqlite3 failed: ${r.stderr}`);
  });

  it("text: REFUTED at K+1 within N; S included, the run before it out; cancelled ignored, later runs counted; two builds give the caveat", () => {
    const r = verdict(["--type", "ritual:vr", "--since", S, "--max-complaints", "1", "--runs", "3"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe(
      [
        "Prediction: ritual:vr has at most 1 complaint(s) (concerns+failed) in its first 3 runs queued at or after 2026-11-15T12:00:00.000Z; checked at 2026-11-20T18:00:00.000Z",
        "verdict: REFUTED  counted 3/3  unknown 0  complaints 2 (limit 1)",
        "  slots, oldest left: [.CF]",
        "    2026-11-15 12:00:00 completed @aaa1111",
        "    2026-11-16 12:00:00 completed_with_concerns @aaa1111 [concern] v2 facts concern",
        "    2026-11-18 12:00:00 failed @bbb2222 [reply] v4 boom",
        "  in flight, holding a slot: 0",
        "  cancelled, ignored: 1",
        "    2026-11-17 12:00:00 cancelled v3",
        "  after the first 3: 2",
        "  queued in the second of the check, left for the next check: 1",
        "  caveat: the counted runs span 2 builds, oldest first: aaa1111 · bbb2222",
        "",
      ].join("\n"),
    );
  }, 60_000);

  it("text: a needs_context run holds its slot, is named, and the verdict waits for it", () => {
    const r = verdict(["--type", "ritual:vr", "--since", S, "--max-complaints", "3"]);
    expect(r.status, r.stderr).toBe(0);
    const lines = r.stdout.split("\n");
    expect(lines[1]).toBe("verdict: COUNTING  counted 4/7  unknown 3  complaints 3 (limit 3)");
    expect(lines[2]).toBe("  slots, oldest left: [.CF?C]");
    expect(lines[3]).toBe("  to close: 1 more complaint(s) would refute it; 3 more clean result(s) in the open slots would confirm it");
    expect(lines[4]).toBe("  waiting for 1 run(s) still in flight");
    expect(lines.slice(9)).toEqual([
      "  in flight, holding a slot: 1",
      "    2026-11-19 12:00:00 needs_context v5",
      "  needs_context: not a complaint; holds its slot until it resolves",
      "  cancelled, ignored: 1",
      "    2026-11-17 12:00:00 cancelled v3",
      "  after the first 7: 0",
      "  queued in the second of the check, left for the next check: 1",
      "  caveat: the counted runs span 2 builds, oldest first: aaa1111 · bbb2222",
      "",
    ]);
  }, 60_000);

  it("JSON: CONFIRMED with exactly K of N, the documented keys, and --since floored to the second", () => {
    const confirmed = json(["--type", "ritual:vr", "--since", S, "--max-complaints", "2", "--runs", "3"]);
    expect(Object.keys(confirmed).sort()).toEqual(VERDICT_KEYS);
    expect(confirmed).toMatchObject({
      verdict: "CONFIRMED", counted: 3, runs: 3, complaints: 2, unknown: 0, deferred: 1, maxComplaints: 2, since: "2026-11-15T12:00:00.000Z",
      inFlight: [], cancelled: [{ createdAt: "2026-11-17 12:00:00", taskId: "v3", status: "cancelled" }], ignoredAfterN: 2, builds: ["aaa1111", "bbb2222"],
    });
    expect(confirmed.runList.map((r: { taskId: string }) => r.taskId)).toEqual(["v1", "v2", "v4"]);
    expect(Object.keys(confirmed.runList[0]).sort()).toEqual(["build", "createdAt", "source", "status", "taskId", "text"]);
    expect(json(["--type", "ritual:vr", "--since", S, "--max-complaints", "3"])).toMatchObject({
      verdict: "COUNTING", counted: 4, unknown: 3, inFlight: [{ createdAt: "2026-11-19 12:00:00", taskId: "v5", status: "needs_context" }],
    });
    // A second earlier, v0 is in: 4 complaints.
    expect(json(["--type", "ritual:vr", "--since", "2026-11-15T11:59:59Z", "--max-complaints", "3"])).toMatchObject({ verdict: "REFUTED", counted: 5, complaints: 4 });
    // 12:00:00.900 is floored to 12:00:00, so v1 (stamped 12:00:00) is in.
    const floored = json(["--type", "ritual:vr", "--since", "2026-11-15T12:00:00.900Z", "--max-complaints", "2", "--runs", "3"]);
    expect([floored.since, floored.runList[0].taskId]).toEqual(["2026-11-15T12:00:00.000Z", "v1"]);
  }, 60_000);

  it("a type with no runs is COUNTING 0/N; a --since after --now counts nothing; no facts table means no builds", () => {
    expect(json(["--type", "ritual:nobody", "--since", S, "--max-complaints", "2"])).toMatchObject({ verdict: "COUNTING", counted: 0, runs: 7, complaints: 0, unknown: 7, builds: [], runList: [] });
    expect(json(["--type", "ritual:vr", "--since", "2026-11-21T00:00:00Z", "--max-complaints", "2"])).toMatchObject({ verdict: "COUNTING", counted: 0, unknown: 7, inFlight: [], cancelled: [] });
    const r = verdict(["--type", "ritual:real-text", "--since", "2026-11-01T00:00:00Z", "--max-complaints", "0"], db);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("verdict: REFUTED  counted 1/7  unknown 6  complaints 1 (limit 0)\n");
    expect(r.stdout).toContain(`    ${MID} failed @- [reply] real reply\n`);
    expect(r.stdout).not.toContain("caveat");
  }, 60_000);

  it("the CLI hands the guard the clock as it is: one call, Date.now() with no slack", () => {
    // A slack added here would only be seen by a refused --now inside the
    // slack, a test that races the spawn; the call is pinned instead.
    const cli = readFileSync(join(REPO, "scripts", "complaints-digest.ts"), "utf8");
    expect(cli.split("\n").filter((l) => l.includes("nowIsAfterClock(")).map((l) => l.trim())).toEqual([
      "if (judged && nowIsAfterClock(nowMs, Date.now())) fail(`--now must not be later than the current time with ${judged}`);",
    ]);
  });

  // One spawn per test, so no single test runs long enough on a slow host to
  // outlast vitest's 60 s message timeout (see the beforeEach at the top).
  const CLOCK_LINE = "--now must not be later than the current time with --verdict";
  const refused = (args: string[], line: string) => {
    clearSidecars();
    const before = sha(vdb);
    const r = wrapper(["--db", vdb, ...args]);
    expect([r.status, r.stdout, r.stderr]).toEqual([2, "", `complaints-digest: ${line}\n`]);
    expect(sidecars()).toEqual([]);
    expect(sha(vdb)).toBe(before);
  };

  it("control: a valid run does leave the WAL sidecars, so their absence in the flag-error tests means something", () => {
    clearSidecars();
    expect(verdict(["--type", "ritual:vr", "--since", S, "--max-complaints", "1"]).status).toBe(0);
    expect(sidecars()).toHaveLength(2);
  }, 60_000);

  const FLAG_ERRORS: [string[], string][] = [
    [["--verdict"], "--verdict needs --type"],
    [["--verdict", "--since", S, "--max-complaints", "1"], "--verdict needs --type"],
    [["--verdict", "--type", "ritual:vr", "--max-complaints", "1"], "--verdict needs --since"],
    [["--verdict", "--type", "ritual:vr", "--since", S], "--verdict needs --max-complaints"],
    // "=-1": a bare "-1" after a flag is parseArgs's own (multi-line) error, unchanged here.
    [["--verdict", "--type", "ritual:vr", "--since", S, "--max-complaints=-1"], "--max-complaints must be an integer"],
    [["--verdict", "--type", "ritual:vr", "--since", S, "--max-complaints", "x"], "--max-complaints must be an integer"],
    // K >= N: a prediction that cannot be refuted.
    [["--verdict", "--type", "ritual:vr", "--since", S, "--max-complaints", "7"], "--max-complaints must be below --runs (7): K >= N is a prediction that cannot be refuted"],
    [["--verdict", "--type", "ritual:vr", "--since", S, "--max-complaints", "3", "--runs", "3"], "--max-complaints must be below --runs (3): K >= N is a prediction that cannot be refuted"],
    [["--verdict", "--type", "ritual:vr", "--since", S, "--max-complaints", "1", "--runs", "0"], "--runs must be between 1 and 100"],
    [["--verdict", "--type", "ritual:vr", "--since", S, "--max-complaints", "1", "--runs", "101"], "--runs must be between 1 and 100"],
    [["--verdict", "--type", "ritual:vr", "--since", "2026-11-15", "--max-complaints", "1"], "--since must be an ISO time with Z or an offset, e.g. 2026-11-20T18:00:00Z"],
    [["--verdict", "--type", "ritual:vr", "--since", "2026-13-45T12:00:00Z", "--max-complaints", "1"], "--since must be a date"],
    // The window with --days 30 is (2026-10-21T18:00:00Z, NOW]: its start is out.
    [["--verdict", "--type", "ritual:vr", "--since", "2026-10-21T18:00:00Z", "--max-complaints", "1"], "--since must be later than --now minus --days (30 days)"],
    [["--verdict", "--type", "ritual:vr", "--since", "2026-10-21T18:00:00.900Z", "--max-complaints", "1"], "--since must be later than --now minus --days (30 days)"],
    [["--verdict", "--type", "ritual:vr", "--since", "2026-11-12T00:00:00Z", "--max-complaints", "1", "--days", "7"], "--since must be later than --now minus --days (7 days)"],
    [["--verdict", "--type", "vr", "--since", S, "--max-complaints", "1"], "--type must match ^(ritual|schedule):[A-Za-z0-9_-]+$"],
    [["--since", S], "--since, --max-complaints and --runs need --verdict"],
    [["--max-complaints", "1"], "--since, --max-complaints and --runs need --verdict"],
    [["--runs", "3"], "--since, --max-complaints and --runs need --verdict"],
  ];
  it.each(FLAG_ERRORS)("flag error %j: exit 2, one line, no database opened", (args, line) => {
    refused(["--now", NOW, ...args], line);
  }, 60_000);

  const future = ["--type", "ritual:vr", "--since", S, "--max-complaints", "1"];
  it("a --now later than the clock is refused in verdict mode only", () => {
    refused(["--now", "2099-01-01T00:00:00Z", "--verdict", ...future], CLOCK_LINE);
    expect(wrapper(["--db", vdb, "--now", "2099-01-01T00:00:00Z"]).status).toBe(0);
  }, 60_000);

  it("a --now a minute ahead is refused: the CLI wires its own clock in", () => {
    // The exact boundary is pinned in verdict.test.ts; no slow spawn can outrun a minute.
    refused(["--now", new Date(Date.now() + 60_000).toISOString(), "--verdict", ...future], CLOCK_LINE);
  }, 60_000);

  it("the current second (what the wrapper pins when --now is not given) is accepted, and so is no --now", () => {
    // --since is a day back so the window never ages this out.
    const current = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
    const recent = ["--type", "ritual:vr", "--since", new Date(Date.now() - 86_400_000).toISOString(), "--max-complaints", "1"];
    expect(wrapper(["--db", vdb, "--now", current, "--verdict", ...recent]).status).toBe(0);
    expect(wrapper(["--db", vdb, "--verdict", ...recent]).status).toBe(0);
  }, 60_000);

  it("just inside the window, and K = N - 1, are accepted", () => {
    expect(json(["--type", "ritual:vr", "--since", "2026-10-21T18:00:01Z", "--max-complaints", "6"]).verdict).toBe("CONFIRMED");
  }, 60_000);
});

describe("--ledger: every prediction in a file, checked by code", () => {
  // Each run's completed_at is a minute after it was queued; trace rows carry
  // their own ts. lg: l1 clean with 2 exa calls (the second in the very
  // second of completed_at), l2 a concern with 1, l3 clean with no trace rows.
  // zb (the watchdog case): z2 was failed at 13:01:00 and its runner kept
  // writing calls after that. gt: two gmail_send calls, one refused at the
  // gate, plus a tool.gated row with an unknown decision, one with unreadable
  // attrs, and a row of another event carrying a not-run decision: none of
  // these three refuses anything.
  const LG: [string, string, string, string, string][] = [
    ["l1", "completed", "2026-11-15 12:00:00", "lg", "{}"],
    ["l2", "completed_with_concerns", "2026-11-16 12:00:00", "lg", '{"text":"l2 reply"}'],
    ["l3", "completed", "2026-11-17 12:00:00", "lg", "{}"],
    ["z1", "completed", "2026-11-16 12:00:00", "zb", "{}"],
    ["z2", "failed", "2026-11-16 13:00:00", "zb", "{}"],
    ["g1", "completed", "2026-11-16 12:00:00", "gt", "{}"],
  ];
  // task_id, name, tool, ts, attrs
  const TRACE: [string, string, string, string, string | null][] = [
    ["l1", "tool.called", "exa", "2026-11-15T12:00:30.000Z", null],
    ["l1", "tool.called", "exa", "2026-11-15T12:01:00.999Z", null],
    ["l2", "tool.called", "exa", "2026-11-16T12:00:30.000Z", null],
    ["z2", "tool.called", "exa", "2026-11-16T13:01:01.000Z", null],
    ["z2", "tool.called", "exa", "2026-11-16T13:05:00.000Z", null],
    ["g1", "tool.called", "gmail_send", "2026-11-16T12:00:10.000Z", null],
    ["g1", "tool.called", "gmail_send", "2026-11-16T12:00:20.000Z", null],
    ["g1", "tool.gated", "gmail_send", "2026-11-16T12:00:10.000Z", '{"decision":"confirmation_required","origin":"x"}'],
    ["g1", "tool.gated", "gmail_send", "2026-11-16T12:00:20.000Z", '{"decision":"not_a_decision"}'],
    ["g1", "tool.gated", "gmail_send", "2026-11-16T12:00:20.000Z", "not json"],
    ["g1", "tool.secret_ref_refused", "gmail_send", "2026-11-16T12:00:20.000Z", '{"decision":"refused_placeholder"}'],
  ];
  const S = "2026-11-15T12:00:00Z";
  const SS = "2026-11-15T12:00:00.000Z";
  const CHECKED = "2026-11-20T18:00:00.000Z";
  const RECORDED = "2026-11-19T00:00:00.000Z";
  const GUARD_NOTE = "; a guard counts a tool's calls with no did-not-run gate row (errored calls and some refusals included)";
  const base = { type: "ritual:lg", since: S, maxComplaints: 1, runs: 3, change: "a change", baseline: "a baseline" };
  const ROWS = {
    a: { id: "a", ...base, guards: [{ tool: "exa", min: 2, maxBelow: 1 }], answer: "never printed" },
    b: { id: "b", ...base, guards: [{ tool: "exa", min: 1, maxBelow: 1 }], closed: { state: "CONFIRMED", checkedAt: RECORDED, line: "earlier" } },
    c: { id: "c", ...base, type: "ritual:nobody", maxComplaints: 0, runs: 2 },
    d: { id: "d", ...base, type: "ritual:old", since: "2026-10-01T00:00:00Z", maxComplaints: 0, runs: 1 },
    e: { id: "e", ...base, type: "ritual:zb", runs: 2, guards: [{ tool: "exa", min: 1, maxBelow: 1 }] },
    f: { id: "f", ...base, type: "ritual:gt", maxComplaints: 0, runs: 1, guards: [{ tool: "gmail_send", min: 1, maxBelow: 0 }, { tool: "gmail_send", min: 2, maxBelow: 0 }] },
  };
  const LINE_A = `a CONFIRMED, guard broken | ritual:lg since ${SS}: counted 3/3, complaints 1 (limit 1), unknown 0 [.C.]; guard exa >= 2 calls: 2 run(s) below (limit 1) broken`;
  const LINE_B = `b CONFIRMED | ritual:lg since ${SS}: counted 3/3, complaints 1 (limit 1), unknown 0 [.C.]; guard exa >= 1 calls: 1 run(s) below (limit 1) holds`;
  const LINE_C = `c COUNTING | ritual:nobody since ${SS}: counted 0/2, complaints 0 (limit 0), unknown 2 []; guard: none; no run of this type in 30 days`;
  const LINE_D = "d EXPIRED | ritual:old since 2026-10-01T00:00:00.000Z: since is outside the 30-day window";
  const LINE_E = `e CONFIRMED, guard broken | ritual:zb since ${SS}: counted 2/2, complaints 1 (limit 1), unknown 0 [.F]; guard exa >= 1 calls: 2 run(s) below (limit 1) broken`;
  const LINE_F =
    `f CONFIRMED, guard broken | ritual:gt since ${SS}: counted 1/1, complaints 0 (limit 0), unknown 0 [.]; ` +
    "guard gmail_send >= 1 calls: 0 run(s) below (limit 0) holds; guard gmail_send >= 2 calls: 1 run(s) below (limit 0) broken";
  let ldb: string;
  const ledgerFile = (name: string, rows: object[]) => {
    const path = join(dir, name);
    writeFileSync(path, rows.map((r) => JSON.stringify(r) + "\n").join(""));
    return path;
  };
  const ledger = (args: string[]) => wrapper(["--db", ldb, "--now", NOW, "--ledger", ...args]);
  const ledger_at = (now: string, args: string[]) => wrapper(["--db", ldb, "--now", now, "--ledger", ...args]);
  const sidecars = () => [`${ldb}-wal`, `${ldb}-shm`].filter((p) => existsSync(p));

  beforeAll(() => {
    // WAL mode, as in the verdict cases: sidecars appear only once sqlite3 opens the file.
    ldb = join(dir, "ledger.db");
    const inserts = [
      ...LG.map(
        ([id, status, created, ritual, output]) =>
          `INSERT INTO tasks (task_id, status, created_at, completed_at, metadata, output) VALUES (${[id, status, created].map(lit).join(", ")}, datetime(${lit(created)}, '+60 seconds'), ${lit(`{"ritualId":"${ritual}"}`)}, ${lit(output)});`,
      ),
      ...TRACE.map((t) => `INSERT INTO task_trace_events (task_id, name, tool, ts, attrs) VALUES (${t.map(lit).join(", ")});`),
    ];
    const r = spawnSync("/usr/bin/sqlite3", ["-init", "/dev/null", "-bail", ldb], {
      input: `PRAGMA journal_mode=WAL;\n${SCHEMA}\n${inserts.join("\n")}\n`,
      encoding: "utf8",
    });
    if (r.status !== 0) throw new Error(`fixture sqlite3 failed: ${r.stderr}`);
  });

  it("replay (--now given): guards over trace rows, a recorded closure not rechecked, no closure offered; exit 0", () => {
    const f = ledgerFile("ledger.jsonl", Object.values(ROWS));
    const r = ledger([f]);
    expect([r.status, r.stderr]).toEqual([0, ""]);
    expect(r.stdout).toBe(
      [
        `Ledger ${f} replayed at ${CHECKED} (a replay, not a recheck) over the 30 days before it: 6 row(s)${GUARD_NOTE}`,
        LINE_A,
        LINE_B,
        `  recorded CONFIRMED at ${RECORDED}; not rechecked (replay)`,
        LINE_C,
        LINE_D,
        LINE_E,
        LINE_F,
        "",
      ].join("\n"),
    );
    expect(sidecars()).toHaveLength(2);
  }, 60_000);

  it("replay earlier than a recorded closure: the row is marked, the file is not refused; exit 0", () => {
    const r = ledger_at("2026-11-18T00:00:00Z", [ledgerFile("early.jsonl", [ROWS.b])]);
    expect([r.status, r.stderr, r.stdout.split("\n").slice(2)]).toEqual([0, "", [`  recorded CONFIRMED at ${RECORDED}, after this time; not rechecked (replay)`, ""]]);
  }, 60_000);

  it("a file name with a newline and ESC prints ASCII-escaped on stdout and stderr", () => {
    const name = "odd\n\u001b[2Jb CONFIRMED | x";
    const shown = "odd\\u000a\\u001b[2Jb CONFIRMED | x";
    const printable = /^[\x20-\x7e\n]*$/;
    const good = ledgerFile(`${name}.jsonl`, [ROWS.c]);
    const r = ledger([good]);
    expect([r.status, r.stdout.split("\n")[0].startsWith(`Ledger ${dir}/${shown}.jsonl replayed at `), r.stdout]).toEqual([0, true, expect.stringMatching(printable)]);
    expect(r.stdout.split("\n")).toHaveLength(3);
    const bad = ledgerFile(`${name}.bad.jsonl`, [{ ...ROWS.c, runs: 0 }]);
    const b = ledger([bad]);
    expect([b.status, b.stdout, b.stderr]).toEqual([2, "", `complaints-digest: ledger ${dir}/${shown}.bad.jsonl line 1: "runs" must be a whole number from 1 to 100\n`]);
    const m = ledger([join(dir, `${name}.absent`)]);
    expect([m.status, m.stderr]).toEqual([2, `complaints-digest: ledger ${dir}/${shown}.absent: cannot be read (ENOENT)\n`]);
  }, 60_000);

  it("the --now=<time> form is a replay too: the wrapper pins no clock and sets no marker", () => {
    const f = ledgerFile("eq-form.jsonl", [ROWS.b]);
    const r = wrapper(["--db", ldb, `--now=${NOW}`, "--ledger", f]);
    expect([r.status, r.stdout.split("\n")]).toEqual([0, [expect.stringContaining(`replayed at ${CHECKED} (a replay, not a recheck)`), LINE_B, `  recorded CONFIRMED at ${RECORDED}; not rechecked (replay)`, ""]]);
  }, 60_000);

  it("replay: a recorded closure the rows disagree with is not a MISMATCH and exits 0", () => {
    const f = ledgerFile("replay-mismatch.jsonl", [{ ...ROWS.b, closed: { ...ROWS.b.closed, state: "REFUTED" } }]);
    const r = ledger([f]);
    expect([r.status, r.stdout.split("\n").slice(1)]).toEqual([0, [LINE_B, `  recorded REFUTED at ${RECORDED}; not rechecked (replay)`, ""]]);
  }, 60_000);

  it("an empty ledger file prints the ledger header with 0 rows, not the digest", () => {
    const r = ledger([ledgerFile("empty.jsonl", [])]);
    expect([r.status, r.stdout]).toEqual([0, `Ledger ${join(dir, "empty.jsonl")} replayed at ${CHECKED} (a replay, not a recheck) over the 30 days before it: 0 row(s)${GUARD_NOTE}\n`]);
  }, 60_000);

  // One spawn per case; each proves no database was opened (no sidecars).
  const conflict = (flag: string, ...value: string[]): [string, (f: string) => string[], () => string[]] => [
    flag,
    (f) => ["--now", NOW, "--ledger", f, flag, ...value],
    () => [`--ledger cannot be used with ${flag}`],
  ];
  const ERRORS: [string, (f: string) => string[], (f: string) => string[]][] = [
    conflict("--verdict"),
    conflict("--type", "ritual:lg"),
    conflict("--since", S),
    conflict("--max-complaints", "1"),
    conflict("--runs", "3"),
    conflict("--days", "7"),
    conflict("--last", "3"),
    conflict("--min", "1"),
    conflict("--json"),
    ["a --now ahead of the clock", (f) => ["--now", "2099-01-01T00:00:00Z", "--ledger", f], () => ["--now must not be later than the current time with --ledger"]],
    ["a missing file", () => ["--now", NOW, "--ledger", join(dir, "absent.jsonl")], () => [`ledger ${join(dir, "absent.jsonl")}: cannot be read (ENOENT)`]],
    [
      "a file with problems on two lines",
      () => ["--now", NOW, "--ledger", ledgerFile("bad.jsonl", [ROWS.a, { ...ROWS.c, maxComplaints: 2 }, { ...ROWS.a, id: "a2" }])],
      (f) => [
        `ledger ${f} line 2: "maxComplaints" must be a whole number from 0 to 1 (below "runs")`,
        `ledger ${f} line 3: rows "a" (line 1) and "a2" are both open on ritual:lg`,
      ],
    ],
  ];
  it.each(ERRORS)("%s: exit 2, the exact stderr lines, no stdout, no database opened", (_name, args, lines) => {
    for (const p of [`${ldb}-wal`, `${ldb}-shm`]) rmSync(p, { force: true });
    const good = ledgerFile("good.jsonl", [ROWS.c]);
    const a = args(good);
    const r = wrapper(["--db", ldb, ...a]);
    const named = a[a.indexOf("--ledger") + 1];
    expect([r.status, r.stdout, r.stderr]).toEqual([2, "", lines(named).map((l) => `complaints-digest: ${l}\n`).join("")]);
    expect(sidecars()).toEqual([]);
  }, 60_000);
});

describe("--ledger at the clock (no --now): recorded closures are rechecked", () => {
  // Runs dated from the real clock, so these never age out of the window.
  // k1 clean with 1 exa call, k2 a concern with 1, k3 clean with none.
  const sec = Math.floor(Date.now() / 1000) * 1000;
  const sqlAt = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
  const t0 = sec - 3 * 86_400_000;
  const since = new Date(t0 - 3_600_000).toISOString();
  const recorded = new Date(t0 + 86_400_000).toISOString();
  const base = { type: "ritual:ck", since, maxComplaints: 1, runs: 3, change: "a change", baseline: "a baseline" };
  const P = { id: "p", ...base, guards: [{ tool: "exa", min: 1, maxBelow: 1 }], closed: { state: "CONFIRMED", checkedAt: recorded, line: "earlier" } };
  const R = { id: "r", ...base };
  const LINE_P = `p CONFIRMED | ritual:ck since ${since}: counted 3/3, complaints 1 (limit 1), unknown 0 [.C.]; guard exa >= 1 calls: 1 run(s) below (limit 1) holds`;
  const LINE_R = `r CONFIRMED | ritual:ck since ${since}: counted 3/3, complaints 1 (limit 1), unknown 0 [.C.]; guard: none`;
  const HEADER = /^Ledger .* checked at \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z over the 30 days before it: 2 row\(s\); a guard counts a tool's calls with no did-not-run gate row/;
  let cdb: string;
  const file = (name: string, rows: object[]) => {
    const path = join(dir, name);
    writeFileSync(path, rows.map((r) => JSON.stringify(r) + "\n").join(""));
    return path;
  };

  beforeAll(() => {
    cdb = join(dir, "clock.db");
    const runs: [string, string, number, string, number][] = [
      ["k1", "completed", t0, "{}", 1],
      ["k2", "completed_with_concerns", t0 + 3_600_000, '{"text":"k2 reply"}', 1],
      ["k3", "completed", t0 + 7_200_000, "{}", 0],
    ];
    const inserts = runs.flatMap(([id, status, at, output, exa]) => [
      `INSERT INTO tasks (task_id, status, created_at, completed_at, metadata, output) VALUES (${[id, status, sqlAt(at), sqlAt(at + 60_000), '{"ritualId":"ck"}', output].map(lit).join(", ")});`,
      ...Array.from({ length: exa }, () => `INSERT INTO task_trace_events (task_id, name, tool, ts) VALUES (${lit(id)}, 'tool.called', 'exa', ${lit(new Date(at + 30_000).toISOString())});`),
    ]);
    const r = spawnSync("/usr/bin/sqlite3", ["-init", "/dev/null", "-bail", cdb], { input: `${SCHEMA}\n${inserts.join("\n")}\n`, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`fixture sqlite3 failed: ${r.stderr}`);
  });

  it("a recorded closure that agrees, and a closed row offered for recording: exit 0", () => {
    const r = wrapper(["--db", cdb, "--ledger", file("clock.jsonl", [P, R])]);
    expect([r.status, r.stderr]).toEqual([0, ""]);
    const lines = r.stdout.split("\n");
    expect(lines[0]).toMatch(HEADER);
    const now = /checked at (\S+) /.exec(lines[0])?.[1];
    expect(lines.slice(1)).toEqual([
      LINE_P,
      `  recorded CONFIRMED at ${recorded}; recheck agrees`,
      LINE_R,
      `  "closed":${JSON.stringify({ state: "CONFIRMED", checkedAt: now, line: LINE_R })}`,
      "",
    ]);
  }, 60_000);

  it("a recorded closure the recheck disagrees with: MISMATCH, exit 3, every line still printed", () => {
    const r = wrapper(["--db", cdb, "--ledger", file("clock-mismatch.jsonl", [{ ...P, closed: { ...P.closed, state: "REFUTED" } }, R])]);
    expect([r.status, r.stderr]).toEqual([3, ""]);
    const lines = r.stdout.split("\n");
    expect(lines[0]).toMatch(HEADER);
    expect(lines.slice(1, 4)).toEqual([LINE_P, `  MISMATCH: recorded REFUTED at ${recorded}, recheck says CONFIRMED`, LINE_R]);
    expect(lines).toHaveLength(6);
  }, 60_000);

  it("at the clock a closure recorded later than the check is a file problem: exit 2", () => {
    const later = new Date(sec + 86_400_000).toISOString();
    const path = file("clock-later.jsonl", [{ ...P, closed: { ...P.closed, checkedAt: later } }]);
    const r = wrapper(["--db", cdb, "--ledger", path]);
    expect([r.status, r.stdout, r.stderr]).toEqual([
      2,
      "",
      `complaints-digest: ledger ${path} line 1: "checkedAt" in "closed" must be an ISO time at or after "since" and not later than the current time: less than 30 days after "since", or at least that for EXPIRED\n`,
    ]);
  }, 60_000);

  it("a replay with a closure dated after the real clock is a file problem too: exit 2", () => {
    const later = new Date(sec + 86_400_000).toISOString();
    const path = file("replay-later.jsonl", [{ ...P, closed: { ...P.closed, checkedAt: later } }]);
    const r = wrapper(["--db", cdb, "--now", new Date(sec - 86_400_000).toISOString(), "--ledger", path]);
    expect([r.status, r.stdout, r.stderr]).toEqual([
      2,
      "",
      `complaints-digest: ledger ${path} line 1: "checkedAt" in "closed" must be an ISO time at or after "since" and not later than the current time: less than 30 days after "since", or at least that for EXPIRED\n`,
    ]);
  }, 60_000);

  it("a caller's environment cannot claim the clock: the wrapper clears the marker, so --now stays a replay", () => {
    const env = { ...process.env, COMPLAINTS_DIGEST_NOW_FROM_CLOCK: "1" };
    const r = wrapper(["--db", cdb, "--now", new Date(sec).toISOString(), "--ledger", file("clock-env.jsonl", [{ ...P, closed: { ...P.closed, state: "REFUTED" } }])], env);
    expect([r.status, r.stdout.split("\n")[0]]).toEqual([0, expect.stringContaining("(a replay, not a recheck)")]);
  }, 60_000);
});

describe("the CLI on its own: marker values, which SQL each mode sends, the guard SQL's completed_at bound", () => {
  const TSX = join(REPO, "node_modules", ".bin", "tsx");
  const CLI = join(REPO, "scripts", "complaints-digest.ts");
  const cli = (args: string[], env: NodeJS.ProcessEnv = {}, input = "[]") =>
    spawnSync(TSX, [CLI, ...args], { cwd: REPO, env: { ...process.env, COMPLAINTS_DIGEST_NOW_FROM_CLOCK: undefined, ...env }, input, encoding: "utf8", timeout: 60_000 });
  const ROW = { id: "m", type: "ritual:m", since: "2026-11-15T12:00:00Z", maxComplaints: 0, runs: 1, change: "c", baseline: "b" };
  let f: string;
  beforeAll(() => {
    f = join(dir, "cli.jsonl");
    writeFileSync(f, `${JSON.stringify(ROW)}\n`);
  });

  it.each([["0"], ["true"], [""], ["1 "], ["yes"]])("marker %j is a replay; only \"1\" is a recheck", (value) => {
    const r = cli(["--now", NOW, "--ledger", f], { COMPLAINTS_DIGEST_NOW_FROM_CLOCK: value });
    expect([r.status, r.stderr, r.stdout.split("\n")[0]]).toEqual([0, "", expect.stringContaining("(a replay, not a recheck)")]);
    const c = cli(["--now", NOW, "--ledger", f], { COMPLAINTS_DIGEST_NOW_FROM_CLOCK: "1" });
    expect(c.stdout.split("\n")[0]).toContain("checked at 2026-11-20T18:00:00.000Z over");
  }, 60_000);

  it("the digest and --verdict send no guard SQL (no completed_at, no guard_tools); --ledger does", () => {
    const verdict = ["--verdict", "--type", "ritual:m", "--since", "2026-11-15T12:00:00Z", "--max-complaints", "0"];
    for (const facts of [[], ["--facts-table"]]) {
      for (const args of [[], ["--json"], verdict]) {
        const r = cli(["--print-sql", ...facts, "--now", NOW, ...args]);
        expect([r.status, r.stderr]).toEqual([0, ""]);
        expect(r.stdout).not.toMatch(/guard_tools|completed_at/);
      }
      const l = cli(["--print-sql", ...facts, "--now", NOW, "--ledger", f]);
      expect(l.stdout).toContain(" AS guard_tools");
    }
  }, 60_000);

  it("guard_tools: rows up to the completed_at second count (inclusive); a run with no completed_at keeps them all", () => {
    const gdb = join(dir, "guard-sql.db");
    const sql = [
      SCHEMA,
      `INSERT INTO tasks (task_id, status, created_at, completed_at, metadata) VALUES ('done', 'completed', '2026-11-16 12:00:00', '2026-11-16 12:01:00', '{"ritualId":"m"}');`,
      `INSERT INTO tasks (task_id, status, created_at, completed_at, metadata) VALUES ('open', 'needs_context', '2026-11-16 13:00:00', NULL, '{"ritualId":"m"}');`,
      ...["2026-11-16T12:01:00.999Z", "2026-11-16T12:01:01.000Z"].map((ts) => `INSERT INTO task_trace_events (task_id, name, tool, ts) VALUES ('done', 'tool.called', 'exa', '${ts}');`),
      ...["2026-11-16T13:00:30.000Z", "2026-11-17T00:00:00.000Z"].map((ts) => `INSERT INTO task_trace_events (task_id, name, tool, ts) VALUES ('open', 'tool.called', 'exa', '${ts}');`),
    ].join("\n");
    const b = spawnSync("/usr/bin/sqlite3", ["-init", "/dev/null", "-bail", gdb], { input: sql, encoding: "utf8" });
    expect(b.status).toBe(0);
    const q = cli(["--print-sql", "--now", NOW, "--ledger", f]);
    const r = spawnSync("/usr/bin/sqlite3", ["-init", "/dev/null", "-safe", "-readonly", "-bail", "-json", gdb], { input: q.stdout, encoding: "utf8" });
    expect(r.status).toBe(0);
    const rows = JSON.parse(r.stdout) as { task_id: string; completed_at: string | null; guard_tools: string }[];
    expect(rows.map((x) => [x.task_id, x.completed_at, x.guard_tools])).toEqual([
      ["done", "2026-11-16 12:01:00", '{"exa":1}'],
      ["open", null, '{"exa":2}'],
    ]);
  }, 60_000);
});

describe("--ledger, a run finished in the check's second (the same-second finality case)", () => {
  // z1 clean, finished long before; z2 clean, finished at F. Both made one exa
  // call. A tool.gated refused row for z2's call is written at F.900, after
  // completed_at = F but in its second.
  const F = "2026-11-16 13:01:00";
  const FISO = "2026-11-16T13:01:00.000Z";
  const plus = (ms: number) => new Date(Date.parse(FISO) + ms).toISOString();
  const ROW = { id: "z", type: "ritual:zz", since: "2026-11-16T00:00:00Z", maxComplaints: 0, runs: 2, change: "c", baseline: "b", guards: [{ tool: "exa", min: 1, maxBelow: 0 }] };
  const head = "z CONFIRMED, guard pending | ritual:zz since 2026-11-16T00:00:00.000Z: counted 2/2, complaints 0 (limit 0), unknown 0 [..]; ";
  const PENDING = `${head}guard exa >= 1 calls: 0 run(s) below (limit 0) pending; 1 counted run(s) not yet judged`;
  const BROKEN = "z CONFIRMED, guard broken | ritual:zz since 2026-11-16T00:00:00.000Z: counted 2/2, complaints 0 (limit 0), unknown 0 [..]; guard exa >= 1 calls: 1 run(s) below (limit 0) broken";
  let zdb: string;
  let f: string;
  const at = (now: string) => wrapper(["--db", zdb, "--now", now, "--ledger", f]).stdout.split("\n")[1];
  beforeAll(() => {
    zdb = join(dir, "settle.db");
    f = join(dir, "settle.jsonl");
    writeFileSync(f, `${JSON.stringify(ROW)}\n`);
    const sql = [
      SCHEMA,
      `INSERT INTO tasks (task_id, status, created_at, completed_at, metadata) VALUES ('z1', 'completed', '2026-11-16 12:00:00', '2026-11-16 12:01:00', '{"ritualId":"zz"}');`,
      `INSERT INTO tasks (task_id, status, created_at, completed_at, metadata) VALUES ('z2', 'completed', '2026-11-16 13:00:00', '${F}', '{"ritualId":"zz"}');`,
      `INSERT INTO task_trace_events (task_id, name, tool, ts) VALUES ('z1', 'tool.called', 'exa', '2026-11-16T12:00:30.000Z');`,
      `INSERT INTO task_trace_events (task_id, name, tool, ts) VALUES ('z2', 'tool.called', 'exa', '2026-11-16T13:00:30.000Z');`,
    ].join("\n");
    const r = spawnSync("/usr/bin/sqlite3", ["-init", "/dev/null", "-bail", zdb], { input: sql, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`fixture sqlite3 failed: ${r.stderr}`);
  });

  it("checked in F's second the guard is pending; the row lands at F.900; every check from F+1 on agrees it is broken", () => {
    expect(at(FISO)).toBe(PENDING);
    const add = spawnSync("/usr/bin/sqlite3", ["-init", "/dev/null", "-bail", zdb], {
      input: `INSERT INTO task_trace_events (task_id, name, tool, ts, attrs) VALUES ('z2', 'tool.gated', 'exa', '2026-11-16T13:01:00.900Z', '{"decision":"refused_turn_ended"}');\n`,
      encoding: "utf8",
    });
    expect(add.status).toBe(0);
    expect(at(plus(900))).toBe(PENDING);
    expect([at(plus(1000)), at(plus(60_000)), at(plus(86_400_000))]).toEqual([BROKEN, BROKEN, BROKEN]);
  }, 120_000);
});
