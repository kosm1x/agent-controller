import { describe, it, expect } from "vitest";
import { nextReview, masteryFromSm2, masteryToQuality } from "./sm2.js";
import { DEFAULT_EF, EF_FLOOR } from "./schema-types.js";

const NOW = 1_700_000_000; // fixed unix-sec anchor

describe("nextReview (SM-2)", () => {
  it("resets on quality < 3 (failure)", () => {
    const out = nextReview({
      ef: 2.5,
      interval_days: 30,
      repetitions: 4,
      quality: 2,
      now: NOW,
    });
    expect(out.repetitions).toBe(0);
    expect(out.interval_days).toBe(1);
    expect(out.review_due_date).toBe(NOW + 86400);
  });

  it("first pass (quality=3, reps=0 → reps=1, interval=1)", () => {
    const out = nextReview({
      ef: DEFAULT_EF,
      interval_days: 0,
      repetitions: 0,
      quality: 3,
      now: NOW,
    });
    expect(out.repetitions).toBe(1);
    expect(out.interval_days).toBe(1);
  });

  it("second pass → interval=6", () => {
    const out = nextReview({
      ef: DEFAULT_EF,
      interval_days: 1,
      repetitions: 1,
      quality: 4,
      now: NOW,
    });
    expect(out.repetitions).toBe(2);
    expect(out.interval_days).toBe(6);
  });

  it("third+ pass → interval = round(prev * ef)", () => {
    const out = nextReview({
      ef: 2.5,
      interval_days: 6,
      repetitions: 2,
      quality: 5,
      now: NOW,
    });
    expect(out.repetitions).toBe(3);
    expect(out.interval_days).toBe(15); // 6 * 2.5 = 15
  });

  it("EF floor clamps at 1.3", () => {
    // Quality=0 would drop EF below 1.3
    let ef = 1.4;
    for (let i = 0; i < 5; i++) {
      const out = nextReview({
        ef,
        interval_days: 1,
        repetitions: 0,
        quality: 0,
        now: NOW,
      });
      ef = out.ef;
    }
    expect(ef).toBe(EF_FLOOR);
  });

  it("quality=5 raises EF", () => {
    const out = nextReview({
      ef: 2.5,
      interval_days: 6,
      repetitions: 2,
      quality: 5,
      now: NOW,
    });
    expect(out.ef).toBeGreaterThan(2.5);
  });

  it("review_due_date math: interval_days * 86400 + now", () => {
    const out = nextReview({
      ef: 2.5,
      interval_days: 1,
      repetitions: 1,
      quality: 4,
      now: NOW,
    });
    expect(out.review_due_date).toBe(NOW + 6 * 86400);
  });

  it("quality is clamped to 0..5", () => {
    const low = nextReview({
      ef: 2.5,
      interval_days: 10,
      repetitions: 3,
      quality: -2,
      now: NOW,
    });
    expect(low.repetitions).toBe(0); // < 3 = reset
    const high = nextReview({
      ef: 2.5,
      interval_days: 6,
      repetitions: 2,
      quality: 99,
      now: NOW,
    });
    expect(high.repetitions).toBe(3);
  });

  it("quality is rounded", () => {
    const out = nextReview({
      ef: 2.5,
      interval_days: 6,
      repetitions: 2,
      quality: 4.4,
      now: NOW,
    });
    // 4.4 → 4 → passes (>=3) → advances
    expect(out.repetitions).toBe(3);
  });
});

describe("masteryFromSm2", () => {
  it("fresh concept → low", () => {
    expect(masteryFromSm2(2.5, 0, 0)).toBeLessThan(0.1);
  });

  it("well-established concept → high", () => {
    expect(masteryFromSm2(2.8, 6, 30)).toBeGreaterThan(0.8);
  });

  it("always clamped to [0,1]", () => {
    expect(masteryFromSm2(10, 100, 365)).toBeLessThanOrEqual(1);
    expect(masteryFromSm2(0, 0, 0)).toBeGreaterThanOrEqual(0);
  });
});

describe("masteryToQuality", () => {
  it("0 → 0", () => {
    expect(masteryToQuality(0)).toBe(0);
  });
  it("1 → 5", () => {
    expect(masteryToQuality(1)).toBe(5);
  });
  it("0.5 → 3 (passing)", () => {
    expect(masteryToQuality(0.5)).toBeGreaterThanOrEqual(2);
    expect(masteryToQuality(0.5)).toBeLessThanOrEqual(3);
  });
  it("clamps out-of-range input", () => {
    expect(masteryToQuality(-1)).toBe(0);
    expect(masteryToQuality(2)).toBe(5);
  });
});
