/**
 * openDatabaseReadOnly: an operator script's handle on an EXISTING database that
 * cannot write to it and runs none of initDatabase's set-up. Synthetic database
 * files in this test's temp folder only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SCHEMA_MIGRATION_HEAD,
  closeDatabase,
  getDatabase,
  initDatabase,
  openDatabaseReadOnly,
} from "./index.js";

let dir = "";
let file = "";

beforeEach(() => {
  dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "mc-db-readonly-test-"));
  file = join(dir, "synthetic.db");
});

afterEach(() => {
  closeDatabase();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

/** A database with one table and the given user_version (no initDatabase). */
function makeDb(version: number, wal = false): void {
  const db = new Database(file);
  if (wal) db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)");
  db.prepare("INSERT INTO notes (body) VALUES (?)").run("synthetic");
  db.pragma(`user_version = ${version}`);
  db.close();
}

const fingerprint = (p: string): [string, number] => [
  createHash("sha256").update(readFileSync(p)).digest("hex"),
  statSync(p).mtimeMs,
];
const tables = (db: Database.Database): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map(
    (r) => r.name,
  );

describe("SCHEMA_MIGRATION_HEAD", () => {
  it("is the version a fresh initDatabase ends at (the last SCHEMA_MIGRATIONS entry)", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    initDatabase(":memory:");
    expect(getDatabase().pragma("user_version", { simple: true })).toBe(SCHEMA_MIGRATION_HEAD);
  });
});

describe("openDatabaseReadOnly", () => {
  it("installs a read-only handle: reads work, writes throw, no set-up runs, the file is unchanged", () => {
    makeDb(SCHEMA_MIGRATION_HEAD);
    const before = fingerprint(file);
    const h = openDatabaseReadOnly(file);
    expect(getDatabase()).toBe(h);
    expect(h.readonly).toBe(true);
    expect(h.prepare("SELECT body FROM notes").get()).toEqual({ body: "synthetic" });
    expect(() => h.prepare("INSERT INTO notes (body) VALUES ('x')").run()).toThrow(
      expect.objectContaining({ code: "SQLITE_READONLY" }),
    );
    expect(() => h.exec("CREATE TABLE extra (a)")).toThrow(expect.objectContaining({ code: "SQLITE_READONLY" }));
    // initDatabase's schema file would have created jarvis_files, tasks, ...
    expect(tables(h)).toEqual(["notes"]);
    closeDatabase();
    expect(fingerprint(file)).toEqual(before);
    expect(existsSync(`${file}-wal`)).toBe(false);
    const check = new Database(file, { readonly: true });
    expect(tables(check)).toEqual(["notes"]);
    check.close();
  });

  it("reads a WAL database that a running writer holds open, and changes no byte of it", () => {
    makeDb(SCHEMA_MIGRATION_HEAD, true);
    const writer = new Database(file); // stands in for the running service
    writer.prepare("INSERT INTO notes (body) VALUES (?)").run("in the wal");
    const before = fingerprint(file);
    const h = openDatabaseReadOnly(file);
    expect((h.prepare("SELECT COUNT(*) AS n FROM notes").get() as { n: number }).n).toBe(2);
    closeDatabase();
    expect(fingerprint(file)).toEqual(before);
    writer.close();
  });

  for (const delta of [-1, 1]) {
    it(`refuses user_version ${delta < 0 ? "below" : "above"} the head, closed and not installed`, () => {
      makeDb(SCHEMA_MIGRATION_HEAD + delta);
      const before = fingerprint(file);
      expect(() => openDatabaseReadOnly(file)).toThrow(expect.objectContaining({ code: "SCHEMA_MISMATCH" }));
      expect(() => getDatabase()).toThrow(/not initialized/);
      expect(fingerprint(file)).toEqual(before);
    });
  }

  it("refuses a missing file without creating it", () => {
    expect(() => openDatabaseReadOnly(file)).toThrow();
    expect(existsSync(file)).toBe(false);
    expect(() => getDatabase()).toThrow(/not initialized/);
  });

  it("refuses when a database is already open", () => {
    makeDb(SCHEMA_MIGRATION_HEAD);
    openDatabaseReadOnly(file);
    expect(() => openDatabaseReadOnly(file)).toThrow(expect.objectContaining({ code: "DB_ALREADY_OPEN" }));
  });
});

describe("closeDatabase", () => {
  it("closes a read-only handle without a checkpoint", () => {
    makeDb(SCHEMA_MIGRATION_HEAD);
    const h = openDatabaseReadOnly(file);
    const pragma = vi.spyOn(h, "pragma");
    closeDatabase();
    expect(pragma).not.toHaveBeenCalled();
    expect(h.open).toBe(false);
    expect(() => getDatabase()).toThrow(/not initialized/);
  });

  it("still checkpoints a read-write handle", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const h = initDatabase(":memory:");
    const pragma = vi.spyOn(h, "pragma");
    closeDatabase();
    expect(pragma).toHaveBeenCalledWith("wal_checkpoint(PASSIVE)");
    expect(h.open).toBe(false);
  });
});
