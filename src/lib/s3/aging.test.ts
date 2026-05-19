/**
 * v7.7 Spine 2 Bundle 3 — aging baseline tests.
 *
 * Threshold + render coverage. Real :memory: DB seeds with past dates so
 * the julianday-age calculation is exercised.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  loadAgingBaselines,
  formatAgingSection,
  DEFAULT_AGING_THRESHOLD_DAYS,
  type AgingBaseline,
} from "./aging.js";
import { initDatabase, closeDatabase, getDatabase } from "../../db/index.js";

beforeEach(() => initDatabase(":memory:"));
afterEach(() => closeDatabase());

function seedSignalAt(
  name: string,
  establishedDaysAgo: number,
  enabled: 0 | 1 = 1,
): void {
  const established = new Date(
    Date.now() - establishedDaysAgo * 24 * 60 * 60 * 1000,
  ).toISOString();
  getDatabase()
    .prepare(
      `INSERT INTO drift_signals
         (signal_name, signal_kind, source_substrate, baseline_query,
          baseline_value_json, tolerance_json, cadence, alert_priority,
          enabled, established_at, established_by)
       VALUES (?, 'test', 'S1', 'SELECT 1', '{"value":1}', '{}',
               'nightly', 'P1', ?, ?, 'operator')`,
    )
    .run(name, enabled, established);
}

describe("loadAgingBaselines — threshold filtering", () => {
  it("returns empty when no signals exceed threshold", () => {
    seedSignalAt("fresh", 10);
    seedSignalAt("recent", 30);
    expect(loadAgingBaselines().length).toBe(0);
  });

  it("returns signals older than default threshold (90d)", () => {
    seedSignalAt("old_1", 100);
    seedSignalAt("old_2", 365);
    seedSignalAt("fresh", 10);
    const aging = loadAgingBaselines();
    expect(aging.length).toBe(2);
    expect(aging.map((a) => a.signal_name).sort()).toEqual(["old_1", "old_2"]);
  });

  it("EXCLUDES disabled signals (operator hygiene scope)", () => {
    seedSignalAt("old_enabled", 100, 1);
    seedSignalAt("old_disabled", 100, 0);
    const aging = loadAgingBaselines();
    expect(aging.length).toBe(1);
    expect(aging[0].signal_name).toBe("old_enabled");
  });

  it("orders oldest-first", () => {
    seedSignalAt("100_days", 100);
    seedSignalAt("365_days", 365);
    seedSignalAt("200_days", 200);
    const aging = loadAgingBaselines();
    expect(aging.map((a) => a.signal_name)).toEqual([
      "365_days",
      "200_days",
      "100_days",
    ]);
  });

  it("supports custom threshold", () => {
    seedSignalAt("60_days", 60);
    seedSignalAt("100_days", 100);
    const aging = loadAgingBaselines(45);
    expect(aging.length).toBe(2);
    const fewer = loadAgingBaselines(150);
    expect(fewer.length).toBe(0);
  });

  it("computes age_days from established_at via julianday", () => {
    seedSignalAt("aged", 100);
    const aging = loadAgingBaselines();
    expect(aging.length).toBe(1);
    // julianday rounding can land at 99-100 depending on the timestamp;
    // assert it's >=95 and <=101 for tolerance.
    expect(aging[0].age_days).toBeGreaterThanOrEqual(95);
    expect(aging[0].age_days).toBeLessThanOrEqual(101);
  });
});

describe("formatAgingSection — markdown rendering", () => {
  it("returns empty string when input is empty (OMIT discipline)", () => {
    expect(formatAgingSection([])).toBe("");
  });

  it("renders Spanish header with count", () => {
    const aging: AgingBaseline[] = [
      {
        signal_name: "test_sig",
        source_substrate: "S1",
        established_at: "2026-01-01T00:00:00Z",
        established_by: "operator",
        age_days: 100,
      },
    ];
    const out = formatAgingSection(aging);
    expect(out).toContain(
      `### 🟢 Baselines envejecidos (>${DEFAULT_AGING_THRESHOLD_DAYS} días) — 1`,
    );
  });

  it("includes signal name, substrate, age, and established_by", () => {
    const aging: AgingBaseline[] = [
      {
        signal_name: "cost_per_brief_drift",
        source_substrate: "S4",
        established_at: "2026-01-01T00:00:00Z",
        established_by: "v7.7-spine-2-seed",
        age_days: 95,
      },
    ];
    const out = formatAgingSection(aging);
    expect(out).toContain("cost_per_brief_drift");
    expect(out).toContain("(S4)");
    expect(out).toContain("hace 95 d");
    expect(out).toContain("v7.7-spine-2-seed");
  });

  it("trims trailing whitespace (clean copy boundary)", () => {
    const aging: AgingBaseline[] = [
      {
        signal_name: "x",
        source_substrate: "y",
        established_at: "2026-01-01T00:00:00Z",
        established_by: "z",
        age_days: 100,
      },
    ];
    const out = formatAgingSection(aging);
    expect(out).toBe(out.trimEnd());
  });
});
