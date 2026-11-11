/**
 * initDatabase on a REAL file that fails during setup leaves no handle behind.
 *
 * A file of garbage bytes opens fine (SQLite reads the header lazily) and the
 * first pragma inside the setup step throws SQLITE_NOTADB. After that,
 * getDatabase() must refuse and a later initDatabase() must initialise for
 * real instead of returning the half-built handle.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase, initDatabase } from "./index.js";

let dir: string | null = null;

afterEach(() => {
  closeDatabase();
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = null;
  }
});

describe("initDatabase on a file that is not a database", () => {
  it("throws, leaves no handle, and a later call on a good path initialises", () => {
    dir = mkdtempSync(join(tmpdir(), "init-failure-"));
    const garbage = join(dir, "garbage.db");
    writeFileSync(garbage, Buffer.from("not a sqlite database ".repeat(64)));

    expect(() => initDatabase(garbage)).toThrow(/not a database/);
    expect(() => getDatabase()).toThrow("Database not initialized");

    const db = initDatabase(join(dir, "good.db"));
    expect(getDatabase()).toBe(db);
    expect(db.prepare("SELECT 1 AS one").get()).toEqual({ one: 1 });
  });
});
