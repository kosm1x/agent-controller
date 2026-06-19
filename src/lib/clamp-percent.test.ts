/**
 * Tests for clamp-percent.
 *
 * Covers the edge-case policy documented in the module header:
 *   - values in range
 *   - values below 0
 *   - values above 100
 *   - NaN (uses fallback)
 *   - +Infinity → 100
 *   - -Infinity → 0
 *   - boundary values 0 and 100 (inclusive)
 *
 * Also includes the defensive non-`number` path and the fallback-clamping
 * contract because both are part of the public guarantee (a bad fallback
 * cannot escape the [0, 100] range).
 */

import { describe, it, expect } from "vitest";
import { clampPercent } from "./clamp-percent.js";

describe("clampPercent", () => {
	describe("values in range", () => {
		it("returns the value unchanged for a typical mid-range number", () => {
			expect(clampPercent(42)).toBe(42);
		});

		it("preserves fractional values", () => {
			expect(clampPercent(33.33)).toBe(33.33);
		});

		it("preserves small positive values near the lower bound", () => {
			expect(clampPercent(0.0001)).toBe(0.0001);
		});

		it("preserves values near the upper bound", () => {
			expect(clampPercent(99.9999)).toBe(99.9999);
		});
	});

	describe("values below 0", () => {
		it("clamps a small negative value to 0", () => {
			expect(clampPercent(-1)).toBe(0);
		});

		it("clamps a large negative value to 0", () => {
			expect(clampPercent(-9999)).toBe(0);
		});

		it("clamps a fractional negative value to 0", () => {
			expect(clampPercent(-0.0001)).toBe(0);
		});
	});

	describe("values above 100", () => {
		it("clamps a value just over the upper bound to 100", () => {
			expect(clampPercent(100.0001)).toBe(100);
		});

		it("clamps a typical out-of-range value to 100", () => {
			expect(clampPercent(150)).toBe(100);
		});

		it("clamps an extreme value to 100", () => {
			expect(clampPercent(1e9)).toBe(100);
		});
	});

	describe("NaN", () => {
		it("returns the default fallback (0) for NaN", () => {
			expect(clampPercent(NaN)).toBe(0);
		});

		it("returns the provided fallback for NaN", () => {
			expect(clampPercent(NaN, 50)).toBe(50);
		});

		it("clamps an out-of-range fallback before returning it", () => {
			expect(clampPercent(NaN, 250)).toBe(100);
			expect(clampPercent(NaN, -10)).toBe(0);
		});

		it("ignores a non-finite fallback and uses the default 0", () => {
			expect(clampPercent(NaN, NaN)).toBe(0);
			expect(clampPercent(NaN, Infinity)).toBe(0);
		});
	});

	describe("Infinity", () => {
		it("maps +Infinity to the upper bound 100", () => {
			expect(clampPercent(Infinity)).toBe(100);
		});

		it("maps Number.POSITIVE_INFINITY to 100", () => {
			expect(clampPercent(Number.POSITIVE_INFINITY)).toBe(100);
		});

		it("does NOT collapse +Infinity to the fallback (sign is meaningful)", () => {
			// Even with fallback=50, +Infinity should map to 100, not 50.
			expect(clampPercent(Infinity, 50)).toBe(100);
		});
	});

	describe("-Infinity", () => {
		it("maps -Infinity to the lower bound 0", () => {
			expect(clampPercent(-Infinity)).toBe(0);
		});

		it("maps Number.NEGATIVE_INFINITY to 0", () => {
			expect(clampPercent(Number.NEGATIVE_INFINITY)).toBe(0);
		});

		it("does NOT collapse -Infinity to the fallback (sign is meaningful)", () => {
			// Even with fallback=50, -Infinity should map to 0, not 50.
			expect(clampPercent(-Infinity, 50)).toBe(0);
		});
	});

	describe("boundary values", () => {
		it("returns 0 unchanged (lower bound is inclusive)", () => {
			expect(clampPercent(0)).toBe(0);
		});

		it("returns 100 unchanged (upper bound is inclusive)", () => {
			expect(clampPercent(100)).toBe(100);
		});

		it("preserves the sign of zero as a non-negative result", () => {
			// -0 is === 0 in JS; documenting that we don't accidentally treat it as <0.
			// Use loose === equality (not Object.is) since the contract is "not below 0",
			// and -0 === 0 is true in JS.
			const result = clampPercent(-0);
			expect(result === 0).toBe(true);
		});
	});

	describe("non-number input (defensive guard)", () => {
		it("returns the default fallback for a string", () => {
			expect(clampPercent("42" as unknown)).toBe(0);
		});

		it("returns the default fallback for null", () => {
			expect(clampPercent(null)).toBe(0);
		});

		it("returns the default fallback for undefined", () => {
			expect(clampPercent(undefined)).toBe(0);
		});

		it("returns the default fallback for an object", () => {
			expect(clampPercent({ value: 42 })).toBe(0);
		});

		it("returns the default fallback for a boolean", () => {
			expect(clampPercent(true)).toBe(0);
		});

		it("honors the provided fallback for non-number input", () => {
			expect(clampPercent("nope", 75)).toBe(75);
		});
	});
});
