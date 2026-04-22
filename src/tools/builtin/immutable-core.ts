/**
 * Immutable Core — SG3 safeguard.
 *
 * Files that CANNOT be modified by Jarvis under ANY circumstances,
 * even on jarvis/* branches. These are the nervous system of the agent.
 *
 * Checked in all write paths: file_write, file_edit, file_delete, shell_exec.
 */

import { resolve } from "path";
import { realpathSync } from "fs";

const MC_ROOT = "/root/claude/mission-control/";

/** Exact file paths (relative to mission-control root). */
const IMMUTABLE_FILES: string[] = [
  "src/index.ts",
  "src/config.ts",
  "src/inference/adapter.ts",
  "src/dispatch/dispatcher.ts",
  "src/dispatch/classifier.ts",
  "src/runners/fast-runner.ts",
  "src/messaging/router.ts",
  "src/db/index.ts",
  "src/db/jarvis-fs.ts",
  "src/rituals/scheduler.ts",
  "src/rituals/autonomous-improvement.ts",
  "src/tools/builtin/immutable-core.ts", // self-protection
  "src/tools/builtin/file.ts", // write guard
  "src/tools/builtin/code-editing.ts", // edit guard
  "src/tools/builtin/shell.ts", // shell guard
];

/** Directory prefixes (relative to mission-control root) — all files under these are immutable. */
const IMMUTABLE_PREFIXES: string[] = ["src/api/"];

/**
 * Check if an absolute path is in the immutable core.
 * Returns { immutable: false } or { immutable: true, reason: string }.
 * Resolves the path for defense-in-depth — callers don't need to normalize.
 */
