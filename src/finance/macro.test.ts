/**
 * F5 macro regime classifier tests.
 *
 * Each regime rule gets: hard-match, soft-match, no-match case.
 * Trend helpers tested independently on synthetic series.
 */

import { describe, it, expect } from "vitest";
import {
  classifyRegime,
  classifyTrend,
  latestMacroValue,
  yoyChange,
  seriesStalenessDays,
  type MacroSeriesBundle,
} from "./macro.js";
import type { MacroPoint } from "./types.js";

function series(
  name: string,
  points: { date: string; value: number }[],
): MacroPoint[] {
  return points.map((p) => ({
    series: name,
    date: p.date,
    value: p.value,
    provider: "fred" as const,
  }));
}

/** Monotonic-rising series over N months. */
function rising(
  name: string,
  n: number,
  start = 3.0,
  step = 0.1,
): MacroPoint[] {
  return Array.from({ length: n }, (_, i) => ({
    series: name,
    date: `2025-${String((i % 12) + 1).padStart(2, "0")}-01`,
    value: start + i * step,
    provider: "fred" as const,
  }));
}

function falling(
  name: string,
  n: number,
  start = 5.0,
  step = 0.1,
): MacroPoint[] {
  return Array.from({ length: n }, (_, i) => ({
    series: name,
    date: `2025-${String((i % 12) + 1).padStart(2, "0")}-01`,
    value: start - i * step,
    provider: "fred" as const,
  }));
}

function flat(name: string, n: number, value = 3.0): MacroPoint[] {
  return Array.from({ length: n }, (_, i) => ({
    series: name,
    date: `2025-${String((i % 12) + 1).padStart(2, "0")}-01`,
    value,
    provider: "fred" as const,
  }));
}

function emptyBundle(): MacroSeriesBundle {
  return {
    fedFunds: [],
    treasury2y: [],
    treasury10y: [],
    cpi: [],
    unemployment: [],
    m2: [],
    vixcls: [],
    icsa: [],
  };
}

describe("latestMacroValue", () => {
  it("returns last value", () => {
    const s = series("X", [
      { date: "2025-01-01", value: 1 },
      { date: "2025-02-01", value: 2 },
    ]);
    expect(latestMacroValue(s)).toBe(2);
  });
  it("returns null for empty", () => {
    expect(latestMacroValue([])).toBeNull();
  });
});

describe("classifyTrend", () => {
  it("detects strictly rising", () => {
    expect(classifyTrend(rising("X", 10))).toBe("rising");
  });
  it("detects strictly falling", () => {
    expect(classifyTrend(falling("X", 10))).toBe("falling");
  });
  it("detects flat", () => {
    expect(classifyTrend(flat("X", 10))).toBe("flat");
  });
  it("detects normalizing (rising then flat)", () => {
    const points = [
      ...Array.from({ length: 5 }, (_, i) => ({
        date: `2025-${String(i + 1).padStart(2, "0")}-01`,
        value: 1 + i * 0.5,
      })), // rising 1..3
      ...Array.from({ length: 3 }, (_, i) => ({
        date: `2025-${String(i + 6).padStart(2, "0")}-01`,
        value: 3.0 + i * 0.02, // almost flat with a tiny upward drift
      })),
    ];
    expect(classifyTrend(series("X", points))).toBe("normalizing");
  });
});

describe("yoyChange", () => {
  it("computes year-over-year percentage", () => {
    const s = series("X", [
      { date: "2024-04-01", value: 100 },
      { date: "2025-04-01", value: 110 },
    ]);
    expect(yoyChange(s)!).toBeCloseTo(10, 4);
  });
  it("returns null when only one point", () => {
    const s = series("X", [{ date: "2025-04-01", value: 100 }]);
    // Only-point case: latest matches itself → yoy=0
    expect(yoyChange(s)!).toBe(0);
  });
});

describe("seriesStalenessDays", () => {
  it("returns Infinity for empty", () => {
    expect(seriesStalenessDays([])).toBe(Infinity);
  });
});

