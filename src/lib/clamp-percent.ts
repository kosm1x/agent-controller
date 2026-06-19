/**
 * clamp-percent — coerce a numeric input into the [0, 100] percentage range.
 *
 * Why this exists:
 *   Percentage clamping was previously inlined ad-hoc across the codebase
 *   (e.g. `Math.max(0, Math.min(100, x))`) with inconsistent NaN / non-finite
 *   handling. Centralizing the policy here ensures every caller treats
 *   garbage input the same way — typically by falling back to `0` rather than
 *   propagating `NaN` through downstream arithmetic / SQL writes.
 *
 * Edge case policy:
 *   - `NaN`            → fallback (default `0`)
 *   - `+Infinity`      → upper bound (`100`)
 *   - `-Infinity`      → lower bound (`0`)
 *   - non-`number`     → fallback (default `0`) — defensive against `any`/JSON
 *   - `value < 0`      → lower bound (`0`)
 *   - `value > 100`    → upper bound (`100`)
 *   - otherwise        → value unchanged
 *
 * Bounds are fixed at `[0, 100]` because that is the only percentage scale
 * used in this codebase (utility %, cache-hit %, success %, etc.). If a
 * caller needs a different range, they should use a different helper rather
 * than parameterize this one — parameterized bounds invite confusion at the
 * call site about which scale is intended.
 */

/** Lower bound of the percentage range (inclusive). */
const PERCENT_MIN = 0;

/** Upper bound of the percentage range (inclusive). */
const PERCENT_MAX = 100;

/** Default fallback for NaN / non-numeric input. */
const DEFAULT_FALLBACK = 0;

/**
 * Clamp a numeric value into the `[0, 100]` percentage range.
 *
 * Non-finite or non-numeric input collapses to `fallback` (default `0`).
 * `+Infinity` / `-Infinity` are treated as the respective bounds rather than
 * as fallback, because their sign is meaningful.
 *
 * @param value     - The candidate percentage. Typed as `unknown` so callers
 *                    can pass JSON-parsed or `any`-typed data without an
 *                    upstream cast; the function performs its own type guard.
 * @param fallback  - Value returned when `value` is `NaN` or not a number.
 *                    Must itself be inside `[0, 100]`; otherwise it is
 *                    clamped. Defaults to `0`.
 * @returns A finite number in `[0, 100]`.
 *
 * @example
 *   clampPercent(42)        // 42
 *   clampPercent(150)       // 100
 *   clampPercent(-3)        // 0
 *   clampPercent(NaN)       // 0
 *   clampPercent(NaN, 50)   // 50
 *   clampPercent(Infinity)  // 100
 *   clampPercent(-Infinity) // 0
 *   clampPercent("nope")    // 0
 */
export function clampPercent(value: unknown, fallback: number = DEFAULT_FALLBACK): number {
	// Normalize the fallback first so a bad fallback can't escape the range.
	const safeFallback =
		typeof fallback === "number" && Number.isFinite(fallback)
			? Math.min(PERCENT_MAX, Math.max(PERCENT_MIN, fallback))
			: DEFAULT_FALLBACK;

	if (typeof value !== "number") {
		return safeFallback;
	}

	if (Number.isNaN(value)) {
		return safeFallback;
	}

	// Infinities have a meaningful sign — map to the corresponding bound
	// rather than collapsing to fallback.
	if (value === Number.POSITIVE_INFINITY || value > PERCENT_MAX) {
		return PERCENT_MAX;
	}

	if (value === Number.NEGATIVE_INFINITY || value < PERCENT_MIN) {
		return PERCENT_MIN;
	}

	return value;
}
