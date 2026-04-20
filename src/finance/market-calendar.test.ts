import { describe, expect, it } from "vitest";
import {
  NYSE_HOLIDAYS_2024_2027,
  holidayFor,
  isEarlyClose,
  isFridayNY,
  isNyseTradingDay,
  nextTradingDay,
  prevTradingDay,
  toNyDate,
} from "./market-calendar.js";

describe("toNyDate", () => {
  it("passes through YYYY-MM-DD strings", () => {
    expect(toNyDate("2026-04-20")).toBe("2026-04-20");
  });

  it("converts a Date to NY-local ISO", () => {
    // 2026-04-21 04:00 UTC = 2026-04-21 00:00 ET (spring DST) = still 04-21 NY
    const d = new Date("2026-04-21T04:00:00Z");
    expect(toNyDate(d)).toBe("2026-04-21");
  });

  it("handles a UTC timestamp that crosses the NY date boundary", () => {
    // 2026-04-21 02:00 UTC = 2026-04-20 22:00 ET → NY date is 04-20
    const d = new Date("2026-04-21T02:00:00Z");
    expect(toNyDate(d)).toBe("2026-04-20");
  });

  it("throws on malformed input", () => {
    expect(() => toNyDate("not-a-date" as unknown as string)).toThrow();
  });
});

describe("isNyseTradingDay", () => {
  it("returns false for weekends", () => {
    // 2026-04-18 = Saturday, 2026-04-19 = Sunday
    expect(isNyseTradingDay("2026-04-18")).toBe(false);
    expect(isNyseTradingDay("2026-04-19")).toBe(false);
  });

  it("returns true for a regular weekday", () => {
    // 2026-04-20 = Monday, no holiday
    expect(isNyseTradingDay("2026-04-20")).toBe(true);
  });

  it("returns false for full-day holidays", () => {
    expect(isNyseTradingDay("2026-01-01")).toBe(false); // New Year's 2026
    expect(isNyseTradingDay("2026-05-25")).toBe(false); // Memorial Day 2026
    expect(isNyseTradingDay("2024-12-25")).toBe(false); // Christmas 2024
  });

  it("returns TRUE for early-close days (market is open, just closes at 13:00)", () => {
    // 2026-11-27 = Day after Thanksgiving, early close
    expect(isNyseTradingDay("2026-11-27")).toBe(true);
    expect(isEarlyClose("2026-11-27")).toBe(true);
  });
});

describe("isEarlyClose", () => {
  it("detects 13:00 ET close days", () => {
    expect(isEarlyClose("2025-11-28")).toBe(true); // Day after Thanksgiving 2025
    expect(isEarlyClose("2026-12-24")).toBe(true); // Christmas Eve 2026
  });

  it("returns false for regular trading days", () => {
    expect(isEarlyClose("2026-04-20")).toBe(false);
  });

  it("returns false for full-day holidays", () => {
    expect(isEarlyClose("2026-12-25")).toBe(false); // closed full day, not early
  });
});

describe("nextTradingDay + prevTradingDay", () => {
  it("skips Saturdays + Sundays", () => {
    // Friday 2026-04-17 → next trading day is Monday 2026-04-20
    expect(nextTradingDay("2026-04-17")).toBe("2026-04-20");
    // Monday 2026-04-20 → prev trading day is Friday 2026-04-17
    expect(prevTradingDay("2026-04-20")).toBe("2026-04-17");
  });

  it("skips holidays", () => {
    // 2026-12-23 Wed → next is 2026-12-24 (early close, still trading),
    // NOT 2026-12-25 Christmas which is closed full day
    expect(nextTradingDay("2026-12-23")).toBe("2026-12-24");
    // After Christmas Eve half-day → skip Christmas Day → Monday 12-28
    expect(nextTradingDay("2026-12-24")).toBe("2026-12-28");
  });

  it("handles weekend+holiday stacks (4th of July 2026 ≈ Sunday → observed Friday)", () => {
    // 2026-07-02 Thu → next trading day skips 07-03 Independence Day observed,
    // lands on 2026-07-06 Monday
    expect(nextTradingDay("2026-07-02")).toBe("2026-07-06");
  });
});

describe("holidayFor", () => {
  it("returns the record for a known holiday", () => {
    const h = holidayFor("2026-05-25");
    expect(h?.reason).toMatch(/Memorial/);
    expect(h?.earlyClose).toBe(false);
  });

  it("returns null for regular days", () => {
    expect(holidayFor("2026-04-20")).toBeNull();
  });
});

describe("isFridayNY", () => {
  it("detects Friday", () => {
    // 2026-04-17 is a Friday
    expect(isFridayNY("2026-04-17")).toBe(true);
  });

  it("returns false for non-Fridays", () => {
    expect(isFridayNY("2026-04-20")).toBe(false); // Monday
    expect(isFridayNY("2026-04-18")).toBe(false); // Saturday
  });
});

describe("NYSE_HOLIDAYS_2024_2027 dataset integrity", () => {
  it("is sorted ascending by date", () => {
    for (let i = 1; i < NYSE_HOLIDAYS_2024_2027.length; i++) {
      expect(
        NYSE_HOLIDAYS_2024_2027[i]!.date >=
          NYSE_HOLIDAYS_2024_2027[i - 1]!.date,
      ).toBe(true);
    }
  });

  it("has no duplicate dates", () => {
    const seen = new Set<string>();
    for (const h of NYSE_HOLIDAYS_2024_2027) {
      expect(seen.has(h.date)).toBe(false);
      seen.add(h.date);
    }
  });

  it("covers 2024-2027 with 9-10+ full-day holidays per year", () => {
    const byYear = new Map<string, number>();
    for (const h of NYSE_HOLIDAYS_2024_2027) {
      const year = h.date.slice(0, 4);
      if (!h.earlyClose) byYear.set(year, (byYear.get(year) ?? 0) + 1);
    }
    for (const year of ["2024", "2025", "2026", "2027"]) {
      const n = byYear.get(year) ?? 0;
      // NYSE has 9-11 full-day closures/yr depending on weekend overlaps
      expect(n).toBeGreaterThanOrEqual(9);
      expect(n).toBeLessThanOrEqual(12);
    }
  });
});