export function isImmutableCorePath(absolutePath: string): {
  immutable: boolean;
  reason?: string;
} {
  const resolved = resolve(absolutePath);
  if (!resolved.startsWith(MC_ROOT)) return { immutable: false };
  const rel = resolved.slice(MC_ROOT.length);

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

// ---------------------------------------------------------------------------
// Path Safety Pipeline — ported from Claude Code's validatePath()
// ---------------------------------------------------------------------------

/**
 * Sensitive dotfiles that should never be auto-edited by Jarvis.
 * Matches Claude Code's DANGEROUS_FILES list.
 */
const DANGEROUS_FILES_EXACT = new Set([
  ".gitconfig",
  ".gitmodules",
  ".bashrc",
  ".bash_profile",
  ".zshrc",
  ".zprofile",
  ".profile",
  ".npmrc", // npm auth tokens
  ".netrc", // credentials for curl/git
]);

/** Prefix patterns — any file starting with these is dangerous. */
const DANGEROUS_FILE_PREFIXES = [".env"]; // .env, .env.local, .env.production, .env.*, etc.

/** Directories whose contents should not be auto-edited. */
const DANGEROUS_DIRECTORIES = [".git/", ".ssh/", ".gnupg/"];

/**
 * Read-blocked paths (full or prefix match) — hard stop on the *read* path.
 *
 * Sec2 round-1 fix (docs/audit/2026-04-22-security.md): file_read was
 * previously unguarded; even if callers used validatePathSafety(..., "read"),
 * sensitive files fell through because DANGEROUS_FILES and DANGEROUS_DIRECTORIES
 * were only checked for write/delete. An LLM could read `.credentials.json`,
 * `/etc/shadow`, Supabase secrets, etc.
 *
 * Entries are checked against the resolved absolute path; prefix match with a
 * trailing `/` where directory semantics apply (poka-yoke: plain `/root/.ssh`
 * would match `/root/.ssh-backup`, so use `/root/.ssh/`).
 */
const READ_BLOCKED_PATHS = [
  // Auth/secrets under the operator's home dir
  "/root/.claude/.credentials.json",
  "/root/.config/gh/",
  "/root/.ssh/",
  "/root/.gnupg/",
  "/root/.aws/",
  "/root/.npmrc",
  "/root/.netrc",
  "/root/.gitconfig",
  "/root/.git-credentials",
  // Linux system secrets
  "/etc/shadow",
  "/etc/gshadow",
  "/etc/sudoers",
  "/etc/sudoers.d/",
  "/etc/ssh/",
  "/proc/self/environ",
  "/proc/self/mem",
  // Project-local secret surfaces
  "/root/claude/mission-control/.env",
  "/root/claude/mission-control/data/",
  // Co-located infra secrets on this VPS
  "/opt/supabase/docker/.env",
  "/opt/supabase/volumes/api/kong.yml",
];

/** Filenames that should never be read by tool path regardless of directory. */
const READ_BLOCKED_BASENAMES = new Set([
  ".credentials.json",
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  "id_dsa",
  ".pgpass",
]);

/**
 * Validate a file path for safety before write/delete operations.
 * 6-check pipeline from Claude Code's validatePath():
 *
 * 1. Quote stripping + tilde expansion
 * 2. UNC path block (SMB credential leak prevention)
 * 3. Tilde variant block (~user, ~+, ~-)
 * 4. Shell expansion syntax block ($, %, =) — TOCTOU prevention
 * 5. Glob block for write operations
 * 6. Dangerous file/directory check
 *
 * Returns { safe: true } or { safe: false, reason: string }.
 */
export function validatePathSafety(
  rawPath: string,
  operation: "read" | "write" | "delete",
): { safe: boolean; reason?: string } {
  if (!rawPath || rawPath.trim().length === 0) {
    return { safe: false, reason: "Empty path" };
  }

  // 1. Strip surrounding quotes
  let path = rawPath.trim().replace(/^['"]|['"]$/g, "");

  // 2. UNC path block — prevents SMB credential leaks on Windows/WSL
  if (path.startsWith("\\\\") || path.startsWith("//")) {
    return { safe: false, reason: "UNC/network paths are blocked" };
  }

  // 3. Tilde expansion — expand ~/ to HOME, block ~user variants
  if (path.startsWith("~/")) {
    path = path.replace("~/", `${process.env.HOME ?? "/root"}/`);
  } else if (path.startsWith("~")) {
    return {
      safe: false,
      reason:
        "Tilde expansion variants (~user, ~+, ~-) are blocked — use absolute paths",
    };
  }

  // 4. Shell expansion syntax block — TOCTOU prevention
  // These create gaps between validation time and execution time:
  // $VAR, ${var}, $(cmd) expand at runtime to different paths than validated
  if (/[$]/.test(path)) {
    return {
      safe: false,
      reason:
        "Shell expansion syntax ($) in paths is blocked -- use resolved absolute paths",
    };
  }
  if (path.startsWith("=")) {
    return {
      safe: false,
      reason: "Zsh equals expansion (=cmd) in paths is blocked",
    };
  }

  // 5. Glob patterns in write/delete operations
  if (operation !== "read" && /[*?[\]{}]/.test(path)) {
    return {
      safe: false,
      reason: "Glob patterns in write/delete paths are blocked",
    };
  }

  // 6. Dangerous files and directories
  const basename = path.split("/").pop() ?? "";
  const isDangerousFile =
    DANGEROUS_FILES_EXACT.has(basename) ||
    DANGEROUS_FILE_PREFIXES.some((p) => basename.startsWith(p));
  if (operation !== "read" && isDangerousFile) {
    return {
      safe: false,
      reason: `'${basename}' is a sensitive dotfile -- manual edit required`,
    };
  }
  if (
    operation !== "read" &&
    DANGEROUS_DIRECTORIES.some((d) => path.includes(d))
  ) {
    const matched = DANGEROUS_DIRECTORIES.find((d) => path.includes(d));
    return {
      safe: false,
      reason: `'${matched}' is a protected directory — manual edit required`,
    };
  }

  // 7. Read-path secret denylist — Sec2 round-1 + round-2 fix
  // Block reads of credential-bearing files regardless of whether the caller
  // passed "read", "write", or "delete". This is defense-in-depth for tools
  // whose sole purpose is to read files.
  //
  // Round 2: also realpath-resolve to catch symlink escapes
  // (e.g. `/tmp/a -> /root/.claude/.credentials.json`). We check the
  // denylist BOTH against the path-resolve (handles ../) AND against the
  // realpath (handles symlinks). realpathSync throws ENOENT for paths
  // that don't exist yet — that's fine for read-mode (we only care when
  // the file exists), and for write/delete we only enforce the denylist
  // on post-resolve string match since writes to a new symlink can't
  // follow one.
  const candidates = [resolve(path)];
  if (operation === "read") {
    try {
      const real = realpathSync(candidates[0]!);
      if (real !== candidates[0]) candidates.push(real);
    } catch {
      // File doesn't exist yet or lstat failed; only resolve-check applies.
    }
  }

  for (const probe of candidates) {
    for (const blocked of READ_BLOCKED_PATHS) {
      // Exact-file blocklist: probe === blocked OR probe starts with blocked+"/"
      // (prefix semantics only for entries ending in "/"). Avoids the
      // /root/.ssh-evil matching /root/.ssh class of bug (poka-yoke test).
      if (blocked.endsWith("/")) {
        if (probe.startsWith(blocked)) {
          return {
            safe: false,
            reason: `'${blocked}' is a read-blocked secret directory`,
          };
        }
      } else if (probe === blocked) {
        return {
          safe: false,
          reason: `'${blocked}' is a read-blocked secret file`,
        };
      }
    }
    const probeBase = probe.split("/").pop() ?? "";
    if (READ_BLOCKED_BASENAMES.has(probeBase)) {
      return {
        safe: false,
        reason: `'${probeBase}' is a read-blocked sensitive filename`,
      };
    }
  }

  return { safe: true };
}

/**
 * Check if a path is dangerous to delete (rm/rmdir).
 * Blocks: root, home, direct children of /, glob wildcards.
 * Ported from Claude Code's isDangerousRemovalPath().
 */
export function isDangerousRemovalPath(path: string): {
  dangerous: boolean;
  reason?: string;
} {
  const resolved = resolve(path);

  // Root filesystem
  if (resolved === "/") {
    return { dangerous: true, reason: "Cannot delete root filesystem" };
  }

  // Home directory
  if (resolved === (process.env.HOME ?? "/root")) {
    return { dangerous: true, reason: "Cannot delete home directory" };
  }

  // Glob wildcard in path
  if (/[*?]/.test(resolved)) {
    return {
      dangerous: true,
      reason: "Wildcard deletion is blocked — specify exact paths",
    };
  }

  // Direct children of / (e.g., /usr, /tmp, /var, /etc, /opt)
  const parts = resolved.split("/").filter(Boolean);
  if (parts.length === 1) {
    return {
      dangerous: true,
      reason: `Cannot delete top-level directory /${parts[0]}`,
    };
  }

  return { dangerous: false };
}

// ---------------------------------------------------------------------------
// Precious path protection (v6.2 S5)
// ---------------------------------------------------------------------------

/**
 * Path prefixes for Jarvis KB entries that require user confirmation
 * before deletion. Softer than SG3 immutable core (which hard-blocks) —
 * precious files CAN be deleted, but only after explicit confirmation.
 *
 * Covers: user-created KB content, project docs, research, directives.
 */
const PRECIOUS_JARVIS_PREFIXES = [
  "knowledge/",
  "projects/",
  "NorthStar/",
  "directives/",
  // logs/day-logs/ is the mechanical verbatim interaction log — never
  // deleted, never overwritten by an LLM. The narrative companion lives
  // under logs/day-narratives/ and is freely writable.
  "logs/day-logs/",
];

/**
 * Check if a Jarvis KB path is precious (requires confirmation to delete).
 * Only applies to jarvis:// paths (internal KB), not filesystem paths.
 *
 * Returns { precious: false } or { precious: true, reason: string }.
 */
export function isPreciousPath(jarvisPath: string): {
  precious: boolean;
  reason?: string;
} {
  for (const prefix of PRECIOUS_JARVIS_PREFIXES) {
    if (jarvisPath.startsWith(prefix)) {
      return {
        precious: true,
        reason: `'${prefix}' contains valuable KB content — confirm deletion first`,
      };
    }
  }
  return { precious: false };
}
