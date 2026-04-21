/**
 * Parallel worker coordinator — hyperframes pattern #3, scoped down.
 *
 * Auto-sizes concurrency from CPU count and free memory, caps at MAX_WORKERS.
 * Used to parallelize the per-scene clip-creation bottleneck in the composer.
 * Each job-level semaphore stays respected by upstream code; this pool is
 * inner-job concurrency only.
 */

import os from "os";

/** Hard cap on inner-job workers. VPS budget is 8GB total; ffmpeg peaks ~2GB. */
const MAX_WORKERS = 4;
/** Fraction of CPU cores used by default (leaves headroom for HTTP, DB, etc.) */
const CPU_FRACTION = 0.5;
/** Estimated memory per worker (ffmpeg encoding ~500MB typical, ~2GB peak). */
const MEMORY_PER_WORKER_MB = 512;

export interface WorkerPoolOptions {
  /** Explicit override. When set, bypasses auto-sizing. */
  maxConcurrency?: number;
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
}

/**
 * Auto-size concurrency based on CPU + free memory. Pure function so callers
 * can reason about how many workers the pool will use.
 */
export function computePoolSize(
  cpuCount: number = os.cpus().length,
  freeMemMb: number = Math.round(os.freemem() / 1024 / 1024),
  maxWorkers: number = MAX_WORKERS,
): number {
  const byCpu = Math.max(1, Math.floor(cpuCount * CPU_FRACTION));
  const byMem = Math.max(1, Math.floor(freeMemMb / MEMORY_PER_WORKER_MB));
  return Math.max(1, Math.min(maxWorkers, byCpu, byMem));
}

export interface WorkerError<T> {
  task: T;
  error: Error;
  index: number;
}

export interface RunResult<R, T> {
  results: (R | undefined)[];
  errors: WorkerError<T>[];
  cancelled: boolean;
}

/**
 * Run `tasks` through `fn` with bounded concurrency. Returns results in
 * input-order (errors are captured as WorkerError entries and the corresponding
 * result slot is `undefined`).
 *
 * If `signal` aborts mid-run, in-flight workers complete but queued tasks
 * are skipped and `cancelled=true` is returned.
 *
 * Errors in one worker do NOT kill the pool — other workers continue, giving
 * callers complete visibility into which tasks failed.
 */
export async function runPool<T, R>(
  tasks: readonly T[],
  fn: (task: T, index: number) => Promise<R>,
  opts: WorkerPoolOptions = {},
): Promise<RunResult<R, T>> {
  const concurrency = Math.max(1, opts.maxConcurrency ?? computePoolSize());
  const results: (R | undefined)[] = new Array(tasks.length).fill(undefined);
  const errors: WorkerError<T>[] = [];
  let cancelled = false;
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      if (opts.signal?.aborted) {
        cancelled = true;
        return;
      }
      const i = nextIndex++;
      if (i >= tasks.length) return;
      try {
        results[i] = await fn(tasks[i], i);
      } catch (err) {
        errors.push({
          task: tasks[i],
          error: err instanceof Error ? err : new Error(String(err)),
          index: i,
        });
      }
    }
  }

  const workerCount = Math.min(concurrency, tasks.length);
  if (workerCount === 0) return { results, errors, cancelled };

  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);
  return { results, errors, cancelled };
}
