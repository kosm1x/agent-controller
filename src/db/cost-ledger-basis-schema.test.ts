/**
 * Schema migration v8 — `cost_ledger.cost_basis` (queue §2026-10-07 item 5).
 *
 * Runs the REAL initDatabase on a fresh DB and on a DB pinned at v7 without
 * the column (the live state before deploy), then writes through the real
 * recordCost into a real row. budget/service.test.ts mocks ./index.js, so it
 * cannot see the column.
 */
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase, initDatabase } from "./index.js";
import { recordCost } from "../budget/service.js";

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

function ledgerCols(db: Database.Database): string[] {
  return (
    db.prepare("PRAGMA table_info(cost_ledger)").all() as Array<{
      name: string;
    }>
  ).map((c) => c.name);
}

const base = {
  taskId: "t",
  agentType: "fast",
  model: "claude-sonnet-5-5",
  promptTokens: 1000,
  completionTokens: 100,
  costUsdOverride: 0.01,
};

describe("migration v8 — cost_ledger.cost_basis", () => {
  it("fresh DB: head is v8 and recordCost writes the basis, NULL when absent", () => {
    initDatabase(":memory:");
    const db = getDatabase();
    expect(db.pragma("user_version", { simple: true })).toBe(8);
    expect(ledgerCols(db)).toContain("cost_basis");

    recordCost({ ...base, runId: "with", costBasis: "list" });
    recordCost({ ...base, runId: "without" });
    const rows = db
      .prepare("SELECT run_id, cost_basis FROM cost_ledger ORDER BY id")
      .all() as Array<{ run_id: string; cost_basis: string | null }>;
    expect(rows).toEqual([
      { run_id: "with", cost_basis: "list" },
      { run_id: "without", cost_basis: null },
    ]);
  });

  it("existing v7 DB without the column: v8 adds it, old rows read NULL", () => {
    tmpDbPath = join(tmpdir(), `mc-cost-basis-${process.pid}-${Date.now()}.db`);
    initDatabase(tmpDbPath);
    closeDatabase();
    const raw = new Database(tmpDbPath);
    raw.exec(
      `ALTER TABLE cost_ledger DROP COLUMN cost_basis; PRAGMA user_version = 7;`,
    );
    raw
      .prepare(
        `INSERT INTO cost_ledger (run_id, task_id, agent_type) VALUES ('old', 't', 'fast')`,
      )
      .run();
    expect(ledgerCols(raw)).not.toContain("cost_basis");
    raw.close();

    initDatabase(tmpDbPath);
    const db = getDatabase();
    expect(db.pragma("user_version", { simple: true })).toBe(8);
    expect(ledgerCols(db)).toContain("cost_basis");
    const row = db
      .prepare(`SELECT cost_basis FROM cost_ledger WHERE run_id = 'old'`)
      .get() as { cost_basis: string | null };
    expect(row.cost_basis).toBeNull();
  });

  it("a DB pinned below v8 that already has the column re-boots cleanly", () => {
    tmpDbPath = join(
      tmpdir(),
      `mc-cost-basis-rerun-${process.pid}-${Date.now()}.db`,
    );
    initDatabase(tmpDbPath);
    closeDatabase();
    const raw = new Database(tmpDbPath);
    raw.exec(`PRAGMA user_version = 7;`);
    raw.close();

    expect(() => initDatabase(tmpDbPath!)).not.toThrow();
    expect(getDatabase().pragma("user_version", { simple: true })).toBe(8);
  });
});
