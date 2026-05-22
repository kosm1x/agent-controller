/**
 * Timezone helper tests — covers `toIsoUtc` (the A1 briefing fix) and the
 * `nowMexDate`/`nowMexTime` output shapes the LLM's `[Hoy: …]` block depends on.
 */

import { describe, it, expect } from "vitest";
import { toIsoUtc, nowMexDate, nowMexTime } from "./timezone.js";

describe("toIsoUtc", () => {
  it("returns null for empty / null / undefined input", () => {
    expect(toIsoUtc(null)).toBeNull();
    expect(toIsoUtc(undefined)).toBeNull();
    expect(toIsoUtc("")).toBeNull();
  });

  it("normalizes a SQLite datetime('now') string to strict ISO", () => {
    // The exact form that broke the 2026-05-22 morning briefing.
    expect(toIsoUtc("2026-05-22 06:00:00")).toBe("2026-05-22T06:00:00.000Z");
  });

  it("passes an already-ISO Z string through unchanged", () => {
    expect(toIsoUtc("2026-05-22T06:00:00.000Z")).toBe(
      "2026-05-22T06:00:00.000Z",
    );
  });

  it("converts an offset timestamp to UTC", () => {
    expect(toIsoUtc("2026-04-17T16:00:00-04:00")).toBe(
      "2026-04-17T20:00:00.000Z",
    );
  });

  it("returns null for an unparseable timestamp", () => {
    expect(toIsoUtc("garbage")).toBeNull();
    expect(toIsoUtc("2026-13-99 99:99:99")).toBeNull();
  });
});

describe("nowMexDate", () => {
  it("emits ISO date + Spanish weekday in parens", () => {
    // e.g. "2026-05-22 (viernes)" — ISO anchor the system prompt expects.
    expect(nowMexDate()).toMatch(/^\d{4}-\d{2}-\d{2} \(\p{L}+\)$/u);
  });
});

describe("nowMexTime", () => {
  it("emits 24-hour HH:MM", () => {
    expect(nowMexTime()).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
  });
});
