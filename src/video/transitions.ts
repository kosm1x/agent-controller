/**
 * Transition library — hyperframes pattern #7, adapted.
 *
 * Maps 14 shader-style transition names to ffmpeg `xfade` filter invocations.
 * 8 names have direct native xfade support; 6 GL-only shaders fall back to
 * `dissolve` with a console.warn pointing at v7.4.4 for true shader support.
 */

/**
 * All supported transition names. Callers pick one of these; the library
 * resolves to an ffmpeg xfade argument and a "native" flag.
 */
export type TransitionName =
  | "fade"
  | "wipeleft"
  | "wiperight"
  | "circleopen"
  | "circlecrop"
  | "pixelize"
  | "dissolve"
  | "radial"
  | "domain-warp"
  | "ridged-burn"
  | "gravitational-lens"
  | "chromatic-radial-split"
  | "sdf-iris"
  | "rgb-displacement";

export const TRANSITION_NAMES: readonly TransitionName[] = [
  "fade",
  "wipeleft",
  "wiperight",
  "circleopen",
  "circlecrop",
  "pixelize",
  "dissolve",
  "radial",
  "domain-warp",
  "ridged-burn",
  "gravitational-lens",
  "chromatic-radial-split",
  "sdf-iris",
  "rgb-displacement",
] as const;

/**
 * Mapping from our transition name to ffmpeg xfade's `transition=` parameter.
 * GL-only shaders fall back to `dissolve` (visually closest noise-based xfade).
 */
const TRANSITION_MAP: Record<
  TransitionName,
  { xfade: string; native: boolean }
> = {
  fade: { xfade: "fade", native: true },
  wipeleft: { xfade: "wipeleft", native: true },
  wiperight: { xfade: "wiperight", native: true },
  circleopen: { xfade: "circleopen", native: true },
  circlecrop: { xfade: "circlecrop", native: true },
  pixelize: { xfade: "pixelize", native: true },
  dissolve: { xfade: "dissolve", native: true },
  radial: { xfade: "radial", native: true },
  "domain-warp": { xfade: "dissolve", native: false },
  "ridged-burn": { xfade: "dissolve", native: false },
  "gravitational-lens": { xfade: "dissolve", native: false },
  "chromatic-radial-split": { xfade: "dissolve", native: false },
  "sdf-iris": { xfade: "dissolve", native: false },
  "rgb-displacement": { xfade: "dissolve", native: false },
};

export interface XfadeFilterSpec {
  /** The transition name resolved to ffmpeg's xfade `transition=` value. */
  xfadeName: string;
  /** Whether this transition is natively supported by ffmpeg xfade. */
  native: boolean;
  /** Full filter-complex string: `xfade=transition=NAME:duration=X:offset=Y`. */
  filterExpr: string;
}

/**
 * Resolve a transition name + duration + offset into a ready-to-use
 * ffmpeg xfade filter expression. Throws on unknown name.
 */
export function resolveTransition(
  name: TransitionName,
  durationSec: number,
  offsetSec: number,
): XfadeFilterSpec {
  const mapping = TRANSITION_MAP[name];
  if (!mapping) {
    throw new Error(
      `resolveTransition: unknown transition name: ${String(name)}`,
    );
  }
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error(
      `resolveTransition: durationSec must be positive finite, got ${durationSec}`,
    );
  }
  if (!Number.isFinite(offsetSec) || offsetSec < 0) {
    throw new Error(
      `resolveTransition: offsetSec must be non-negative finite, got ${offsetSec}`,
    );
  }
  if (!mapping.native) {
    console.warn(
      `[v7.4 transitions] "${name}" is a GL-only shader; falling back to ` +
        `xfade=dissolve. True shader support lands in v7.4.4.`,
    );
  }
  const filterExpr = `xfade=transition=${mapping.xfade}:duration=${durationSec.toFixed(3)}:offset=${offsetSec.toFixed(3)}`;
  return {
    xfadeName: mapping.xfade,
    native: mapping.native,
    filterExpr,
  };
}

/**
 * Check whether a string is a known transition name. Useful for Zod refinement.
 */
export function isTransitionName(value: unknown): value is TransitionName {
  return (
    typeof value === "string" &&
    (TRANSITION_NAMES as readonly string[]).includes(value)
  );
}
