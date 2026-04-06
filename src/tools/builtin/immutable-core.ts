/**
 * Immutable Core — SG3 safeguard.
 *
 * Files that CANNOT be modified by Jarvis under ANY circumstances,
 * even on jarvis/* branches. These are the nervous system of the agent.
 *
 * Checked in all write paths: file_write, file_edit, shell_exec.
 */

const MC_ROOT = "/root/claude/mission-control/";

/** Exact file paths (relative to mission-control root). */
const IMMUTABLE_FILES: string[] = [
  "src/index.ts",
  "src/config.ts",
  "src/inference/adapter.ts",
  "src/dispatch/dispatcher.ts",
  "src/runners/fast-runner.ts",
  "src/messaging/router.ts",
  "src/db/index.ts",
  "src/db/jarvis-fs.ts",
  "src/rituals/scheduler.ts",
  "src/tools/builtin/immutable-core.ts", // self-protection
];

/** Directory prefixes (relative to mission-control root) — all files under these are immutable. */
const IMMUTABLE_PREFIXES: string[] = ["src/api/"];

/**
 * Check if an absolute path is in the immutable core.
 * Returns { immutable: false } or { immutable: true, reason: string }.
 */
export function isImmutableCorePath(absolutePath: string): {
  immutable: boolean;
  reason?: string;
} {
  if (!absolutePath.startsWith(MC_ROOT)) return { immutable: false };
  const rel = absolutePath.slice(MC_ROOT.length);

  for (const file of IMMUTABLE_FILES) {
    if (rel === file) {
      return {
        immutable: true,
        reason: `Immutable core file: ${file}`,
      };
    }
  }

  for (const prefix of IMMUTABLE_PREFIXES) {
    if (rel.startsWith(prefix)) {
      return {
        immutable: true,
        reason: `Immutable core directory: ${prefix}`,
      };
    }
  }

  return { immutable: false };
}
