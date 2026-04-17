/**
 * Validation tests — every rule has an accept + reject case.
 */

import { describe, it, expect } from "vitest";
import { validateMarketBar } from "./validation.js";
import type { MarketBar } from "./types.js";

function bar(overrides: Partial<MarketBar> = {}): MarketBar {
  return {
    symbol: "SPY",
    timestamp: "2026-04-17T16:00:00-04:00",
    open: 520,
    high: 525,
    low: 518,
    close: 523,
    volume: 50_000_000,
    provider: "alpha_vantage",
    interval: "daily",
    ...overrides,
  };
}

describe("validateMarketBar", () => {
  it("accepts well-formed bar", () => {
    expect(validateMarketBar(bar()).valid).toBe(true);
  });

  it("rejects low > open", () => {
    const result = validateMarketBar(bar({ low: 530, open: 520 }));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/low.*> open/);
  });

  it("rejects high < close", () => {
    // high=522 passes the high<open check (522 >= open=520) but fails high<close (522 < 523)
    const result = validateMarketBar(bar({ high: 522, close: 523 }));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/high.*< close/);
  });

  it("rejects negative volume", () => {
    const result = validateMarketBar(bar({ volume: -100 }));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/volume invalid/);
  });

  it("rejects NaN price", () => {
    const result = validateMarketBar(bar({ close: NaN }));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/close is not finite/);
  });

  it("rejects Infinity price", () => {
    const result = validateMarketBar(bar({ high: Infinity }));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/high is not finite/);
  });

  it("rejects 15x price gap vs previous close (continuity)", () => {
    const prev = bar({ close: 100 });
    const curr = bar({ open: 1500, high: 1600, low: 1400, close: 1500 });
    const result = validateMarketBar(curr, { previousBar: prev });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/ratio/);
  });

  it("flags 100x volume gap as warning (but accepts the bar)", () => {
    const curr = bar({ volume: 10_000_000_000 });
    const result = validateMarketBar(curr, {
      previousVolumes: [
        50_000_000, 52_000_000, 48_000_000, 51_000_000, 49_000_000,
      ],
    });
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.warnings?.[0]).toMatch(/volume/);
  });
});
