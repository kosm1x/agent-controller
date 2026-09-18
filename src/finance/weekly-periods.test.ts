import { afterEach, describe, expect, it, vi } from "vitest";
import type { BarRow, FiringRow } from "./alpha-matrix.js";
import { buildReturnMatrix } from "./alpha-matrix.js";
import {
  isCompletedWeekClose,
  lastCompletedWeekKey,
  stitchWeekly,
  stitchedCloses,
  toWeeklyPeriods,
  weekEndKey,
} from "./weekly-periods.js";

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

describe("lastCompletedWeekKey / isCompletedWeekClose", () => {
  it("a week is over on Saturday, not on its Friday", () => {
    expect(lastCompletedWeekKey("2026-09-18")).toBe("2026-09-11"); // Fri
    expect(lastCompletedWeekKey("2026-09-19")).toBe("2026-09-18"); // Sat
    expect(lastCompletedWeekKey("2026-09-20")).toBe("2026-09-18"); // Sun
    expect(lastCompletedWeekKey("2026-09-21")).toBe("2026-09-18"); // Mon
  });

  it("a mid-week partial and the week in progress are not the completed week's close", () => {
    const today = "2026-09-23"; // Wed; completed week = 09-18
    expect(isCompletedWeekClose("2026-09-18T16:00:00-04:00", today)).toBe(true);
    expect(isCompletedWeekClose("2026-09-16T16:00:00-04:00", today)).toBe(
      false,
    );
    expect(isCompletedWeekClose("2026-09-22T16:00:00-04:00", today)).toBe(
      false,
    );
    expect(isCompletedWeekClose("2026-09-11T16:00:00-04:00", today)).toBe(
      false,
    );
  });

  it("a holiday week closes on its last session (Good Friday 2026-04-03)", () => {
    const today = "2026-04-07";
    expect(isCompletedWeekClose("2026-04-02T16:00:00-04:00", today)).toBe(true); // AV, Thu
    expect(isCompletedWeekClose("2026-04-03T16:00:00-04:00", today)).toBe(true); // Polygon, re-keyed
    expect(isCompletedWeekClose("2026-04-01T16:00:00-04:00", today)).toBe(
      false,
    );
  });
});

describe("stitchWeekly", () => {
  const row = (
    provider: string,
    day: string,
    close: number,
    adjusted_close: number | null = null,
    symbol = "XLE",
  ) => ({
    symbol,
    provider,
    timestamp: `${day}T16:00:00-04:00`,
    close,
    adjusted_close,
  });

  it("a split inside the Polygon window leaves no fake return at the seam (XLE 2:1)", () => {
    // AV: raw 88/90/92 (adjusted 43/44/45, dividends included); Polygon covers
    // the last two weeks split-adjusted (45/46).
    const closes = stitchedCloses([
      row("alpha_vantage", "2024-09-06", 88, 43),
      row("alpha_vantage", "2024-09-13", 90, 44),
      row("alpha_vantage", "2024-09-20", 92, 45),
      row("polygon", "2024-09-13", 45),
      row("polygon", "2024-09-20", 46),
    ]).map((b) => b.close);
    expect(closes).toHaveLength(3);
    // The AV-only week moves by AV's own adjusted return into the first Polygon week.
    expect(closes[1] / closes[0]).toBeCloseTo(44 / 43, 10);
    expect(closes.slice(1)).toEqual([45, 46]);
  });

  it("AV-only history is priced at adjusted_close — a raw split is not a −90 % week (NVDA 10:1)", () => {
    const closes = stitchedCloses([
      row("alpha_vantage", "2024-06-07", 1208.88, 120.82, "NVDA"),
      row("alpha_vantage", "2024-06-14", 131.88, 131.82, "NVDA"),
    ]).map((b) => b.close);
    expect(closes[0]).toBeCloseTo(120.82, 10);
    expect(closes[1]).toBeCloseTo(131.82, 10);
  });

  it("an AV week NEWER than Polygon coverage is rescaled at the newest shared week, not the oldest", () => {
    const out = stitchWeekly([
      row("alpha_vantage", "2026-08-28", 100, 50), // oldest overlap: ratio 1
      row("polygon", "2026-08-28", 50),
      row("alpha_vantage", "2026-09-04", 51, 51), // newest overlap: ratio 2
      row("polygon", "2026-09-04", 102),
      row("alpha_vantage", "2026-09-11", 52, 52), // Polygon down that week
    ]);
    expect(out.map((o) => o.row.provider)).toEqual([
      "polygon",
      "polygon",
      "alpha_vantage",
    ]);
    expect(out[2].scale).toBeCloseTo(2, 10);
  });

  it("a mid-week AV partial never sets the seam ratio, and a row without adjusted_close falls back to close", () => {
    const out = stitchWeekly([
      row("alpha_vantage", "2026-08-28", 100),
      row("alpha_vantage", "2026-09-02", 90), // Wednesday partial of the 09-04 week
      row("polygon", "2026-09-04", 45),
    ]);
    expect(out.map((o) => [o.row.timestamp.slice(0, 10), o.scale])).toEqual([
      ["2026-08-28", 1],
      ["2026-09-04", 1],
    ]);
  });

  it("a zero adjusted_close is treated as absent — never a 0.00 close", () => {
    const closes = stitchedCloses([
      row("alpha_vantage", "2026-09-04", 100, 0),
      row("alpha_vantage", "2026-09-11", 101, 0),
    ]).map((b) => b.close);
    expect(closes).toEqual([100, 101]);
  });

  it("keeps symbols apart and picks the newest AV row of a week", () => {
    const closes = stitchedCloses([
      row("alpha_vantage", "2026-09-09", 10, null, "SPY"),
      row("alpha_vantage", "2026-09-11", 11, null, "SPY"),
      row("alpha_vantage", "2026-09-11", 7, null, "QQQ"),
    ]);
    expect(closes).toEqual([
      { symbol: "SPY", timestamp: "2026-09-11T16:00:00-04:00", close: 11 },
      { symbol: "QQQ", timestamp: "2026-09-11T16:00:00-04:00", close: 7 },
    ]);
  });
});
