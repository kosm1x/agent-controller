/**
 * task_completion_facts — the table (schema migration v18) and its two
 * writers: the start write (build, no detail) and the end write (adds the
 * detail, keeps the start's build and time).
 *
 * Runs the REAL initDatabase: the table on a fresh DB and the migration on an
 * existing v17 DB, then the writers' row shapes and the shared concern cleaning.
 */
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase, initDatabase } from "./index.js";
import { recordCompletionFacts, recordTaskBuild } from "./task-completion-facts.js";
import { cleanConcernDetail } from "./task-outcomes.js";

let tmpDbPath: string | null = null;

afterEach(() => {
  closeDatabase();
  if (tmpDbPath) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        if (existsSync(tmpDbPath + suffix)) unlinkSync(tmpDbPath + suffix);
      } catch {
        /* best-effort cleanup */
      }
    }
    tmpDbPath = null;
  }
});

/** [name, type, notnull, pk, default] per column, in table order. */
const columns = (db: Database.Database) =>
  (
    db.prepare("PRAGMA table_info(task_completion_facts)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
      dflt_value: string | null;
    }>
  ).map((c) => [c.name, c.type, c.notnull, c.pk, c.dflt_value]);

const EXPECTED_COLUMNS = [
  ["task_id", "TEXT", 0, 1, null],
  ["build", "TEXT", 0, 0, null],
  ["concern_detail", "TEXT", 0, 0, null],
  ["created_at", "TEXT", 1, 0, "datetime('now')"],
];

const row = (taskId: string) =>
  getDatabase()
    .prepare("SELECT * FROM task_completion_facts WHERE task_id = ?")
    .get(taskId) as
    | { task_id: string; build: string | null; concern_detail: string | null; created_at: string }
    | undefined;

describe("migration v18 — task_completion_facts", () => {
  it("fresh DB: head is v19 with the four columns, task_id the primary key", () => {
    initDatabase(":memory:");
    const db = getDatabase();
    expect(db.pragma("user_version", { simple: true })).toBe(19);
    expect(columns(db)).toEqual(EXPECTED_COLUMNS);
  });

  it("existing v17 DB (no table, rows elsewhere): v18 creates the same columns; a re-run pinned to 17 keeps the rows", () => {
    tmpDbPath = join(tmpdir(), `mc-completion-facts-${process.pid}-${Date.now()}.db`);
    initDatabase(tmpDbPath);
    closeDatabase();
    const raw = new Database(tmpDbPath);
    raw.exec(`
      DROP TABLE task_completion_facts;
      PRAGMA user_version = 17;
    `);
    raw
      .prepare("INSERT INTO conversations (bank, tags, content, trust_tier, source) VALUES ('mc-jarvis', '[]', 'hola', 2, 'agent')")
      .run();
    raw.close();

    initDatabase(tmpDbPath);
    let db = getDatabase();
    expect(db.pragma("user_version", { simple: true })).toBe(19);
    expect(columns(db)).toEqual(EXPECTED_COLUMNS);
    expect(db.prepare("SELECT COUNT(*) AS n FROM conversations").get()).toEqual({ n: 1 });
    recordCompletionFacts("t-kept", { build: "abc1234", concernDetail: "nota" });

    closeDatabase();
    const pin = new Database(tmpDbPath);
    pin.exec("PRAGMA user_version = 17;");
    pin.close();
    expect(() => initDatabase(tmpDbPath!)).not.toThrow();
    db = getDatabase();
    expect(db.pragma("user_version", { simple: true })).toBe(19);
    expect(row("t-kept")).toMatchObject({ build: "abc1234", concern_detail: "nota" });
  });
});

const OLD_TIME = "2001-02-03 04:05:06";

/** Pins a row's stored creation time to a fixed old value, by SQL. */
const ageRow = (taskId: string) =>
  getDatabase()
    .prepare("UPDATE task_completion_facts SET created_at = ? WHERE task_id = ?")
    .run(OLD_TIME, taskId);

/** Neighbour rows on both sides of "t-b" that no write to "t-b" may touch. */
const seedNeighbours = () => {
  const ins = getDatabase().prepare(
    "INSERT INTO task_completion_facts (task_id, build, concern_detail, created_at) VALUES (?, ?, ?, ?)",
  );
  ins.run("t-a", "aaa0001", "vecina baja", "2002-01-01 00:00:00");
  ins.run("t-c", "ccc0003", "vecina alta", "2003-01-01 00:00:00");
};
const neighbours = () =>
  getDatabase()
    .prepare("SELECT * FROM task_completion_facts WHERE task_id <> 't-b' ORDER BY task_id")
    .all();
const NEIGHBOURS = [
  { task_id: "t-a", build: "aaa0001", concern_detail: "vecina baja", created_at: "2002-01-01 00:00:00" },
  { task_id: "t-c", build: "ccc0003", concern_detail: "vecina alta", created_at: "2003-01-01 00:00:00" },
];

