import { describe, expect, it } from "vitest";
import {
  cronMatchesAt,
  describeCron,
  fieldMatches,
  nextCronFire,
} from "./cron-next.js";

const MX = "America/Mexico_City";
const NY = "America/New_York";

describe("cronMatchesAt", () => {
  // 2026-08-24 is a Monday. 14:00Z = 08:00 MX (UTC-6, no DST since 2022).
  const mon0800mx = new Date("2026-08-24T14:00:00Z");

  it("matches the wall-clock minute in the given zone", () => {
    expect(cronMatchesAt("0 8 * * *", mon0800mx, MX)).toBe(true);
    expect(cronMatchesAt("0 8 * * *", mon0800mx, NY)).toBe(false); // 10:00 NY
    expect(cronMatchesAt("0 10 * * *", mon0800mx, NY)).toBe(true);
  });

  it("honours weekday ranges and lists", () => {
    expect(cronMatchesAt("0 8 * * 1-5", mon0800mx, MX)).toBe(true);
    expect(cronMatchesAt("0 8 * * 2,4,6", mon0800mx, MX)).toBe(false);
    expect(cronMatchesAt("0 8 * * 0", mon0800mx, MX)).toBe(false);
  });

  it("rejects malformed expressions", () => {
    expect(cronMatchesAt("0 8 *", mon0800mx, MX)).toBe(false);
  });
});

describe("fieldMatches", () => {
  it("steps: */30 matches 0 and 30; 9-21 range; lists", () => {
    expect(fieldMatches("*/30", 0, 0, 59)).toBe(true);
    expect(fieldMatches("*/30", 30, 0, 59)).toBe(true);
    expect(fieldMatches("*/30", 15, 0, 59)).toBe(false);
    expect(fieldMatches("9-21", 9, 0, 23)).toBe(true);
    expect(fieldMatches("9-21", 22, 0, 23)).toBe(false);
    expect(fieldMatches("1,3,5", 3, 0, 6)).toBe(true);
    expect(fieldMatches("9/3", 15, 0, 23)).toBe(true);
    expect(fieldMatches("9/3", 16, 0, 23)).toBe(false);
  });
});

describe("nextCronFire", () => {
  const from = new Date("2026-08-24T14:30:00Z"); // Mon 08:30 MX

  it("finds the next daily fire strictly after `from`", () => {
    expect(nextCronFire("0 8 * * *", from, MX)?.toISOString()).toBe(
      "2026-08-25T14:00:00.000Z",
    );
    expect(nextCronFire("0 12 * * 1-5", from, MX)?.toISOString()).toBe(
      "2026-08-24T18:00:00.000Z",
    );
  });

  it("skips to Friday for a weekly schedule", () => {
    expect(nextCronFire("0 20 * * 5", from, MX)?.toISOString()).toBe(
      "2026-08-29T02:00:00.000Z",
    );
  });

  it("market ritual in New York time", () => {
    // 08:00 NY on Tue 2026-08-25 (EDT, UTC-4) = 12:00Z
    expect(nextCronFire("0 8 * * 1-5", from, NY)?.toISOString()).toBe(
      "2026-08-25T12:00:00.000Z",
    );
  });

  it("fixed-minute stepping matches a brute-force minute scan and is fast (R1 W8)", () => {
    const brute = (expr: string) => {
      const start = new Date(from);
      start.setUTCSeconds(0, 0);
      for (let i = 1; i <= 8 * 1440; i++) {
        const at = new Date(start.getTime() + i * 60_000);
        if (cronMatchesAt(expr, at, MX)) return at.toISOString();
      }
      return null;
    };
    for (const expr of ["0 8 * * *", "50 23 * * *", "30 16 * * 1-5", "0 20 * * 5", "0 1 * * 2,4,6", "*/30 * * * *", "0 9 27 7 *"]) {
      expect(nextCronFire(expr, from, MX)?.toISOString() ?? null).toBe(brute(expr));
    }
    const t0 = performance.now();
    for (let i = 0; i < 10; i++) nextCronFire("0 9 27 7 *", from, MX);
    expect(performance.now() - t0).toBeLessThan(200); // 10 yearly scans; was 188 ms EACH
  });

  it("returns null for a one-shot outside the 8-day window", () => {
    expect(nextCronFire("0 9 27 7 *", from, MX)).toBeNull();
  });
});

describe("describeCron", () => {
  it("renders the common shapes in Spanish", () => {
    expect(describeCron("0 8 * * *")).toBe("diario 08:00");
    expect(describeCron("30 16 * * 1-5")).toBe("L-V 16:30");
    expect(describeCron("0 20 * * 5")).toBe("vie 20:00");
    expect(describeCron("0 1 * * 2,4,6")).toBe("2,4,6 01:00");
    expect(describeCron("0 9 27 7 *")).toBe("0 9 27 7 *");
    expect(describeCron("*/30 * * * *")).toBe("*/30 * * * *");
  });
});
