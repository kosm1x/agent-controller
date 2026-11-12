/**
 * Schema migration v17 — mailbox_password_seen.
 *
 * Fingerprints (never values) of the passwords the mailbox tool printed,
 * read by src/lib/v8-4/mailbox-passwords.ts. These tests run the REAL
 * initDatabase: the table on a fresh DB, and the migration on an existing
 * v16 DB that has rows elsewhere.
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

const columns = (db: Database.Database) =>
  (
    db.prepare("PRAGMA table_info(mailbox_password_seen)").all() as Array<{
      name: string;
      pk: number;
      notnull: number;
    }>
  ).map((c) => [c.name, c.pk, c.notnull]);

const FP = "a".repeat(64);

describe("migration v17 — mailbox_password_seen", () => {
  it("fresh DB: head is v17 with the fingerprint primary key and a first-seen time", () => {
    initDatabase(":memory:");
    const db = getDatabase();
    expect(db.pragma("user_version", { simple: true })).toBe(17);
    expect(columns(db)).toEqual([
      ["fingerprint", 1, 1],
      ["first_seen", 0, 1],
    ]);
    db.prepare("INSERT INTO mailbox_password_seen (fingerprint) VALUES (?)").run(FP);
    expect(() =>
      db.prepare("INSERT INTO mailbox_password_seen (fingerprint) VALUES (?)").run(FP),
    ).toThrow(/UNIQUE|PRIMARY/);
    const { first_seen } = db.prepare("SELECT first_seen FROM mailbox_password_seen").get() as {
      first_seen: string;
    };
    expect(first_seen).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("existing v16 DB (no table, rows elsewhere): v17 creates it; a re-run pinned to 16 is a no-op", () => {
    tmpDbPath = join(tmpdir(), `mc-mailbox-seen-${process.pid}-${Date.now()}.db`);
    initDatabase(tmpDbPath);
    closeDatabase();
    const raw = new Database(tmpDbPath);
    raw.exec(`
      DROP TABLE mailbox_password_seen;
      PRAGMA user_version = 16;
    `);
    raw
      .prepare("INSERT INTO conversations (bank, tags, content, trust_tier, source) VALUES ('mc-jarvis', '[]', 'hola', 2, 'agent')")
      .run();
    raw.close();

    initDatabase(tmpDbPath);
    let db = getDatabase();
    expect(db.pragma("user_version", { simple: true })).toBe(17);
    expect(columns(db).map((c) => c[0])).toEqual(["fingerprint", "first_seen"]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM conversations").get()).toEqual({ n: 1 });
    db.prepare("INSERT INTO mailbox_password_seen (fingerprint) VALUES (?)").run(FP);

    closeDatabase();
    const pin = new Database(tmpDbPath);
    pin.exec("PRAGMA user_version = 16;");
    pin.close();
    expect(() => initDatabase(tmpDbPath!)).not.toThrow();
    db = getDatabase();
    expect(db.pragma("user_version", { simple: true })).toBe(17);
    expect(db.prepare("SELECT fingerprint FROM mailbox_password_seen").all()).toEqual([{ fingerprint: FP }]);
  });
});
