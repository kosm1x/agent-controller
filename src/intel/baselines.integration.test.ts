/**
 * Baseline SQL on the real `signals` and `signal_baselines` tables.
 *
 * baselines.test.ts stubs `prepare`, so it proves only how often statements
 * run. These cases run the window SELECT, the upsert on the real
 * (source, key, window) primary key and the listing SELECT on
 * `initDatabase(":memory:")` and read the rows back.
 *
 * The windows are computed by SQLite's clock (`datetime('now', …)`), so
 * signals are aged with that same expression.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import {
  computeAllBaselines,
  computeBaseline,
  getBaselines,
} from "./baselines.js";
import { METRICS } from "./delta-engine.js";

const SEEDED_AT = "2000-01-01 00:00:00";

function baseline(source: string, key: string, window: string, mean: number): void {
  getDatabase()
    .prepare(
      `INSERT INTO signal_baselines (source, key, window, mean, stddev, min_val, max_val, sample_count, computed_at)
       VALUES (?, ?, ?, ?, 1.5, 1, 9, 4, '2000-01-01 00:00:00')`,
    )
    .run(source, key, window, mean);
}

function signal(
  source: string,
  key: string,
  value: number | null,
  ageModifier: string,
): void {
  getDatabase()
    .prepare(
      `INSERT INTO signals (source, domain, signal_type, key, value_numeric, collected_at)
       VALUES (?, 'synthetic', 'numeric', ?, ?, datetime('now', ?))`,
    )
    .run(source, key, value, ageModifier);
}

beforeEach(() => {
  initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
  vi.restoreAllMocks();
});

describe("getBaselines on the real signal_baselines table", () => {
  it("returns every window of one metric, ordered by window", () => {
    baseline("src", "k", "7d", 25);
    baseline("src", "k", "24h", 20);
    baseline("src", "other-key", "24h", 99);
    baseline("other-src", "k", "24h", 99);

    expect(getBaselines("src", "k")).toEqual([
      {
        source: "src",
        key: "k",
        window: "24h",
        mean: 20,
        stddev: 1.5,
        min_val: 1,
        max_val: 9,
        sample_count: 4,
        computed_at: "2000-01-01 00:00:00",
      },
      {
        source: "src",
        key: "k",
        window: "7d",
        mean: 25,
        stddev: 1.5,
        min_val: 1,
        max_val: 9,
        sample_count: 4,
        computed_at: "2000-01-01 00:00:00",
      },
    ]);
    expect(getBaselines("src", "missing")).toEqual([]);
  });
});

describe("computeBaseline on the real tables", () => {
  it("writes mean, sample stddev, min, max and count per window from the signals inside it", () => {
    signal("src", "k", 10, "-1 hours");
    signal("src", "k", 20, "-2 hours");
    signal("src", "k", 30, "-3 hours");
    signal("src", "k", 40, "-48 hours"); // 7d only
    signal("src", "k", 1000, "-200 hours"); // outside both windows
    signal("src", "k", null, "-1 hours"); // no numeric value
    signal("src", "other-key", 500, "-1 hours");
    signal("other-src", "k", 500, "-1 hours");

    computeBaseline("src", "k");

    const [day, week, ...rest] = getBaselines("src", "k");
    expect(rest).toEqual([]);
    expect(day).toMatchObject({
      source: "src",
      key: "k",
      window: "24h",
      mean: 20,
      min_val: 10,
      max_val: 30,
      sample_count: 3,
    });
    expect(day.stddev).toBeCloseTo(10, 9);
    expect(week).toMatchObject({
      source: "src",
      key: "k",
      window: "7d",
      mean: 25,
      min_val: 10,
      max_val: 40,
      sample_count: 4,
    });
    expect(week.stddev).toBeCloseTo(Math.sqrt(500 / 3), 9);
    expect(getBaselines("src", "other-key")).toEqual([]);
    expect(getBaselines("other-src", "k")).toEqual([]);
  });

  it("writes stddev 0 for a constant non-integer series (rounding cannot make the variance negative)", () => {
    for (const age of ["-1 hours", "-2 hours", "-3 hours"]) signal("src", "k", 0.1, age);

    computeBaseline("src", "k");

    const rows = getBaselines("src", "k");
    expect(rows.map((b) => [b.window, b.stddev, b.sample_count])).toEqual([
      ["24h", 0, 3],
      ["7d", 0, 3],
    ]);
    for (const b of rows) expect(b.mean).toBeCloseTo(0.1, 12);
  });

  it("skips a window with fewer than two samples", () => {
    signal("src", "k", 10, "-1 hours");
    signal("src", "k", 20, "-30 hours");

    computeBaseline("src", "k");

    expect(getBaselines("src", "k").map((b) => [b.window, b.sample_count])).toEqual([
      ["7d", 2],
    ]);
  });

  it("a second compute updates each window's row in place", () => {
    signal("src", "k", 10, "-1 hours");
    signal("src", "k", 20, "-2 hours");
    computeBaseline("src", "k");
    getDatabase()
      .prepare("UPDATE signal_baselines SET computed_at = ?")
      .run(SEEDED_AT);
    signal("src", "k", 60, "-3 hours");

    computeBaseline("src", "k");

    const rows = getBaselines("src", "k");
    expect(rows.map((b) => b.window)).toEqual(["24h", "7d"]);
    for (const b of rows) {
      expect(b).toMatchObject({ mean: 30, min_val: 10, max_val: 60, sample_count: 3 });
      expect(b.computed_at).not.toBe(SEEDED_AT);
    }
  });
});

describe("computeAllBaselines on the real tables", () => {
  it("writes both windows for a known metric", () => {
    const m = METRICS[0];
    signal(m.source, m.key, 1, "-1 hours");
    signal(m.source, m.key, 3, "-2 hours");

    expect(computeAllBaselines()).toEqual({ ok: METRICS.length, failed: 0 });

    expect(
      getBaselines(m.source, m.key).map((b) => [b.window, b.mean, b.sample_count]),
    ).toEqual([
      ["24h", 2, 2],
      ["7d", 2, 2],
    ]);
  });

  it("logs a failing metric with its error and still computes the others", () => {
    const [bad, good] = METRICS;
    for (const m of [bad, good]) {
      signal(m.source, m.key, 1, "-1 hours");
      signal(m.source, m.key, 3, "-2 hours");
    }
    // A real write failure for one metric only: the upsert of `bad` aborts.
    getDatabase().exec(
      `CREATE TRIGGER fail_one BEFORE INSERT ON signal_baselines
         WHEN NEW.source = '${bad.source}' AND NEW.key = '${bad.key}'
         BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END`,
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(computeAllBaselines()).toEqual({ ok: METRICS.length - 1, failed: 1 });

    const lines = warn.mock.calls.map((c) => c.map(String).join(" "));
    expect(lines).toEqual([
      expect.stringContaining(`${bad.source}/${bad.key}`),
    ]);
    expect(lines[0]).toContain("synthetic write failure");
    expect(getBaselines(bad.source, bad.key)).toEqual([]);
    expect(getBaselines(good.source, good.key).map((b) => b.window)).toEqual(["24h", "7d"]);
  });
});
