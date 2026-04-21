/**
 * Deterministic frame clock — hyperframes pattern #2.
 *
 * Quantizes wall-clock seconds to the nearest frame boundary so two renders
 * of the same composition emit identical output. Replaces ad-hoc `toFixed(2)`
 * rounding in the composer.
 */

/** Clamp bounds for fps. Rejects pathological values. */
const MIN_FPS = 1;
const MAX_FPS = 240;

/**
 * Quantize a time value in seconds to the nearest frame boundary at the
 * given frame rate. Returns seconds as a number rounded to the frame grid.
 *
 * - Negative `t` returns 0 (frames don't exist before t=0).
 * - NaN/Infinity `t` throws.
 * - fps outside [MIN_FPS, MAX_FPS] throws.
 * - Result is safe to pass to ffmpeg as a decimal-seconds string.
 */
export function quantizeTimeToFrame(t: number, fps: number): number {
  if (!Number.isFinite(t))
    throw new Error(`quantizeTimeToFrame: t is not finite: ${t}`);
  if (!Number.isFinite(fps))
    throw new Error(`quantizeTimeToFrame: fps is not finite: ${fps}`);
  if (fps < MIN_FPS || fps > MAX_FPS) {
    throw new Error(
      `quantizeTimeToFrame: fps out of range [${MIN_FPS}, ${MAX_FPS}]: ${fps}`,
    );
  }
  if (t <= 0) return 0;
  const frame = Math.round(t * fps);
  return frame / fps;
}

/**
 * Format a time for ffmpeg — quantizes and emits decimal seconds with enough
 * precision for single-frame accuracy at any fps <= MAX_FPS.
 */
export function formatFrameTime(t: number, fps: number): string {
  const quantized = quantizeTimeToFrame(t, fps);
  return quantized.toFixed(6);
}

/**
 * Compute the integer frame index for a given time at a given fps.
 * Used by worker-pool sharding.
 */
export function timeToFrameIndex(t: number, fps: number): number {
  if (!Number.isFinite(t) || !Number.isFinite(fps)) {
    throw new Error(`timeToFrameIndex: non-finite input`);
  }
  if (fps < MIN_FPS || fps > MAX_FPS) {
    throw new Error(`timeToFrameIndex: fps out of range`);
  }
  if (t <= 0) return 0;
  return Math.round(t * fps);
}
