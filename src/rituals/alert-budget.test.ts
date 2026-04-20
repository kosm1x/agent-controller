import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "fs";
import { resolve } from "path";

let db: Database.Database;

function freshDb() {
  const d = new Database(":memory:");
  const schema = readFileSync(resolve(__dirname, "../db/schema.sql"), "utf8");
  const f1 = schema.substring(schema.indexOf("-- F1 Data Layer"));
  d.exec(f1);
  return d;
}

vi.mock("../db/index.js", () => ({
  getDatabase: () => db,
}));

import {
  DEFAULT_LIMITS,
  consumeBudget,
  getBudgetForDate,
  getBudgetStatus,
  initBudget,
  recordRitualTokensForTask,
  resetBudgetForDate,
} from "./alert-budget.js";

const DATE = "2026-04-20";

describe("initBudget", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("creates a row with default limit on first call", () => {
    const status = initBudget("market-morning-scan", { date: DATE });
    expect(status.consumed).toBe(0);
    expect(status.limit).toBe(DEFAULT_LIMITS["market-morning-scan"]);
    expect(status.remaining).toBe(DEFAULT_LIMITS["market-morning-scan"]);
    expect(status.exhausted).toBe(false);
  });

  it("uses explicit limit override", () => {
    const status = initBudget("market-morning-scan", {
      date: DATE,
      limit: 500,
    });
    expect(status.limit).toBe(500);
  });

  it("is idempotent — repeat calls do not reset consumption", () => {
    initBudget("market-morning-scan", { date: DATE });
    consumeBudget("market-morning-scan", 1234, { date: DATE });
    const after = initBudget("market-morning-scan", { date: DATE });
    expect(after.consumed).toBe(1234);
  });

  it("falls back to 10k limit for unknown rituals", () => {
    const status = initBudget("unknown-ritual", { date: DATE });
    expect(status.limit).toBe(10_000);
  });
});

describe("consumeBudget", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("first consume inserts row and records tokens", () => {
    const status = consumeBudget("market-morning-scan", 500, { date: DATE });
    expect(status.consumed).toBe(500);
    expect(status.exhausted).toBe(false);
  });

  it("subsequent consumes accumulate", () => {
    consumeBudget("market-morning-scan", 500, { date: DATE });
    consumeBudget("market-morning-scan", 300, { date: DATE });
    const status = getBudgetStatus("market-morning-scan", DATE)!;
    expect(status.consumed).toBe(800);
  });

  it("sets exhausted=true and stamps exhausted_at when consumed >= limit", () => {
    initBudget("market-morning-scan", { date: DATE, limit: 1000 });
    const status = consumeBudget("market-morning-scan", 1200, { date: DATE });
    expect(status.exhausted).toBe(true);
    expect(status.remaining).toBe(0);
  });

  it("over-consumption clips remaining at 0 (not negative)", () => {
    initBudget("market-morning-scan", { date: DATE, limit: 1000 });
    const status = consumeBudget("market-morning-scan", 10_000, { date: DATE });
    expect(status.remaining).toBe(0);
    expect(status.consumed).toBe(10_000); // raw counter keeps accurate history
  });

  it("throws on negative token count", () => {
    expect(() =>
      consumeBudget("market-morning-scan", -1, { date: DATE }),
    ).toThrow(/tokens must be finite/);
  });

  it("throws on NaN tokens", () => {
    expect(() =>
      consumeBudget("market-morning-scan", NaN, { date: DATE }),
    ).toThrow();
  });

  it("rounds fractional tokens to integer (LLM usage counts are int)", () => {
    const status = consumeBudget("market-morning-scan", 123.7, { date: DATE });
    expect(Number.isInteger(status.consumed)).toBe(true);
  });
});

describe("per-ritual isolation", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("morning and eod consumption tracked separately", () => {
    consumeBudget("market-morning-scan", 5000, { date: DATE });
    consumeBudget("market-eod-scan", 3000, { date: DATE });
    const morning = getBudgetStatus("market-morning-scan", DATE)!;
    const eod = getBudgetStatus("market-eod-scan", DATE)!;
    expect(morning.consumed).toBe(5000);
    expect(eod.consumed).toBe(3000);
  });
});

