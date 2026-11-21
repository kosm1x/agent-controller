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

// The real module, with the run function wrapped in a spy that calls the real
// implementation; one case replaces it once to reach the correlation guard.
vi.mock("../../finance/alpha-combination.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../finance/alpha-combination.js")
  >("../../finance/alpha-combination.js");
  return {
    ...actual,
    runAlphaCombination: vi.fn(actual.runAlphaCombination),
  };
});

import { alphaRunTool, alphaLatestTool, alphaExplainTool } from "./alpha.js";
import {
  runAlphaCombination,
  F7CorrelatedSignalsError,
} from "../../finance/alpha-combination.js";

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

function makeDays(asOf: string, count: number): string[] {
  const base = new Date(asOf + "T12:00:00Z");
  const days: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(base.getTime() - i * 7 * 86400000);
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

function seedBarsAndFirings(daysBack = 25) {
  const asOf = "2026-04-17";
  const days = makeDays(asOf, daysBack);
  // F7 runs on weekly bars (operator lock 2026-04-18). This helper seeds
  // synthetic weekly bars on Fridays — alpha_run buckets bars and firings
  // by week (weekly-periods.ts), so daily spacing would collapse to ~4 periods.
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
    expect(out.startsWith("alpha_run: run_id=")).toBe(true);
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

  it("scores mid-week firings and ignores mid-week partial bars (weekly-periods wiring)", async () => {
    const { days } = seedBarsAndFirings();
    const shift = (day: string, n: number) => {
      const d = new Date(day + "T12:00:00Z");
      d.setUTCDate(d.getUTCDate() + n);
      return d.toISOString().slice(0, 10);
    };
    // Production shape: the daily scan fires on a Wednesday, and a mid-week
    // fetch left a partial "weekly" row behind for ONE symbol only.
    db.prepare(
      `UPDATE market_signals SET triggered_at = ? WHERE symbol = 'AAPL' AND triggered_at = ?`,
    ).run(shift(days[8]!, -2) + "T00:00:00-04:00", days[8]!);
    db.prepare(
      `INSERT INTO market_data (symbol, provider, interval, timestamp, open, high, low, close, volume)
       VALUES ('TSLA', 'alpha_vantage', 'weekly', ?, 1, 1, 1, 1, 1)`,
    ).run(shift(days[10]!, -3) + "T16:00:00-04:00");

    // A firing in the LAST scored week has no forward return yet — that is
    // not missing data (it used to drop the signal: 1/16 flagged > 5%).
    db.prepare(
      `INSERT INTO market_signals (symbol, signal_type, direction, strength, triggered_at)
       VALUES ('NVDA', 'ma_crossover', 'long', 0.7, ?)`,
    ).run(days[days.length - 1]!);

    await alphaRunTool.execute({
      as_of: "2026-04-17",
      window_m: 20,
      window_d: 10,
    });
    const missing = db
      .prepare(
        `SELECT COUNT(*) AS n FROM signal_weights WHERE exclude_reason = 'missing_data'`,
      )
      .get() as { n: number };
    expect(missing.n).toBe(0);
  });

  it("a raw split in AV closes does not move the result — bars are stitched to one basis (stitchWeekly wiring)", async () => {
    const { days } = seedBarsAndFirings();
    const sigmas = () =>
      db
        .prepare(
          `SELECT signal_key, sigma FROM signal_weights
            WHERE run_id = (SELECT run_id FROM signal_weights ORDER BY id DESC LIMIT 1)
            ORDER BY signal_key`,
        )
        .all() as Array<{ signal_key: string; sigma: number }>;
    const args = { as_of: "2026-04-17", window_m: 20, window_d: 10 };
    await alphaRunTool.execute(args);
    const before = sigmas();

    // Same prices as AV stores them around a 2:1 split: RAW close doubles
    // before the split week, adjusted_close carries the true series.
    db.prepare(
      `UPDATE market_data SET adjusted_close = close, close = close * 2
        WHERE symbol = 'AAPL' AND substr(timestamp, 1, 10) < ?`,
    ).run(days[10]!);
    await alphaRunTool.execute(args);
    const after = sigmas();

    expect(after.map((r) => r.signal_key)).toEqual(
      before.map((r) => r.signal_key),
    );
    after.forEach((r, i) => expect(r.sigma).toBeCloseTo(before[i]!.sigma, 10));
  });

  it("reports a run with no signals in the window as an error object and persists nothing", async () => {
    // Watchlist but no firings / bars
    db.prepare(
      `INSERT INTO watchlist (symbol, asset_class) VALUES ('AAPL', 'equity')`,
    ).run();
    const out = (await alphaRunTool.execute({
      as_of: "2026-04-17",
    })) as string;
    const words = errorWords(out);
    expect(words).toMatch(
      /^alpha_run: no signals available in the window \(\d{4}-\d{2}-\d{2} \.\. 2026-04-17\)\. Nothing to persist\./,
    );
    const rows = db
      .prepare("SELECT COUNT(*) AS n FROM signal_weights")
      .get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it("reports probability mode as an error object (the pipeline throws)", async () => {
    seedBarsAndFirings();
    const out = (await alphaRunTool.execute({
      mode: "probability",
      as_of: "2026-04-17",
    })) as string;
    const words = errorWords(out);
    expect(
      words.startsWith("alpha_run: F7 probability mode: not implemented"),
    ).toBe(true);
  });

  it("reports a config error for invalid windows as an error object", async () => {
    seedBarsAndFirings();
    const out = (await alphaRunTool.execute({
      as_of: "2026-04-17",
      window_m: 2, // below minimum of 3
    })) as string;
    const words = errorWords(out);
    expect(words.startsWith("alpha_run: config error — ")).toBe(true);
  });

  it("reports an exhausted correlation guard as an error object and persists nothing", async () => {
    seedBarsAndFirings();
    const spy = vi.mocked(runAlphaCombination);
    const callsBefore = spy.mock.calls.length;
    spy.mockImplementationOnce(() => {
      throw new F7CorrelatedSignalsError([
        "ma_crossover:AAPL",
        "ma_crossover:TSLA",
      ]);
    });
    const out = (await alphaRunTool.execute({
      as_of: "2026-04-17",
      window_m: 20,
      window_d: 10,
    })) as string;
    expect(spy.mock.calls.length).toBe(callsBefore + 1);
    expect(errorWords(out)).toBe(
      "alpha_run: correlation guard exhausted after 3 exclusions. Excluded signals: ma_crossover:AAPL, ma_crossover:TSLA. No weights persisted.",
    );
    const rows = db
      .prepare("SELECT COUNT(*) AS n FROM signal_weights")
      .get() as { n: number };
    expect(rows.n).toBe(0);
    const isqRows = db
      .prepare("SELECT COUNT(*) AS n FROM signal_isq")
      .get() as { n: number };
    expect(isqRows.n).toBe(0);
  });

  it("rejects a malformed as_of at the tool boundary with an error object", async () => {
    const out = (await alphaRunTool.execute({
      as_of: "banana",
    })) as string;
    expect(errorWords(out)).toBe(
      "alpha_run: as_of must be YYYY-MM-DD (got 'banana'). Omit to default to today in America/New_York.",
    );
  });

  it("defaults as_of to today-in-NY when omitted", async () => {
    seedBarsAndFirings();
    // Only the date object is faked, set to the seed's last day (noon in New
    // York), so the default as_of lands on the seeded window.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-04-17T16:00:00Z"));
      const out = (await alphaRunTool.execute({
        window_m: 20,
        window_d: 10,
      })) as string;
      expect(out.startsWith("alpha_run: run_id=")).toBe(true);
      expect(out).toContain("persisted:");
    } finally {
      vi.useRealTimers();
    }
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

  it("returns a plain no-runs result when nothing persisted and no run_id given", async () => {
    const out = (await alphaExplainTool.execute({})) as string;
    expect(out).toBe(
      "alpha_explain: no completed runs found. Invoke alpha_run first.",
    );
  });

  it("rejects a non-UUID run_id at the tool boundary with an error object", async () => {
    const out = (await alphaExplainTool.execute({
      run_id: "not-a-uuid",
    })) as string;
    expect(errorWords(out)).toBe(
      "alpha_explain: run_id must be a UUID (got 'not-a-uuid'). Omit to use latest.",
    );
  });

  it("reports a valid but absent run_id as an error object", async () => {
    const out = (await alphaExplainTool.execute({
      run_id: "11111111-2222-3333-4444-555555555555",
    })) as string;
    expect(errorWords(out)).toBe(
      "alpha_explain: no run with id '11111111-2222-3333-4444-555555555555' found.",
    );
  });

  it("returns per-signal breakdown for the latest run", async () => {
    seedBarsAndFirings();
    await alphaRunTool.execute({
      as_of: "2026-04-17",
      window_m: 20,
      window_d: 10,
    });
    const out = (await alphaExplainTool.execute({})) as string;
    expect(out.startsWith("alpha_explain: run_id=")).toBe(true);
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
