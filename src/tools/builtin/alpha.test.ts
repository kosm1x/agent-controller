/**
 * F7 alpha tool-handler tests.
 *
 * Uses a real in-memory SQLite DB loaded with the project schema so the
 * full persist → read round-trip is exercised. Matches the pattern used
 * in sentiment.test.ts / signals.test.ts / whales.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "fs";
import { resolve } from "path";

let db: Database.Database;

function freshDb() {
  const d = new Database(":memory:");
  const schema = readFileSync(
    resolve(__dirname, "../../db/schema.sql"),
    "utf8",
  );
  const f1 = schema.substring(schema.indexOf("-- F1 Data Layer"));
  d.exec(f1);
  return d;
}

vi.mock("../../db/index.js", () => ({
  getDatabase: () => db,
}));

import { alphaRunTool, alphaLatestTool, alphaExplainTool } from "./alpha.js";

function makeDays(asOf: string, count: number): string[] {
  const base = new Date(asOf + "T12:00:00Z");
  const days: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(base.getTime() - i * 86400000);
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

function seedBarsAndFirings(daysBack = 30) {
  const asOf = "2026-04-17";
  const days = makeDays(asOf, daysBack);
  // F7 runs on weekly bars (operator lock 2026-04-18). This helper seeds
  // synthetic weekly bars with the test's relative dates — spacing doesn't
  // matter for the pipeline (it groups by date), interval label must match.
  const insertBar = db.prepare(
    `INSERT INTO market_data (symbol, provider, interval, timestamp, open, high, low, close, volume)
     VALUES (?, 'alpha_vantage', 'weekly', ?, ?, ?, ?, ?, 100000)`,
  );
  const insertSignal = db.prepare(
    `INSERT INTO market_signals (symbol, signal_type, direction, strength, triggered_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const insertWatchlist = db.prepare(
    `INSERT OR IGNORE INTO watchlist (symbol, asset_class) VALUES (?, 'equity')`,
  );
  for (const sym of ["AAPL", "TSLA", "NVDA"]) {
    insertWatchlist.run(sym);
    for (let i = 0; i < days.length; i++) {
      const close = 100 + i * 0.3 + Math.sin(i) * 2;
      insertBar.run(sym, days[i]!, close - 0.5, close + 1, close - 1, close);
    }
    // Fire signal on days 0..14 (15 firings > min 5 for IC)
    for (let i = 0; i < 15; i++) {
      insertSignal.run(sym, "ma_crossover", "long", 0.7, days[i]!);
    }
  }
  return { asOf, days };
}

describe("alphaRunTool", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("runs the pipeline end-to-end and persists weights + ISQ", async () => {
    seedBarsAndFirings();
    const out = (await alphaRunTool.execute({
      as_of: "2026-04-17",
      window_m: 20,
      window_d: 10,
    })) as string;
    expect(out).toContain("alpha_run:");
    expect(out).toContain("run_id=");
    expect(out).toContain("persisted:");

    const weightRows = db
      .prepare("SELECT COUNT(*) AS n FROM signal_weights")
      .get() as { n: number };
    expect(weightRows.n).toBeGreaterThan(0);
    const isqRows = db
      .prepare("SELECT COUNT(*) AS n FROM signal_isq")
      .get() as { n: number };
    expect(isqRows.n).toBeGreaterThan(0);
  });

  it("returns structured empty message when no signals available", async () => {
    // Watchlist but no firings / bars
    db.prepare(
      `INSERT INTO watchlist (symbol, asset_class) VALUES ('AAPL', 'equity')`,
    ).run();
    const out = (await alphaRunTool.execute({
      as_of: "2026-04-17",
    })) as string;
    expect(out).toContain("no signals available");
  });

  it("rejects probability mode with a clear error", async () => {
    seedBarsAndFirings();
    const out = (await alphaRunTool.execute({
      mode: "probability",
      as_of: "2026-04-17",
    })) as string;
    expect(out).toMatch(/not implemented/i);
  });

  it("returns config-error message for invalid windows", async () => {
    seedBarsAndFirings();
    const out = (await alphaRunTool.execute({
      as_of: "2026-04-17",
      window_m: 2, // below minimum of 3
    })) as string;
    expect(out).toContain("config error");
  });

  it("rejects malformed as_of at tool boundary (audit W2 round 3)", async () => {
    const out = (await alphaRunTool.execute({
      as_of: "banana",
    })) as string;
    expect(out).toMatch(/as_of must be YYYY-MM-DD/);
  });

  it("defaults as_of to today-in-NY when omitted", async () => {
    seedBarsAndFirings();
    // Should not throw; just verify it ran
    const out = (await alphaRunTool.execute({
      window_m: 20,
      window_d: 10,
    })) as string;
    expect(out).toContain("alpha_run:");
  });
});

describe("alphaLatestTool", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("returns no-runs message when table is empty", async () => {
    const out = (await alphaLatestTool.execute({})) as string;
    expect(out).toContain("no completed runs");
  });

  it("returns latest run after alpha_run persists one", async () => {
    seedBarsAndFirings();
    await alphaRunTool.execute({
      as_of: "2026-04-17",
      window_m: 20,
      window_d: 10,
    });
    const out = (await alphaLatestTool.execute({})) as string;
    expect(out).toContain("alpha_latest:");
    expect(out).toContain("run_id=");
    expect(out).toContain("N_effective=");
  });

  it("returns the MOST RECENT run when multiple exist", async () => {
    seedBarsAndFirings();
    await alphaRunTool.execute({
      as_of: "2026-04-17",
      window_m: 20,
      window_d: 10,
    });
    // Wait a ms so run_timestamp differs
    await new Promise((r) => setTimeout(r, 10));
    await alphaRunTool.execute({
      as_of: "2026-04-17",
      window_m: 20,
      window_d: 10,
    });
    const countRow = db
      .prepare("SELECT COUNT(DISTINCT run_id) AS n FROM signal_weights")
      .get() as { n: number };
    expect(countRow.n).toBe(2);
    const out = (await alphaLatestTool.execute({})) as string;
    expect(out).toContain("alpha_latest:");
  });
});

describe("alphaExplainTool", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("returns no-runs message when nothing persisted and no run_id given", async () => {
    const out = (await alphaExplainTool.execute({})) as string;
    expect(out).toContain("no completed runs");
  });

  it("rejects non-UUID run_id at the tool boundary", async () => {
    const out = (await alphaExplainTool.execute({
      run_id: "not-a-uuid",
    })) as string;
    expect(out).toContain("must be a UUID");
  });

  it("returns not-found when run_id is a valid UUID but absent", async () => {
    const out = (await alphaExplainTool.execute({
      run_id: "11111111-2222-3333-4444-555555555555",
    })) as string;
    expect(out).toContain("no run with id");
  });

  it("returns per-signal breakdown for the latest run", async () => {
    seedBarsAndFirings();
    await alphaRunTool.execute({
      as_of: "2026-04-17",
      window_m: 20,
      window_d: 10,
    });
    const out = (await alphaExplainTool.execute({})) as string;
    expect(out).toContain("alpha_explain:");
    expect(out).toContain("signal_key");
    expect(out).toMatch(/ma_crossover:(AAPL|TSLA|NVDA)/);
  });

  it("explains a specific run by UUID", async () => {
    seedBarsAndFirings();
    await alphaRunTool.execute({
      as_of: "2026-04-17",
      window_m: 20,
      window_d: 10,
    });
    const runRow = db
      .prepare(
        "SELECT run_id FROM signal_weights ORDER BY run_timestamp DESC LIMIT 1",
      )
      .get() as { run_id: string };
    const out = (await alphaExplainTool.execute({
      run_id: runRow.run_id,
    })) as string;
    expect(out).toContain(runRow.run_id);
  });
});
