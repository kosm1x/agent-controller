/**
 * Timezone normalization tests — DST edge cases + every provider shape.
 */

import { describe, it, expect } from "vitest";
import {
  fromAlphaVantageIntraday,
  fromAlphaVantageDaily,
  fromPolygonUnixMs,
  fromFredDate,
  isReasonableTimestamp,
} from "./timezone.js";

describe("timezone normalization", () => {
  it("normalizes Alpha Vantage US/Eastern intraday to NY ISO with DST offset", () => {
    // A summer afternoon in Eastern — should be -04:00 (EDT)
    const out = fromAlphaVantageIntraday("2026-07-15 14:30:00");
    expect(out).toBe("2026-07-15T14:30:00-04:00");
  });

  it("normalizes Polygon Unix ms UTC to NY ISO", () => {
    // 2026-04-17T19:30:00Z -> in NY summer EDT that's 15:30 -04:00
    const utcMs = Date.UTC(2026, 3, 17, 19, 30, 0);
    const out = fromPolygonUnixMs(utcMs);
    expect(out).toBe("2026-04-17T15:30:00-04:00");
  });

  it("keeps FRED YYYY-MM-DD date-only (no time, no TZ)", () => {
    expect(fromFredDate("2026-01-15")).toBe("2026-01-15");
  });

  it("handles DST spring-forward week (2026-03-08) — EST (-05:00) before, EDT (-04:00) after", () => {
    // Before spring forward (2026-03-07 afternoon): still EST -05:00
    const pre = fromAlphaVantageDaily("2026-03-07");
    expect(pre).toBe("2026-03-07T16:00:00-05:00");
    // After spring forward (2026-03-09 afternoon): now EDT -04:00
    const post = fromAlphaVantageDaily("2026-03-09");
    expect(post).toBe("2026-03-09T16:00:00-04:00");
  });

  it("handles DST fall-back week (2026-11-01) — EDT before, EST after", () => {
    // 2026-10-31 still EDT
    const pre = fromAlphaVantageDaily("2026-10-31");
    expect(pre).toBe("2026-10-31T16:00:00-04:00");
    // 2026-11-02 now EST
    const post = fromAlphaVantageDaily("2026-11-02");
    expect(post).toBe("2026-11-02T16:00:00-05:00");
  });

  it("rejects timestamps pre-1990 and future-dated > 7 days", () => {
    expect(isReasonableTimestamp("1980-01-01T00:00:00Z")).toBe(false);
    const futureTooFar = new Date(
      Date.now() + 30 * 24 * 60 * 60 * 1000,
    ).toISOString();
    expect(isReasonableTimestamp(futureTooFar)).toBe(false);
    // Current reasonable timestamp passes
    expect(isReasonableTimestamp("2026-04-17T15:00:00-04:00")).toBe(true);
    // Invalid shape fails
    expect(isReasonableTimestamp("not-a-date")).toBe(false);
  });
});
