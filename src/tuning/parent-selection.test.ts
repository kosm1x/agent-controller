import { describe, it, expect } from "vitest";
import { selectParent } from "./parent-selection.js";
import type { TuneVariant } from "./types.js";

function makeVariant(
  overrides: Partial<TuneVariant> & { variant_id: string },
): TuneVariant {
  return {
    parent_id: null,
    run_id: "test-run",
    generation: 0,
    config_json: "{}",
    composite_score: 50,
    subscores_json: null,
    valid: true,
    activated_at: null,
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("selectParent", () => {
  it("returns null for empty variants", () => {
    expect(selectParent("best", [])).toBeNull();
    expect(selectParent("latest", [])).toBeNull();
    expect(selectParent("score_prop", [])).toBeNull();
  });

  it("returns the only variant regardless of strategy", () => {
    const v = makeVariant({ variant_id: "only" });
    expect(selectParent("best", [v])?.variant_id).toBe("only");
    expect(selectParent("latest", [v])?.variant_id).toBe("only");
    expect(selectParent("score_prop", [v])?.variant_id).toBe("only");
  });

  describe("best", () => {
    it("selects highest-scoring variant (first in pre-sorted list)", () => {
      const variants = [
        makeVariant({ variant_id: "a", composite_score: 90 }),
        makeVariant({ variant_id: "b", composite_score: 70 }),
        makeVariant({ variant_id: "c", composite_score: 50 }),
      ];
      expect(selectParent("best", variants)?.variant_id).toBe("a");
    });
  });

  describe("latest", () => {
    it("selects most recent created_at", () => {
      const variants = [
        makeVariant({
          variant_id: "old",
          created_at: "2026-01-01T00:00:00Z",
        }),
        makeVariant({
          variant_id: "new",
          created_at: "2026-03-25T12:00:00Z",
        }),
        makeVariant({
          variant_id: "mid",
          created_at: "2026-02-15T00:00:00Z",
        }),
      ];
      expect(selectParent("latest", variants)?.variant_id).toBe("new");
    });
  });

  describe("score_prop", () => {
    it("never returns null with valid variants", () => {
      const variants = [
        makeVariant({ variant_id: "a", composite_score: 10 }),
        makeVariant({ variant_id: "b", composite_score: 90 }),
      ];
      // Run multiple times to check for null
      for (let i = 0; i < 20; i++) {
        expect(selectParent("score_prop", variants)).not.toBeNull();
      }
    });

    it("handles all-zero scores (uniform random)", () => {
      const variants = [
        makeVariant({ variant_id: "a", composite_score: 0 }),
        makeVariant({ variant_id: "b", composite_score: 0 }),
      ];
      const result = selectParent("score_prop", variants);
      expect(result).not.toBeNull();
      expect(["a", "b"]).toContain(result!.variant_id);
    });

    it("favors higher-scoring variants over many runs", () => {
      const variants = [
        makeVariant({ variant_id: "low", composite_score: 10 }),
        makeVariant({ variant_id: "high", composite_score: 90 }),
      ];

      const counts: Record<string, number> = { low: 0, high: 0 };
      for (let i = 0; i < 1000; i++) {
        const v = selectParent("score_prop", variants)!;
        counts[v.variant_id]++;
      }

      // High should be selected ~9x more often than low
      expect(counts.high).toBeGreaterThan(counts.low * 3);
    });
  });
});
