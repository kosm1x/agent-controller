import { describe, expect, it } from "vitest";
import { FixedClock, WallClock } from "./clock.js";

describe("WallClock", () => {
  it("returns a Date near wall-clock time", () => {
    const clock = new WallClock();
    const before = Date.now();
    const now = clock.now().getTime();
    const after = Date.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
  });

  it("returns a new Date instance on each call", () => {
    const clock = new WallClock();
    const a = clock.now();
    const b = clock.now();
    // May have the same ms, but must not be the same reference
    expect(a).not.toBe(b);
  });
});

describe("FixedClock", () => {
  it("returns the injected date unchanged", () => {
    const t = new Date("2026-04-20T12:34:56Z");
    const clock = new FixedClock(t);
    expect(clock.now().toISOString()).toBe("2026-04-20T12:34:56.000Z");
  });

  it("advance() moves the clock forward", () => {
    const clock = new FixedClock(new Date("2026-04-20T00:00:00Z"));
    clock.advance(60_000);
    expect(clock.now().toISOString()).toBe("2026-04-20T00:01:00.000Z");
  });

  it("set() replaces the clock", () => {
    const clock = new FixedClock(new Date("2026-04-20T00:00:00Z"));
    clock.set(new Date("2027-01-01T00:00:00Z"));
    expect(clock.now().toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("returned Date is a fresh instance (no reference leak)", () => {
    const t = new Date("2026-04-20T00:00:00Z");
    const clock = new FixedClock(t);
    const returned = clock.now();
    // Mutating the returned date must not mutate the clock's internal state
    returned.setFullYear(2099);
    expect(clock.now().getUTCFullYear()).toBe(2026);
  });
});