describe("classifyRegime rules", () => {
  it("recession_risk fires when yield curve inverted AND unemployment rising", () => {
    const b = emptyBundle();
    b.treasury10y = flat("T10", 10, 3.0);
    b.treasury2y = flat("T2", 10, 4.0); // curve = -1.0 (inverted)
    b.unemployment = rising("UE", 10, 3.5, 0.2);
    const r = classifyRegime(b);
    expect(r.regime).toBe("recession_risk");
    expect(r.confidence).toBe(0.85);
    expect(r.yieldCurve!).toBeCloseTo(-1.0, 4);
    expect(r.reasons.some((x) => x.includes("inverted"))).toBe(true);
  });

  it("tightening fires when fed rate rising AND M2 falling", () => {
    const b = emptyBundle();
    b.fedFunds = rising("FF", 10, 2.0, 0.2);
    b.m2 = falling("M2", 10, 20_000, 50);
    // Add positive yield curve to prevent expansion rule from tying
    b.treasury10y = flat("T10", 10, 5.0);
    b.treasury2y = flat("T2", 10, 4.0);
    b.unemployment = flat("UE", 10, 3.5);
    const r = classifyRegime(b);
    expect(r.regime).toBe("tightening");
    expect(r.confidence).toBe(0.85);
  });

  it("expansion fires when yield curve positive, unemployment falling, VIX low", () => {
    const b = emptyBundle();
    b.treasury10y = flat("T10", 10, 4.5);
    b.treasury2y = flat("T2", 10, 3.0); // curve +1.5
    b.unemployment = falling("UE", 10, 4.5, 0.1);
    b.vixcls = flat("VIX", 10, 15);
    const r = classifyRegime(b);
    expect(r.regime).toBe("expansion");
    expect(r.confidence).toBe(0.85);
  });

  it("severity-ranked conflict resolution when multiple regimes fire hard", () => {
    // recession_risk AND tightening both fire hard. Audit W3: severity ranking
    // picks recession_risk (4) over tightening (3); loser folds into reasons[].
    const b = emptyBundle();
    b.treasury10y = flat("T10", 10, 3.0);
    b.treasury2y = flat("T2", 10, 4.0); // inverted
    b.unemployment = rising("UE", 10);
    b.fedFunds = rising("FF", 10);
    b.m2 = falling("M2", 10, 20_000, 50);
    const r = classifyRegime(b);
    expect(r.regime).toBe("recession_risk");
    expect(r.confidence).toBe(0.85);
    expect(r.reasons.some((x) => x.includes("also fired hard"))).toBe(true);
    expect(r.reasons.some((x) => x.includes("tightening"))).toBe(true);
  });

  it("mixed when no rule conditions met", () => {
    const b = emptyBundle();
    b.treasury10y = flat("T10", 10, 4.0);
    b.treasury2y = flat("T2", 10, 4.0); // curve=0 (not >0.5, not <0)
    b.unemployment = flat("UE", 10);
    b.fedFunds = flat("FF", 10);
    b.m2 = flat("M2", 10);
    b.vixcls = flat("VIX", 10, 25); // VIX above 20
    const r = classifyRegime(b);
    expect(r.regime).toBe("mixed");
  });

  it("returns all null values when bundle is empty", () => {
    const r = classifyRegime(emptyBundle());
    expect(r.yieldCurve).toBeNull();
    expect(r.fedRate).toBeNull();
    expect(r.vix).toBeNull();
    expect(r.regime).toBe("mixed");
  });

  it("populates inflation YoY from CPI series", () => {
    const b = emptyBundle();
    b.cpi = series("CPI", [
      { date: "2024-04-01", value: 300 },
      { date: "2025-04-01", value: 309 }, // 3% YoY
    ]);
    const r = classifyRegime(b);
    expect(r.inflationYoY!).toBeCloseTo(3, 1);
  });
});
