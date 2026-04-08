/**
 * Timeout utility — wraps a promise with a deadline that cleans up properly.
 *
 * Unlike the raw Promise.race + setTimeout pattern, this:
 * 1. Clears the timer when the promise resolves (no leak)
 * 2. Returns a typed result
 * 3. Throws a consistent error message
 *
 * Extracted after the same timer-leak pattern appeared in 3+ files
 * (scope-classifier, prompt-enhancer, correction-loop).
 */

/**
 * Race a promise against a timeout. Clears timer on resolution.
 * @throws Error with `${label} timeout` message if deadline exceeded.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label = "operation",
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout`)), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer!);
  }
}
