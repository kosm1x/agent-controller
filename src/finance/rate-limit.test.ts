import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  canCall,
  recordCall,
  msUntilAvailable,
  seedFromHistory,
  currentWindow,
  currentDailyWindow,
  ceilings,
  dailyCeilings,
  __resetForTests,
  DAY_WINDOW_MS,
} from "./rate-limit.js";

describe("rate-limit", () => {
  beforeEach(() => {
    __resetForTests();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-14T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    __resetForTests();
  });

  it("alpha_vantage free-tier ceilings are 4/min and 22/day", () => {
    expect(ceilings().alpha_vantage).toBe(4);
    expect(dailyCeilings().alpha_vantage).toBe(22);
  });

  it("blocks the 5th AV call within a minute, allows after the window slides", () => {
    for (let i = 0; i < 4; i++) {
      expect(canCall("alpha_vantage")).toBe(true);
      recordCall("alpha_vantage");
    }
    expect(canCall("alpha_vantage")).toBe(false);
    expect(msUntilAvailable("alpha_vantage")).toBeGreaterThan(0);
    vi.advanceTimersByTime(61_000);
    expect(canCall("alpha_vantage")).toBe(true);
  });

  it("blocks the 23rd AV call within 24h even when the minute window is clear", () => {
    // 22 calls spread out (well under 4/min each minute)
    for (let i = 0; i < 22; i++) {
      expect(canCall("alpha_vantage")).toBe(true);
      recordCall("alpha_vantage");
      vi.advanceTimersByTime(120_000);
    }
    // Minute window is empty, but the daily quota is exhausted.
    expect(currentWindow().alpha_vantage).toBe(0);
    expect(currentDailyWindow().alpha_vantage).toBe(22);
    expect(canCall("alpha_vantage")).toBe(false);
    // Wait is on the daily window, not the minute window.
    expect(msUntilAvailable("alpha_vantage")).toBeGreaterThan(60_000);
    // Once the oldest call falls out of the 24h window, calls resume.
    vi.advanceTimersByTime(DAY_WINDOW_MS);
    expect(canCall("alpha_vantage")).toBe(true);
  });

  it("polygon has no daily quota — only the minute window binds", () => {
    for (let i = 0; i < 4; i++) recordCall("polygon");
    expect(canCall("polygon")).toBe(false);
    vi.advanceTimersByTime(61_000);
    for (let i = 0; i < 4; i++) {
      expect(canCall("polygon")).toBe(true);
      recordCall("polygon");
    }
    expect(currentDailyWindow().polygon).toBeUndefined();
  });

  it("seedFromHistory retains 24h of AV history so restarts keep the daily budget", () => {
    const now = Date.now();
    const times: string[] = [];
    for (let i = 0; i < 22; i++) {
      times.push(new Date(now - (i + 1) * 3_600_000).toISOString()); // hourly, all within 24h
    }
    seedFromHistory("alpha_vantage", times);
    expect(currentDailyWindow().alpha_vantage).toBe(22);
    expect(canCall("alpha_vantage")).toBe(false);
  });

  it("seedFromHistory keeps only the last minute for minute-window providers", () => {
    const now = Date.now();
    seedFromHistory("polygon", [
      new Date(now - 30_000).toISOString(),
      new Date(now - 3_600_000).toISOString(), // outside 60s — dropped
    ]);
    expect(currentWindow().polygon).toBe(1);
  });
});