describe("per-date isolation", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("two consecutive days track independently", () => {
    consumeBudget("market-morning-scan", 5000, { date: "2026-04-20" });
    consumeBudget("market-morning-scan", 1000, { date: "2026-04-21" });
    const d1 = getBudgetStatus("market-morning-scan", "2026-04-20")!;
    const d2 = getBudgetStatus("market-morning-scan", "2026-04-21")!;
    expect(d1.consumed).toBe(5000);
    expect(d2.consumed).toBe(1000);
  });
});

describe("getBudgetStatus", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("returns null when no row exists", () => {
    expect(getBudgetStatus("market-morning-scan", DATE)).toBeNull();
  });
});

describe("getBudgetForDate", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("returns all ritual statuses for a given date, sorted by ritual_id", () => {
    consumeBudget("market-morning-scan", 5000, { date: DATE });
    consumeBudget("market-eod-scan", 3000, { date: DATE });
    const all = getBudgetForDate(DATE);
    expect(all.length).toBe(2);
    expect(all[0]!.ritualId).toBe("market-eod-scan"); // alphabetical
    expect(all[1]!.ritualId).toBe("market-morning-scan");
  });
});

describe("resetBudgetForDate", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("deletes all rows for the given date, returning count", () => {
    consumeBudget("market-morning-scan", 1, { date: DATE });
    consumeBudget("market-eod-scan", 1, { date: DATE });
    consumeBudget("market-morning-scan", 1, { date: "2026-04-21" });
    const deleted = resetBudgetForDate(DATE);
    expect(deleted).toBe(2);
    expect(getBudgetStatus("market-morning-scan", DATE)).toBeNull();
    expect(getBudgetStatus("market-morning-scan", "2026-04-21")).not.toBeNull();
  });
});

describe("recordRitualTokensForTask (F9 audit W-R2-2)", () => {
  beforeEach(() => {
    db = freshDb();
    // Minimal `runs` shape for this test — full schema lives above F1 cut
    // which freshDb doesn't include. Only the columns the helper queries.
    db.exec(`CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY,
      task_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      token_usage TEXT
    )`);
  });

  function seedRun(taskId: string, tokenUsage: string | null, id = 1) {
    db.prepare(
      `INSERT INTO runs (id, task_id, created_at, token_usage)
       VALUES (?, ?, datetime('now'), ?)`,
    ).run(id, taskId, tokenUsage);
  }

  it("returns null when no run row exists for the task", () => {
    const result = recordRitualTokensForTask("market-morning-scan", "t-x");
    expect(result).toBeNull();
  });

  it("returns null when token_usage is null", () => {
    seedRun("t-1", null);
    const result = recordRitualTokensForTask("market-morning-scan", "t-1");
    expect(result).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    seedRun("t-2", "{not json");
    const result = recordRitualTokensForTask("market-morning-scan", "t-2");
    expect(result).toBeNull();
  });

  it("returns null when promptTokens + completionTokens sum to 0", () => {
    seedRun("t-3", JSON.stringify({ promptTokens: 0, completionTokens: 0 }));
    const result = recordRitualTokensForTask("market-morning-scan", "t-3");
    expect(result).toBeNull();
  });

  it("charges budget on happy path", () => {
    seedRun(
      "t-4",
      JSON.stringify({ promptTokens: 1200, completionTokens: 800 }),
    );
    const result = recordRitualTokensForTask("market-morning-scan", "t-4");
    expect(result).not.toBeNull();
    expect(result!.consumed).toBe(2000);
  });

  it("picks the most recent run when multiple exist for one task", () => {
    seedRun(
      "t-5",
      JSON.stringify({ promptTokens: 100, completionTokens: 100 }),
    );
    seedRun(
      "t-5",
      JSON.stringify({ promptTokens: 2500, completionTokens: 2500 }),
      2,
    );
    const result = recordRitualTokensForTask("market-morning-scan", "t-5");
    expect(result!.consumed).toBe(5000); // uses id=2 (most recent)
  });
});
