import { afterEach, describe, expect, it, vi } from "vitest";
import type { BarRow, FiringRow } from "./alpha-matrix.js";
import { buildReturnMatrix } from "./alpha-matrix.js";
import { toWeeklyPeriods, weekEndKey } from "./weekly-periods.js";

const bar = (symbol: string, timestamp: string, close: number): BarRow => ({
  symbol,
  timestamp,
  close,
});
const firing = (symbol: string, triggered_at: string): FiringRow => ({
  symbol,
  signal_type: "rsi_extreme",
  direction: "long",
  strength: 1,
  triggered_at,
});

describe("weekEndKey", () => {
  it("maps every day of a Monday–Sunday week to that week's Friday", () => {
    for (const d of [
      "2026-09-07", // Mon
      "2026-09-09T16:00:00-04:00", // Wed, AV convention
      "2026-09-11T00:00:00-04:00", // Fri, Polygon convention
      "2026-09-13", // Sun
    ]) {
      expect(weekEndKey(d)).toBe("2026-09-11");
    }
    expect(weekEndKey("2026-09-14")).toBe("2026-09-18");
  });

  it("keys a holiday-shortened week by its Friday (Good Friday 2026-04-03)", () => {
    expect(weekEndKey("2026-04-02T16:00:00-04:00")).toBe("2026-04-03");
  });

  it("crosses month and year boundaries", () => {
    expect(weekEndKey("2025-12-29")).toBe("2026-01-02");
  });
});

describe("toWeeklyPeriods", () => {
  it("keeps one bar per symbol-week — the newest date wins over mid-week partials", () => {
    const { bars } = toWeeklyPeriods(
      [
        bar("AAPL", "2026-05-06T16:00:00-04:00", 101), // partial, fetched Wed
        bar("AAPL", "2026-05-08T16:00:00-04:00", 105), // completed week
        bar("AAPL", "2026-05-04T16:00:00-04:00", 99), // older partial, listed last
        bar("JPM", "2026-05-05T16:00:00-04:00", 200), // only a partial exists
      ],
      [],
      "2026-09-18",
    );
    expect(bars).toEqual([
      bar("AAPL", "2026-05-08", 105),
      bar("JPM", "2026-05-08", 200),
    ]);
  });

  it("drops the week that is not over at asOf — bars and firings", () => {
    const input = [
      bar("AAPL", "2026-09-11T16:00:00-04:00", 100),
      bar("AAPL", "2026-09-16T16:00:00-04:00", 103), // week of 09-18, in progress
    ];
    const f = [firing("AAPL", "2026-09-10"), firing("AAPL", "2026-09-16")];
    // Friday itself is still "in progress" (the close may not have printed).
    for (const today of ["2026-09-16", "2026-09-18"]) {
      const out = toWeeklyPeriods(input, f, today, today);
      expect(out.bars.map((b) => b.timestamp)).toEqual(["2026-09-11"]);
      expect(out.firings.map((x) => x.triggered_at)).toEqual(["2026-09-11"]);
    }
    expect(
      toWeeklyPeriods(input, f, "2026-09-19", "2026-09-19").bars.map(
        (b) => b.timestamp,
      ),
    ).toEqual(["2026-09-11", "2026-09-18"]);
  });

  describe("default clock", () => {
    afterEach(() => vi.useRealTimers());

    it("with no `today` argument the cut is today in New York — a Friday run does not close its own week", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-25T15:00:00Z")); // Friday 11:00 ET
      const out = toWeeklyPeriods(
        [
          bar("AAPL", "2026-09-18T16:00:00-04:00", 100),
          bar("AAPL", "2026-09-24T16:00:00-04:00", 103),
        ],
        [firing("AAPL", "2026-09-24")],
        "2026-09-25",
      );
      expect(out.bars.map((b) => b.timestamp)).toEqual(["2026-09-18"]);
      expect(out.firings).toEqual([]);
    });
  });

  it("a historical asOf that IS a Friday keeps that completed week, and nothing after it", () => {
    const input = [
      bar("AAPL", "2026-09-04T16:00:00-04:00", 99),
      bar("AAPL", "2026-09-11T16:00:00-04:00", 100),
      bar("AAPL", "2026-09-16T16:00:00-04:00", 103),
    ];
    const out = toWeeklyPeriods(
      input,
      [firing("AAPL", "2026-09-10"), firing("AAPL", "2026-09-15")],
      "2026-09-11",
      "2026-12-01",
    );
    expect(out.bars.map((b) => b.timestamp)).toEqual([
      "2026-09-04",
      "2026-09-11",
    ]);
    expect(out.firings.map((x) => x.triggered_at)).toEqual(["2026-09-11"]);
  });

  it("a mid-week daily firing scores against its week's close (was: silently neutral)", () => {
    const rawBars = [
      bar("AAPL", "2026-05-08T16:00:00-04:00", 100),
      bar("AAPL", "2026-05-15T16:00:00-04:00", 110),
      bar("AAPL", "2026-05-22T16:00:00-04:00", 121),
    ];
    const rawFirings = [firing("AAPL", "2026-05-06T00:00:00-04:00")]; // Wed
    const { bars, firings } = toWeeklyPeriods(
      rawBars,
      rawFirings,
      "2026-09-18",
    );
    const periods = ["2026-05-08", "2026-05-15", "2026-05-22"];
    const m = buildReturnMatrix({ firings, bars, periods });
    expect(m.R[0]).toBeCloseTo(0.1, 10);
    expect(m.flags).toEqual([]);
    // Un-bucketed, the same firing matches no period at all.
    const raw = buildReturnMatrix({
      firings: rawFirings,
      bars: rawBars,
      periods,
    });
    expect(Array.from(raw.R)).toEqual([0, 0, 0]);
  });

  it("symbols fetched on different weekdays share one period axis", () => {
    const { bars } = toWeeklyPeriods(
      [
        bar("AAPL", "2026-05-19T16:00:00-04:00", 1),
        bar("JPM", "2026-05-20T16:00:00-04:00", 2),
      ],
      [],
      "2026-09-18",
    );
    expect(new Set(bars.map((b) => b.timestamp))).toEqual(
      new Set(["2026-05-22"]),
    );
  });
});
