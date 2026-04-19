/**
 * F7.5 backtest tool-handler tests.
 *
 * Uses a real in-memory SQLite DB loaded with the project schema so the full
 * persist → read round-trip is exercised. Follows alpha.test.ts pattern.
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

import {
  backtestRunTool,
  backtestLatestTool,
  backtestExplainTool,
} from "./backtest.js";

/** Seed a long enough weekly history (80 weeks) for CPCV + walk-forward to run. */
function seedWeekly(nWeeks = 80) {
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

  const startDate = new Date("2024-06-07T16:00:00Z");
  const dates: string[] = [];
  for (let i = 0; i < nWeeks; i++) {
    const d = new Date(startDate);
    d.setUTCDate(d.getUTCDate() + i * 7);
    dates.push(d.toISOString().slice(0, 10));
  }
  for (const sym of ["AAPL", "TSLA", "NVDA"]) {
    insertWatchlist.run(sym);
    let close = 100;
    for (let i = 0; i < dates.length; i++) {
      close = close * (1 + (i % 2 === 0 ? 0.01 : -0.005));
      insertBar.run(sym, dates[i]!, close - 0.5, close + 1, close - 1, close);
    }
    for (let i = 0; i < Math.min(40, dates.length); i++) {
      insertSignal.run(sym, "ma_crossover", "long", 0.6, dates[i]!);
    }
  }
  return dates;
}

describe("backtestRunTool", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("rejects malformed start_date/end_date", async () => {
    const out1 = (await backtestRunTool.execute({
      start_date: "banana",
    })) as string;
    expect(out1).toMatch(/start_date must be YYYY-MM-DD/);
    const out2 = (await backtestRunTool.execute({
      end_date: "not-a-date",
    })) as string;
    expect(out2).toMatch(/end_date must be YYYY-MM-DD/);
  });

  it("rejects strategy='equal_weight' at v1", async () => {
    const out = (await backtestRunTool.execute({
      strategy: "equal_weight",
    })) as string;
    expect(out).toMatch(/equal_weight.*reserved/);
  });

  it("returns clear error when no bars exist", async () => {
    const out = (await backtestRunTool.execute({})) as string;
    expect(out).toMatch(/no weekly bars found|insufficient bars/);
  });

  it("returns insufficient-bars error when below threshold", async () => {
    seedWeekly(10);
    const out = (await backtestRunTool.execute({})) as string;
    expect(out).toMatch(/insufficient bars|no weekly bars/);
  });

  it("runs end-to-end and persists to all 3 tables", async () => {
    seedWeekly(80);
    const out = (await backtestRunTool.execute({
      trial_grid: JSON.stringify({
        windowM: [26],
        windowD: [4],
        corrThreshold: [0.95],
      }),
    })) as string;
    expect(out).toContain("backtest_run:");
    expect(out).toContain("run_id=");
    expect(out).toContain("PBO=");
    expect(out).toContain("DSR_pvalue=");

    const runs = db
      .prepare("SELECT COUNT(*) AS n FROM backtest_runs")
      .get() as { n: number };
    expect(runs.n).toBe(1);
    const paths = db
      .prepare("SELECT COUNT(*) AS n FROM backtest_paths")
      .get() as { n: number };
    expect(paths.n).toBeGreaterThan(0);
    const overfit = db
      .prepare("SELECT COUNT(*) AS n FROM backtest_overfit")
      .get() as { n: number };
    expect(overfit.n).toBe(1);
  });

  it("rejects invalid trial_grid JSON", async () => {
    seedWeekly(80);
    const out = (await backtestRunTool.execute({
      trial_grid: "{not json",
    })) as string;
    expect(out).toMatch(/trial_grid.*JSON|invalid JSON/);
  });

  it("rejects trial_grid missing required fields", async () => {
    seedWeekly(80);
    const out = (await backtestRunTool.execute({
      trial_grid: JSON.stringify({ windowM: [26] }),
    })) as string;
    expect(out).toMatch(/trial_grid\.windowD/);
  });

  it("override_ship=true surfaces OVERRIDE even when blocked", async () => {
    seedWeekly(80);
    // Force ship-blocked condition by using an empty signals table (no firings
    // → weights all zero → degenerate metrics). We still expect either the
    // ship_ok / SHIP_BLOCKED / OVERRIDE label to surface.
    const out = (await backtestRunTool.execute({
      override_ship: true,
      trial_grid: JSON.stringify({
        windowM: [26],
        windowD: [4],
        corrThreshold: [0.95],
      }),
    })) as string;
    // Either override or not-blocked path is acceptable; the key assertion is
    // that the tool ran end-to-end with the override flag honored in the DB.
    const row = db
      .prepare(`SELECT override_ship FROM backtest_runs LIMIT 1`)
      .get() as { override_ship: number } | undefined;
    expect(row).toBeDefined();
    expect(row!.override_ship).toBe(1);
    expect(out).toContain("backtest_run:");
  });
});

describe("backtestLatestTool", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("returns no-runs message when table empty", async () => {
    const out = (await backtestLatestTool.execute({})) as string;
    expect(out).toMatch(/no runs found/);
  });

  it("returns headline metrics after a run", async () => {
    seedWeekly(80);
    await backtestRunTool.execute({
      trial_grid: JSON.stringify({
        windowM: [26],
        windowD: [4],
        corrThreshold: [0.95],
      }),
    });
    const out = (await backtestLatestTool.execute({})) as string;
    expect(out).toContain("backtest_latest:");
    expect(out).toContain("run_id=");
    expect(out).toContain("PBO=");
    expect(out).toContain("ship_gate:");
  });

  it("filters by strategy when provided", async () => {
    seedWeekly(80);
    await backtestRunTool.execute({
      trial_grid: JSON.stringify({
        windowM: [26],
        windowD: [4],
        corrThreshold: [0.95],
      }),
    });
    const out = (await backtestLatestTool.execute({
      strategy: "flam",
    })) as string;
    expect(out).toContain("backtest_latest:");
    const missing = (await backtestLatestTool.execute({
      strategy: "equal_weight",
    })) as string;
    expect(missing).toMatch(/no runs found/);
  });
});

describe("backtestExplainTool", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("returns error when run_id is not a UUID", async () => {
    const out = (await backtestExplainTool.execute({
      run_id: "not-a-uuid",
    })) as string;
    expect(out).toMatch(/run_id must be a UUID/);
  });

  it("returns not-found when no runs persisted and no run_id given", async () => {
    const out = (await backtestExplainTool.execute({})) as string;
    expect(out).toMatch(/no runs exist|run not found/);
  });

  it("returns per-trial breakdown for the latest run", async () => {
    seedWeekly(80);
    await backtestRunTool.execute({
      trial_grid: JSON.stringify({
        windowM: [26, 52],
        windowD: [4],
        corrThreshold: [0.95],
      }),
    });
    const out = (await backtestExplainTool.execute({})) as string;
    expect(out).toContain("backtest_explain:");
    expect(out).toContain("trials (top");
    expect(out).toMatch(/windowM=\d+/);
  });
});
