/**
 * Schema migration v13 — memory_tombstones.
 *
 * The terms of a JME fact that was superseded, reworded or expired, read by
 * the recall filter (src/memory/tombstones.ts, MEMORY_TOMBSTONES). These
 * tests run the REAL initDatabase: the table, its CHECK and its index on a
 * fresh DB, and the migration on an existing v12 DB that has rows.
 */
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase, initDatabase } from "./index.js";

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

const columns = (db: Database.Database): string[] =>
  (db.prepare("PRAGMA table_info(memory_tombstones)").all() as Array<{ name: string }>).map((c) => c.name);

const INSERT = "INSERT INTO memory_tombstones (fact_id, reason, terms, new_terms) VALUES (?, ?, ?, ?)";

describe("migration v13 — memory_tombstones", () => {
  it("fresh DB: head is v13 with the table, its columns and the created_at index", () => {
    initDatabase(":memory:");
    const db = getDatabase();
    expect(db.pragma("user_version", { simple: true })).toBe(13);
    expect(columns(db)).toEqual(["id", "created_at", "fact_id", "reason", "terms", "new_terms"]);
    const idx = db.prepare("PRAGMA index_xinfo(idx_memory_tombstones_created)").all() as Array<{
      name: string | null;
      desc: number;
      key: number;
    }>;
    expect(idx.filter((c) => c.key === 1).map((c) => [c.name, c.desc])).toEqual([["created_at", 1]]);
  });

  it("created_at defaults to the conversations format (UTC, YYYY-MM-DD HH:MM:SS)", () => {
    initDatabase(":memory:");
    const db = getDatabase();
    db.prepare(INSERT).run(1, "expired", '["5821"]', "[]");
    const { created_at } = db.prepare("SELECT created_at FROM memory_tombstones").get() as { created_at: string };
    expect(created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("reason takes superseded | reworded | expired only; terms and new_terms are required", () => {
    initDatabase(":memory:");
    const db = getDatabase();
    for (const reason of ["superseded", "reworded", "expired"]) {
      expect(() => db.prepare(INSERT).run(1, reason, "[]", "[]")).not.toThrow();
    }
    expect(() => db.prepare(INSERT).run(1, "deleted", "[]", "[]")).toThrow(/CHECK/);
    expect(() => db.prepare(INSERT).run(1, "expired", null, "[]")).toThrow(/NOT NULL/);
    expect(() => db.prepare(INSERT).run(1, "expired", "[]", null)).toThrow(/NOT NULL/);
  });

  it("existing v12 DB (no table, rows elsewhere): v13 creates it; a re-run pinned to 12 is a no-op", () => {
    tmpDbPath = join(tmpdir(), `mc-memory-tombstones-${process.pid}-${Date.now()}.db`);
    initDatabase(tmpDbPath);
    closeDatabase();
    const raw = new Database(tmpDbPath);
    raw.exec(`
      DROP TABLE memory_tombstones;
      PRAGMA user_version = 12;
    `);
    raw
      .prepare("INSERT INTO conversations (bank, tags, content, trust_tier, source) VALUES ('mc-jarvis', '[]', 'hola', 2, 'agent')")
      .run();
    raw.close();

    initDatabase(tmpDbPath);
    let db = getDatabase();
    expect(db.pragma("user_version", { simple: true })).toBe(13);
    expect(columns(db)).toEqual(["id", "created_at", "fact_id", "reason", "terms", "new_terms"]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM conversations").get()).toEqual({ n: 1 });
    db.prepare(INSERT).run(4, "superseded", '["5821"]', '["7394"]');

    closeDatabase();
    const pin = new Database(tmpDbPath);
    pin.exec("PRAGMA user_version = 12;");
    pin.close();
    expect(() => initDatabase(tmpDbPath!)).not.toThrow();
    db = getDatabase();
    expect(db.pragma("user_version", { simple: true })).toBe(13);
    expect(db.prepare("SELECT fact_id, reason, terms, new_terms FROM memory_tombstones").all()).toEqual([
      { fact_id: 4, reason: "superseded", terms: '["5821"]', new_terms: '["7394"]' },
    ]);
  });
});
