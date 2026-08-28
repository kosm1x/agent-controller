/**
 * Schema migration v5 — `jme_signals` (memory plan v2.0, Track 2).
 *
 * Runs the REAL initDatabase on a fresh DB (user_version 0 → 5) and on a DB
 * pinned at v4, asserting the table, its index, the kind CHECK and the final
 * user_version. jme.test.ts hand-copies the DDL into its own fixture, so
 * without this file deleting the migration leaves the suite green
 * (qa-audit R1 W9).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase, initDatabase } from "./index.js";
import { PREFERENCE_SIGNAL_KINDS } from "../memory/preference-signals.js";

let tmpDbPath: string | null = null;

beforeEach(() => {
  tmpDbPath = null;
});
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
  }
});

function signalsShape(db: Database.Database) {
  const table = db
    .prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='jme_signals'`,
    )
    .get() as { sql: string } | undefined;
  const index = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_jme_signals_ts'`,
    )
    .get() as { name: string } | undefined;
  return { table: table?.sql ?? null, index: index?.name ?? null };
}

describe("migration v5 — jme_signals", () => {
  it("fresh DB: user_version ends at 5 with the table, index and kind CHECK", () => {
    initDatabase(":memory:");
    const db = getDatabase();
    expect(db.pragma("user_version", { simple: true })).toBe(5);
    const { table, index } = signalsShape(db);
    expect(table).toMatch(/kind\s+TEXT NOT NULL CHECK\(kind IN \(/);
    expect(index).toBe("idx_jme_signals_ts");
    // The CHECK list is exactly the tagger's kind tuple.
    for (const kind of PREFERENCE_SIGNAL_KINDS)
      expect(table).toContain(`'${kind}'`);
    expect(() =>
      db
        .prepare(
          `INSERT INTO jme_signals (task_id, ts, kind, snippet) VALUES ('t', 1, 'bogus', 's')`,
        )
        .run(),
    ).toThrow(/CHECK/);
    db.prepare(
      `INSERT INTO jme_signals (task_id, ts, kind, snippet) VALUES ('t', 1, 'length', 's')`,
    ).run();
    expect(
      (
        db.prepare(`SELECT COUNT(*) AS n FROM jme_signals`).get() as {
          n: number;
        }
      ).n,
    ).toBe(1);
  });

  it("existing v4 DB: only v5 applies and creates the table", () => {
    tmpDbPath = join(
      tmpdir(),
      `mc-jme-signals-${process.pid}-${Date.now()}.db`,
    );
    // Bring a file DB to the full current schema, then pin it back to v4
    // and drop the v5 objects — the state a live DB is in before deploy.
    initDatabase(tmpDbPath);
    closeDatabase();
    const raw = new Database(tmpDbPath);
    raw.exec(`DROP TABLE IF EXISTS jme_signals; PRAGMA user_version = 4;`);
    raw.close();

    initDatabase(tmpDbPath);
    const db = getDatabase();
    expect(db.pragma("user_version", { simple: true })).toBe(5);
    expect(signalsShape(db).index).toBe("idx_jme_signals_ts");
  });
});
