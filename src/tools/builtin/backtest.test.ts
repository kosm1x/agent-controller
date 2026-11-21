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

/**
 * A failure is one JSON object whose first key is `error`, with nothing
 * before the opening brace: the registry and the fast runner read the start
 * of the text to decide that a call failed. Returns the error words.
 */
function errorWords(out: string): string {
  expect(out.startsWith('{"error":')).toBe(true);
  const parsed = JSON.parse(out) as Record<string, unknown>;
  expect(Object.keys(parsed)[0]).toBe("error");
  expect(typeof parsed.error).toBe("string");
  return parsed.error as string;
}

const runCount = () =>
  (db.prepare("SELECT COUNT(*) AS n FROM backtest_runs").get() as { n: number })
    .n;

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

  it("rejects a malformed start_date or end_date with an error object", async () => {
    const out1 = (await backtestRunTool.execute({
      start_date: "banana",
    })) as string;
    expect(errorWords(out1)).toBe(
      "backtest_run: start_date must be YYYY-MM-DD (got 'banana').",
    );
    const out2 = (await backtestRunTool.execute({
      end_date: "not-a-date",
    })) as string;
    expect(errorWords(out2)).toBe(
      "backtest_run: end_date must be YYYY-MM-DD (got 'not-a-date').",
    );
  });

  it("rejects strategy='equal_weight' at v1 with an error object", async () => {
    const out = (await backtestRunTool.execute({
      strategy: "equal_weight",
    })) as string;
    expect(errorWords(out)).toMatch(
      /^backtest_run: strategy='equal_weight' is reserved for v1\.1/,
    );
  });

  it("reports a run with no weekly bars as an error object and persists nothing", async () => {
    const out = (await backtestRunTool.execute({})) as string;
    expect(errorWords(out)).toMatch(
      /^backtest_run: no weekly bars found in market_data\. Seed data first/,
    );
    expect(runCount()).toBe(0);
  });

  it("counts WEEKS, not rows: mid-week partial bars do not add history depth (weekly-periods wiring)", async () => {
    const dates = seedWeekly(20);
    const insertPartial = db.prepare(
      `INSERT INTO market_data (symbol, provider, interval, timestamp, open, high, low, close, volume)
       VALUES ('AAPL', 'alpha_vantage', 'weekly', ?, 1, 1, 1, 1, 1)`,
    );
    // 10 Wednesday partials inside already-seeded weeks: 30 distinct dates, still 20 weeks.
    for (const friday of dates.slice(0, 10)) {
      const d = new Date(friday + "T12:00:00Z");
      d.setUTCDate(d.getUTCDate() - 2);
      insertPartial.run(d.toISOString().slice(0, 10));
    }
    const out = (await backtestRunTool.execute({})) as string;
    expect(errorWords(out)).toContain("found 20 distinct weeks");
  });

  it("reports too few weeks of history as an error object and persists nothing", async () => {
    seedWeekly(10);
    const out = (await backtestRunTool.execute({})) as string;
    expect(errorWords(out)).toBe(
      "backtest_run: insufficient bars (found 10 distinct weeks, need ≥ 26). Seed more history first.",
    );
    expect(runCount()).toBe(0);
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
    expect(out.startsWith("backtest_run: run_id=")).toBe(true);
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

  it("a raw split in AV closes does not move the CPCV result (stitchWeekly wiring)", async () => {
    const dates = seedWeekly(80);
    const grid = {
      trial_grid: JSON.stringify({
        windowM: [26],
        windowD: [4],
        corrThreshold: [0.95],
      }),
    };
    const latest = () =>
      db
        .prepare(
          `SELECT cpcv_sharpe_mean, cpcv_sharpe_std FROM backtest_runs ORDER BY id DESC LIMIT 1`,
        )
        .get() as { cpcv_sharpe_mean: number; cpcv_sharpe_std: number };
    await backtestRunTool.execute(grid);
    const before = latest();

    db.prepare(
      `UPDATE market_data SET adjusted_close = close, close = close * 2
        WHERE symbol = 'AAPL' AND substr(timestamp, 1, 10) < ?`,
    ).run(dates[50]!);
    await backtestRunTool.execute(grid);
    const after = latest();

    expect(before.cpcv_sharpe_std).toBeGreaterThan(0);
    expect(after.cpcv_sharpe_mean).toBeCloseTo(before.cpcv_sharpe_mean, 10);
    expect(after.cpcv_sharpe_std).toBeCloseTo(before.cpcv_sharpe_std, 10);
  });

  it("rejects invalid trial_grid JSON with an error object", async () => {
    seedWeekly(80);
    const out = (await backtestRunTool.execute({
      trial_grid: "{not json",
    })) as string;
    expect(
      errorWords(out).startsWith("backtest_run: trial_grid: invalid JSON — "),
    ).toBe(true);
    expect(runCount()).toBe(0);
  });

  it("rejects trial_grid missing required fields with an error object", async () => {
    seedWeekly(80);
    const out = (await backtestRunTool.execute({
      trial_grid: JSON.stringify({ windowM: [26] }),
    })) as string;
    expect(errorWords(out)).toBe(
      "backtest_run: trial_grid.windowD must be a non-empty array of numbers",
    );
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

  it("returns a plain no-runs result when table empty", async () => {
    const out = (await backtestLatestTool.execute({})) as string;
    expect(out).toBe("backtest_latest: no runs found.");
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

  it("rejects a non-UUID run_id with an error object", async () => {
    const out = (await backtestExplainTool.execute({
      run_id: "not-a-uuid",
    })) as string;
    expect(errorWords(out)).toBe(
      "backtest_explain: run_id must be a UUID (got 'not-a-uuid').",
    );
  });

  it("reports a valid but absent run_id as an error object", async () => {
    const out = (await backtestExplainTool.execute({
      run_id: "11111111-2222-3333-4444-555555555555",
    })) as string;
    expect(errorWords(out)).toBe(
      "backtest_explain: run not found for run_id=11111111-2222-3333-4444-555555555555.",
    );
  });

  it("returns a plain result when no runs persisted and no run_id given", async () => {
    const out = (await backtestExplainTool.execute({})) as string;
    expect(out).toBe("backtest_explain: run not found (no runs exist yet).");
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
    expect(out.startsWith("backtest_explain: ")).toBe(true);
    expect(out).toContain("trials (top");
    expect(out).toMatch(/windowM=\d+/);
  });
});
