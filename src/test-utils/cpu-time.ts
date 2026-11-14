/**
 * Test helper, not a test file: processor time per call, for tests that bound
 * how expensive a function is.
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
