/**
 * The KB root path: the default mirror directory and the environment choices
 * that replace it. Its imports are node builtins, so code that needs the root
 * can load it without loading the knowledge-base module.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";

// Mirror to /root/claude/jarvis-kb/ — outside mission-control, in Jarvis's dominium.
// This is readable/writable by Jarvis's file_read/file_write tools.
// Env-overridable so tests can redirect to a temp dir; before this override
// existed, the northstar-sync test suite was leaving 200+ stale `*--new.md`
// fixtures in the live KB, polluting Jarvis's view of his own files.
export const DEFAULT_MIRROR_DIR = "/root/claude/jarvis-kb";
// Under vitest the live KB is NEVER a valid mirror target (2026-09-18):
// router.test.ts exercised appendDayLog without the env override and
// truncated the real MX-date day-log to one fake turn on every full run.
// Tests that need a mirror set JARVIS_KB_MIRROR_DIR; every other test lands
// in one throwaway dir per worker fork instead of the operator's KB. A pure
// path, not mkdtemp: eleven test files partially mock `fs`, and a new fs call
// at resolve time throws inside them (qa R1 C1); mirrorToDisk mkdirs anyway.
function getMirrorDir(): string {
  return explicitMirrorDir(process.env) ?? DEFAULT_MIRROR_DIR;
}

/** The env-chosen mirror dir (override or vitest), else undefined. */
export function explicitMirrorDir(env: NodeJS.ProcessEnv): string | undefined {
  const override = env.JARVIS_KB_MIRROR_DIR;
  if (override !== undefined) return override;
  if (env.VITEST) {
    // vitest.global-setup.ts provides one dir per run and removes it at
    // teardown; the per-fork path is the fallback when a runner skips it.
    return (
      env.JARVIS_KB_VITEST_FALLBACK ??
      join(tmpdir(), `jarvis-kb-vitest-${process.pid}`)
    );
  }
  return undefined;
}

/**
 * Public helper for tools that need the Jarvis KB root path. Picks up
 * JARVIS_KB_MIRROR_DIR overrides at call time (not module load) so tests
 * setting the env in beforeEach take effect. Queue #11, 2026-05-07.
 */
export function getJarvisKbRoot(): string {
  return getMirrorDir();
}