describe("recordTaskBuild (the start write)", () => {
  it("writes one row: the build, NULL detail and the database's own time", () => {
    initDatabase(":memory:");
    seedNeighbours();
    recordTaskBuild("t-b", "abc1234");
    const r = row("t-b")!;
    expect(r).toMatchObject({ task_id: "t-b", build: "abc1234", concern_detail: null });
    expect(r.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(r.created_at).not.toBe(OLD_TIME);
    expect(neighbours()).toEqual(NEIGHBOURS);
  });

  it("a second start write replaces the build and the creation time, and leaves no detail behind", () => {
    initDatabase(":memory:");
    seedNeighbours();
    recordTaskBuild("t-b", "abc1234");
    getDatabase()
      .prepare("UPDATE task_completion_facts SET concern_detail = 'anterior' WHERE task_id = 't-b'")
      .run();
    ageRow("t-b");
    recordTaskBuild("t-b", "def5678");
    const r = row("t-b")!;
    expect(r).toMatchObject({ build: "def5678", concern_detail: null });
    expect(r.created_at).not.toBe(OLD_TIME);
    expect(neighbours()).toEqual(NEIGHBOURS);
  });

  it("an unknown build is stored as NULL", () => {
    initDatabase(":memory:");
    recordTaskBuild("t-b", null);
    expect(row("t-b")).toMatchObject({ build: null, concern_detail: null });
  });
});

describe("recordCompletionFacts (the end write)", () => {
  it("with no row yet (the start write failed): writes the full row — build, cleaned detail and the database's own time", () => {
    initDatabase(":memory:");
    recordCompletionFacts("t-1", { build: "abc1234", concernDetail: "  sin datos del día  " });
    const r = row("t-1")!;
    expect(r).toMatchObject({ task_id: "t-1", build: "abc1234", concern_detail: "sin datos del día" });
    expect(r.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(getDatabase().prepare("SELECT COUNT(*) AS n FROM task_completion_facts").get()).toEqual({ n: 1 });
  });

  it("on the start row: only the detail changes — the start's build and creation time stay", () => {
    initDatabase(":memory:");
    seedNeighbours();
    recordTaskBuild("t-b", "abc1234");
    ageRow("t-b");
    recordCompletionFacts("t-b", { build: "def5678", concernDetail: "  falta un dato  " });
    expect(row("t-b")).toEqual({
      task_id: "t-b",
      build: "abc1234",
      concern_detail: "falta un dato",
      created_at: OLD_TIME,
    });
    expect(neighbours()).toEqual(NEIGHBOURS);
  });

  it("on a row with a detail: a clean end replaces the detail with NULL, the build stays", () => {
    initDatabase(":memory:");
    recordCompletionFacts("t-2", { build: "abc1234", concernDetail: "primera" });
    recordCompletionFacts("t-2", { build: "def5678", concernDetail: null });
    expect(getDatabase().prepare("SELECT COUNT(*) AS n FROM task_completion_facts").get()).toEqual({ n: 1 });
    expect(row("t-2")).toMatchObject({ build: "abc1234", concern_detail: null });
  });

  it("the stored detail is redacted BEFORE the 500-char cut", () => {
    initDatabase(":memory:");
    // Built at runtime — no key-shaped literal in the (public) repo.
    const key = "AIza" + "b".repeat(35);
    recordCompletionFacts("t-3", {
      build: null,
      concernDetail: ` no pude confirmar con ${key} ${"z".repeat(600)}`,
    });
    const detail = row("t-3")!.concern_detail!;
    expect(detail.startsWith("no pude confirmar con [REDACTED")).toBe(true);
    expect(detail).not.toMatch(/AIza|bbbbb/);
    expect(detail.length).toBe(500);
    expect(detail).toBe(cleanConcernDetail(` no pude confirmar con ${key} ${"z".repeat(600)}`));
  });

  it("blank or non-string detail and an unknown build are stored as NULL", () => {
    initDatabase(":memory:");
    recordCompletionFacts("t-blank", { build: null, concernDetail: "   " });
    recordCompletionFacts("t-obj", { build: null, concernDetail: { not: "a string" } });
    recordCompletionFacts("t-none", { build: null, concernDetail: null });
    for (const id of ["t-blank", "t-obj", "t-none"]) {
      expect([id, row(id)]).toMatchObject([id, { build: null, concern_detail: null }]);
    }
  });
});

describe("cleanConcernDetail", () => {
  it("trims, keeps short text, and returns null for blank or non-string input", () => {
    expect(cleanConcernDetail("  hola  ")).toBe("hola");
    expect(cleanConcernDetail("")).toBeNull();
    expect(cleanConcernDetail("   ")).toBeNull();
    expect(cleanConcernDetail(42)).toBeNull();
    expect(cleanConcernDetail(null)).toBeNull();
    expect(cleanConcernDetail(undefined)).toBeNull();
  });
});
