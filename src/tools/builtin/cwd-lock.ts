/**
 * Per-cwd async mutex for the git tools (queue 4ao ruling (f)(ii), 2026-10-27).
 *
 * Since the git/gh children went async (4a297dbe), a multi-step sequence on one
 * worktree (git_push fetch→rebase→push, jarvis_dev pr add→commit→push) is no
 * longer atomic within the process: two tool calls on the same cwd could
 * interleave their children. Each call now chains behind the previous one for
 * the same cwd; different cwds still run in parallel.
 */

import { stat } from "fs/promises";
import { dirname, join } from "path";

const tails = new Map<string, Promise<unknown>>();

/** Run `fn` after every earlier call for the same cwd has settled. */
export async function withCwdLock<T>(
  cwd: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = cwd.replace(/\/+$/, "") || "/";
  const run = (tails.get(key) ?? Promise.resolve()).then(fn);
  // The stored tail never rejects, so one failed call cannot wedge the chain.
  const tail = run.catch(() => undefined);
  tails.set(key, tail);
  try {
    return await run;
  } finally {
    if (tails.get(key) === tail) tails.delete(key);
  }
}

/** @internal test-only: keys with a call still queued or running. */
export function cwdLockKeyCount(): number {
  return tails.size;
}

/**
 * The lock key for an already-realpath'd cwd: the nearest ancestor holding
 * `.git` (a directory, or a linked worktree's pointer file), so `<repo>/src`
 * and `<repo>` share one lock (qa R1 W2). Falls back to the cwd itself when
 * no ancestor is a repository. Async fs only — no git spawn.
 */
export async function repoRootOf(resolved: string): Promise<string> {
  for (let dir = resolved; ; dir = dirname(dir)) {
    try {
      await stat(join(dir, ".git"));
      return dir;
    } catch {
      // Not a repository root — keep walking up.
    }
    if (dirname(dir) === dir) return resolved;
  }
}
