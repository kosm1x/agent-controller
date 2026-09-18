/**
 * One throwaway KB mirror per vitest run (2026-09-18).
 *
 * `getMirrorDir()` in src/db/jarvis-fs.ts refuses the live KB under vitest.
 * Without a shared root it falls back to one dir per worker fork, and with
 * `pool: "forks"` that is one dir per test FILE (89 per full run, never
 * cleaned). This setup runs once in the main process, hands the workers a
 * single dir through the environment, and removes it at teardown.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default function setup(): () => void {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-kb-vitest-"));
  process.env.JARVIS_KB_VITEST_FALLBACK = dir;
  return () => {
    rmSync(dir, { recursive: true, force: true });
  };
}
