/**
 * Baseline SQL on the real `signals` and `signal_baselines` tables.
 *
 * baselines.test.ts stubs `prepare`, so it proves only how often statements
 * run. Here the listing SELECT runs on `initDatabase(":memory:")` over rows
 * seeded with the real (source, key, window) primary key and `window` CHECK.
 *
 * The compute cases are todo: on a real connection the window SELECT in
 * `computeBaseline` throws "Too many parameter values were provided" before it
 * reads anything (its `?1`/`?2`/`?3` placeholders are numbered, which
 * better-sqlite3 binds by name, and the call passes three positional values),
 * and `computeAllBaselines` swallows that error per metric.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import { getBaselines } from "./baselines.js";

function baseline(source: string, key: string, window: string, mean: number): void {
  getDatabase()
    .prepare(
      `INSERT INTO signal_baselines (source, key, window, mean, stddev, min_val, max_val, sample_count, computed_at)
       VALUES (?, ?, ?, ?, 1.5, 1, 9, 4, '2000-01-01 00:00:00')`,
    )
    .run(source, key, window, mean);
}

beforeEach(() => {
  initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
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
  it.todo(
    "writes mean, sample stddev, min, max and count per window from the signals inside it",
  );
  it.todo("skips a window with fewer than two samples");
  it.todo("a second compute updates each window's row in place");
});

describe("computeAllBaselines on the real tables", () => {
  it.todo("writes both windows for a known metric");
});
