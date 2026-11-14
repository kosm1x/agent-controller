/**
 * Test helper, not a test file: processor time per call, and how it grows with
 * the input's size, for tests that bound how expensive a function is.
 *
 * Process processor time (user + system), not elapsed time: a fixed bound on
 * elapsed time fails on a busy machine although nothing is wrong, while
 * processor time leaves out the time spent waiting for a processor.
 *
 * Imports nothing and does no work on import.
 */

/** CPU ms per call of `fn`: one warm-up call, then the minimum of 3 runs of `reps` calls each. */
export function cpuMsPerCall(fn: () => unknown, reps = 1): number {
  fn();
  let best = Infinity;
  for (let r = 0; r < 3; r++) {
    const c0 = process.cpuUsage();
    for (let i = 0; i < reps; i++) fn();
    const d = process.cpuUsage(c0);
    best = Math.min(best, (d.user + d.system) / 1000);
  }
  return best / reps;
}

/** Bound on `growth4x().ratio`: linear work measures about 4, quadratic work about 16. */
export const GROWTH_BOUND = 8;

/**
 * How the CPU time of `fn` grows from input `make(n)` to input `make(4 * n)`. Both sizes repeat
 * the call the same number of times, doubled until one run of the smaller size takes 40 ms or
 * reaches the cap of 1,000,000 calls, so the figure is not lost in timer noise. Linear work grows
 * about 4x and quadratic work about 16x, whatever the machine's speed or load. The ratio is
 * measured up to three times and the smallest is kept, stopping at the first one under
 * GROWTH_BOUND: on a busy machine one noisy measurement can push a single ratio over the bound,
 * but the noise does not repeat three times, while a real super-linear change measures about 16x
 * on every attempt and still fails. `largeMs` is the larger size's CPU ms per call from the first
 * attempt.
 */
export function growth4x<T>(
  make: (size: number) => T,
  n: number,
  fn: (input: T) => unknown,
): { ratio: number; largeMs: number; label: string } {
  const small = make(n);
  const large = make(4 * n);
  let reps = 1;
  fn(small);
  for (;;) {
    const c0 = process.cpuUsage();
    for (let i = 0; i < reps; i++) fn(small);
    const d = process.cpuUsage(c0);
    if ((d.user + d.system) / 1000 >= 40 || reps >= 1_000_000) break;
    reps *= 2;
  }
  let ratio = Infinity;
  let largeMs = NaN;
  let label = "";
  for (let attempt = 1; attempt <= 3 && ratio >= GROWTH_BOUND; attempt++) {
    const a = cpuMsPerCall(() => fn(small), reps);
    const b = cpuMsPerCall(() => fn(large), reps);
    if (attempt === 1) largeMs = b;
    if (b / a < ratio) {
      ratio = b / a;
      label = `${b.toFixed(3)} ms / ${a.toFixed(3)} ms per call, ${reps} calls per run, attempt ${attempt}`;
    }
  }
  return { ratio, largeMs, label };
}
