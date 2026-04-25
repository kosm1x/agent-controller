/**
 * Shell execution tool with command validation guard.
 *
 * Executes a shell command with timeout, output limits, and safety checks.
 * The guard prevents accidental destructive commands — not an adversarial sandbox.
 */

import { execSync, execFileSync } from "child_process";
import type { Tool } from "../types.js";
import { isImmutableCorePath } from "./immutable-core.js";

const MAX_OUTPUT = 10_000; // chars
const TIMEOUT_MS = 30_000; // 30 seconds

// ---------------------------------------------------------------------------
// Command validation guard
// ---------------------------------------------------------------------------

/** Commands blocked as the base command (first token) of any pipe/chain segment. */
const DENY_COMMANDS = new Set([
  "rm",
  "mkfs",
  "dd",
  "shutdown",
  "reboot",
  "poweroff",
  "halt",
  "kill",
  "killall",
  "pkill",
  "iptables",
  "ip6tables",
  "nft",
  "useradd",
  "userdel",
  "passwd",
  "chown",
  "systemctl",
  "mount",
  "umount",
  "fdisk",
  "parted",
  "crontab",
  "sqlite3", // SG4: all DB access goes through getDatabase() — no raw SQL bypass
]);

/** Patterns checked against the full command string. */
const DENY_PATTERNS: { pattern: RegExp; reason: string }[] = [
  {
    pattern: /rm\s+(-[a-zA-Z]*\s+)*\//,
    reason: "rm with absolute path",
  },
  {
    // Block redirects into system directories. /dev/{null,stderr,stdout}
    // are common discard sinks (e.g. `2>/dev/null`) and are NOT real
    // writes — they discard. Allow only those three; everything else
    // under /dev/ stays blocked (e.g. /dev/sda would be catastrophic).
    // The discard exemption requires a hard terminator (whitespace, end of
    // string, pipe/semicolon/&) so adversarial suffixes like `/dev/null.bak`
    // or `/dev/null/foo` still hit the deny path with a clear reason.
    pattern:
      />\s*\/(?:etc|boot|usr|proc|sys)\/|>\s*\/dev\/(?!(?:null|stderr|stdout)(?:\s|[|;&]|$))/,
    reason: "redirect to system directory",
  },
  {
    pattern: /chmod\s+[67]77/,
    reason: "overly permissive chmod",
  },
  { pattern: /\bmkfs\b/, reason: "filesystem format" },
  { pattern: /\bdd\s+/, reason: "disk destroyer" },
  {
    pattern: /\bgit\s+remote\s+(set-url|add|remove|rename)\b/,
    reason: "git remote modification blocked — use git tools instead",
  },
  {
    pattern: /\bgit\b[^|;&]*\b(push|commit|add)\b/,
    reason:
      "git operations blocked in shell_exec — use git_commit/git_push tools",
  },
  // Sec7 round-2 fix: block reads of credential-bearing files via shell
  // reader commands (cat/head/tail/less/more/xxd/od/strings/awk/sed/grep/nl/
  // file/base64/md5sum/sha256sum). Without this, an LLM could bypass the
  // file_read READ_BLOCKED_PATHS denylist by running
  // `shell_exec("cat /root/.claude/.credentials.json")`.
  {
    pattern:
      /\b(cat|head|tail|less|more|xxd|od|strings|awk|sed|grep|nl|file|base64|md5sum|sha256sum|sha512sum|sha1sum|hexdump|tac|rev)\b[^|;&]*\/root\/\.claude\/\.credentials\.json\b/,
    reason: "read of credentials.json blocked",
  },
  {
    pattern:
      /\b(cat|head|tail|less|more|xxd|od|strings|awk|sed|grep|nl|file|base64|md5sum|sha256sum|sha512sum|sha1sum|hexdump|tac|rev)\b[^|;&]*\/root\/\.ssh\//,
    reason: "read of /root/.ssh/ blocked",
  },
  {
    pattern:
      /\b(cat|head|tail|less|more|xxd|od|strings|awk|sed|grep|nl|file|base64|md5sum|sha256sum|sha512sum|sha1sum|hexdump|tac|rev)\b[^|;&]*\/root\/\.(gnupg|aws|docker|kube|config\/gh)\b/,
    reason: "read of secret dotfile directory blocked",
  },
  {
    pattern:
      /\b(cat|head|tail|less|more|xxd|od|strings|awk|sed|grep|nl|file|base64|md5sum|sha256sum|sha512sum|sha1sum|hexdump|tac|rev)\b[^|;&]*\/etc\/(shadow|gshadow|sudoers|ssh)\b/,
    reason: "read of system secret blocked",
  },
  {
    pattern:
      /\b(cat|head|tail|less|more|xxd|od|strings|awk|sed|grep|nl|file|base64|md5sum|sha256sum|sha512sum|sha1sum|hexdump|tac|rev)\b[^|;&]*\/proc\/self\/(environ|mem)\b/,
    reason: "read of /proc/self/environ or mem blocked",
  },
  {
    pattern:
      /\b(cat|head|tail|less|more|xxd|od|strings|awk|sed|grep|nl|file|base64|md5sum|sha256sum|sha512sum|sha1sum|hexdump|tac|rev)\b[^|;&]*\/root\/(\.npmrc|\.netrc|\.pgpass|\.gitconfig|\.git-credentials)\b/,
    reason: "read of dotfile credential blocked",
  },
];

/** Safe path prefixes for write operations.
 *  Jarvis can read anything but writes are restricted to project dirs.
 *  /root/claude/mission-control/ is OFF LIMITS unless on a jarvis/* branch. */
const ALLOW_WRITE_PREFIXES = [
  "/root/claude/jarvis-kb/",
  "/root/claude/cuatro-flor/",
  "/root/claude/projects/",
  "/root/claude/williams-entry-radar/", // Jarvis's autonomous radar build
  "/root/claude/mission-control/", // allowed only on jarvis/* branches — checked dynamically
  "/tmp/",
  "/workspace/",
];

/** Standard /dev/null sinks used as discard targets in shell idioms.
 *  These match WRITE_INDICATORS' shape (`>` redirect to absolute path) but
 *  are not actual writes — they discard. Exempting them here prevents
 *  false-positive blocks on `2>/dev/null`, `&>/dev/null`, `>/dev/null`. */
const WRITE_INDICATOR_EXEMPT = new Set([
  "/dev/null",
  "/dev/stderr",
  "/dev/stdout",
]);

function isMissionControlWriteAllowed(): boolean {
  try {
    const branch = execFileSync("git", ["branch", "--show-current"], {
      cwd: "/root/claude/mission-control",
      timeout: 5000,
      encoding: "utf-8",
    }).trim();
    return /^jarvis\/(feat|fix|refactor)\/.+$/.test(branch);
  } catch {
    return false;
  }
}

/** Docs files Jarvis can write on main branch (operational logs, not source code). */
const RITUAL_WRITABLE_DOCS = ["docs/EVOLUTION-LOG.md"];

const DENY_WRITE_PATTERNS: { pattern: RegExp; reason: string }[] = [
  {
    pattern: /\/root\/claude\/mission-control\//,
    reason: "Jarvis cannot modify its own source code via shell_exec",
    // Dynamic override: allowed on jarvis/* branches (checked at runtime)
  } as { pattern: RegExp; reason: string },
];

/** Heuristic tokens that indicate a write to a path. */
const WRITE_INDICATORS =
  /(?:>\s*|>>\s*|tee\s+|mv\s+\S+\s+|cp\s+\S+\s+)(\/[^\s]+)/g;

/** Count unescaped `"` chars in `s` (for quote-context detection).
 *  Skips over the contents of single-quoted strings — bash single quotes do
 *  not interpolate, so a `"` inside `'…'` does not change quote state. */
function countOpenDoubleQuotes(s: string): number {
  let dq = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const prev = i > 0 ? s[i - 1] : "";
    if (c === "'" && prev !== "\\") {
      // Skip to matching closing single quote (no nesting / escaping in '...')
      const close = s.indexOf("'", i + 1);
      if (close === -1) break;
      i = close;
      continue;
    }
    if (c === '"' && prev !== "\\") dq++;
  }
  return dq;
}

/** Strip body of quoted heredocs (`<<'EOF'` / `<<"EOF"`) before validation.
 *  Bash treats quoted-delimiter heredoc bodies as literal text — no variable
 *  expansion, no command substitution — so the body is opaque data piped to
 *  the receiving process. Scanning it for shell metacharacters produces false
 *  positives on every JS/TS/JSON/Python file Jarvis writes via `cat > path
 *  << 'EOF' ... EOF`. The first-line redirect stays intact so WRITE_INDICATORS
 *  still catches the target path. Unquoted heredocs (`<< EOF`) DO expand vars
 *  and command-subs, so we deliberately do not strip those.
 *
 *  Quote-context guard (audit Critical): `<<'X'…X` *inside* a double-quoted
 *  string is NOT a heredoc to bash — it's literal text. `$(...)` and `` ` ``
 *  inside that same double-quoted string DO expand. Stripping there would
 *  hide an active substitution from the validator while bash still executes
 *  it. We count unescaped `"` before each candidate match: odd count means
 *  we're inside an open `"…"` string and must NOT strip.
 *
 *  `<<-` variant (Major fix): permits a tab-indented closer (`\n\t*EOF`).
 *  Plain `<<` requires the closer at column 0 (`\nEOF`).
 *
 *  Delimiter charset (Major fix): bash allows hyphens, digits, dots, etc.
 *  in the delimiter — match `[^'"\s]+` instead of `\w+`.
 */
function stripQuotedHeredocs(command: string): string {
  // Two passes: <<- first (tab-indented closer permitted), then plain <<.
  // The non-greedy body match in pass 1 is bounded by the FIRST `\n\t*\1`
  // sequence; pass 2 only matches `<<` (excluding `<<-` already handled).
  const replaceWithQuoteGuard = (input: string, re: RegExp): string =>
    input.replace(re, (match: string, _delim: string, offset: number) => {
      const before = input.slice(0, offset);
      if (countOpenDoubleQuotes(before) % 2 === 1) {
        // Inside open "…" — bash sees this as text, not a heredoc.
        return match;
      }
      return "<<HEREDOC_STRIPPED";
    });

  let out = replaceWithQuoteGuard(
    command,
    /<<-\s*['"]([^'"\s]+)['"][\s\S]*?\n\t*\1(?=\s|$)/g,
  );
  out = replaceWithQuoteGuard(
    out,
    /<<(?!-)\s*['"]([^'"\s]+)['"][\s\S]*?\n\1(?=\s|$)/g,
  );
  return out;
}

/**
 * Validate a shell command before execution.
 * Returns { allowed: true } or { allowed: false, reason }.
 */
export function validateShellCommand(command: string): {
  allowed: boolean;
  reason?: string;
} {
  // Strip quoted-heredoc bodies — they are literal data, not shell syntax,
  // so scanning them for `>(`, backticks, etc. produces false positives.
  const sanitized = stripQuotedHeredocs(command);

  // Block command substitution — can hide any command inside otherwise-safe ones
  if (/\$\((?!\()/.test(sanitized)) {
    // $( but not $(( — allow arithmetic expansion $((expr))
    return { allowed: false, reason: "command substitution $(...) is blocked" };
  }
  // Block process substitution <() and >() — same class as $().
  // Require a separator (start, whitespace, pipe, semi, ampersand) before
  // the `<`/`>` so we don't false-positive on JS arrow `=>(` or TS generics
  // like `new Map<T>()`. Bash process-sub is always preceded by a separator
  // (`cmd <(...)`, `cmd >(tee)`); the `cat<(...)` no-space form is rare and
  // not worth blocking JS/TS scripts inside `node -e`/heredocs to catch.
  if (/(?:^|[\s|;&])[<>]\(/.test(sanitized)) {
    return {
      allowed: false,
      reason: "process substitution <() or >() is blocked",
    };
  }
  if (/`/.test(sanitized)) {
    return { allowed: false, reason: "backtick substitution is blocked" };
  }
  if (
    /\$\{[^}]*\b(cat|rm|curl|wget|nc|python|node|bash|sh|eval|exec)\b/.test(
      sanitized,
    )
  ) {
    return {
      allowed: false,
      reason: "variable expansion with dangerous command",
    };
  }

  // Split on shell separators to check each segment
  const segments = sanitized.split(/\s*(?:\||\|\||&&|;)\s*/);

  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed) continue;

    // Extract base command (first token), strip any path prefix
    const firstToken = trimmed.split(/\s/)[0];
    const baseName = firstToken.replace(/^.*\//, ""); // /usr/bin/rm → rm

    if (DENY_COMMANDS.has(baseName)) {
      return { allowed: false, reason: `command '${baseName}' is blocked` };
    }
  }

  // Check full command against deny patterns (against sanitized form so
  // heredoc body content doesn't trip a credential-reader pattern by
  // appearing inside, e.g., a JSON literal being piped to a file)
  for (const { pattern, reason } of DENY_PATTERNS) {
    if (pattern.test(sanitized)) {
      return { allowed: false, reason };
    }
  }

  // Check write paths — if command writes to absolute paths, verify they're safe.
  // Use `sanitized` so the only `>` redirect we see is the heredoc opener's
  // redirect, not arrow functions or template-literal characters in the body.
  let match: RegExpExecArray | null;
  WRITE_INDICATORS.lastIndex = 0;
  while ((match = WRITE_INDICATORS.exec(sanitized)) !== null) {
    const targetPath = match[1];
    // Discard sinks (/dev/null, /dev/stderr, /dev/stdout) match the same
    // `>` redirect shape but are not real writes — exempt them so common
    // idioms like `2>/dev/null` don't false-positive.
    if (WRITE_INDICATOR_EXEMPT.has(targetPath)) continue;
    // SG3: Immutable core — blocked even on jarvis/* branches
    if (isImmutableCorePath(targetPath).immutable) {
      return {
        allowed: false,
        reason: `write to immutable core file blocked: ${targetPath}`,
      };
    }
    // Check deny list first (mission-control is protected unless on jarvis/* branch)
    for (const deny of DENY_WRITE_PATTERNS) {
      if (deny.pattern.test(targetPath)) {
        // Dynamic override for mission-control on jarvis/* branches
        if (
          targetPath.includes("/mission-control/") &&
          isMissionControlWriteAllowed()
        ) {
          continue;
        }
        // Narrow exception: ritual-writable docs (operational logs, not source)
        if (targetPath.includes("/mission-control/")) {
          const rel = targetPath.replace(/.*\/mission-control\//, "");
          if (RITUAL_WRITABLE_DOCS.includes(rel)) {
            continue;
          }
        }
        return { allowed: false, reason: deny.reason };
      }
    }
    const isSafe = ALLOW_WRITE_PREFIXES.some((prefix) =>
      targetPath.startsWith(prefix),
    );
    if (!isSafe) {
      return {
        allowed: false,
        reason: `write to '${targetPath}' outside allowed paths`,
      };
    }
  }

  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const shellTool: Tool = {
  name: "shell_exec",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "shell_exec",
      description: `Execute a shell command and return its output. Use for running system queries, scripts, or CLI tools.

USE WHEN:
- Running build commands (npm test, npx tsc, python scripts)
- System queries (ls, df, cat, which, dpkg)
- Project-specific CLI tools

DO NOT USE for:
- Git operations → use git_status, git_commit, git_push instead
- Reading files → use file_read instead
- Writing KB files → use jarvis_file_write instead
- Modifying /root/claude/mission-control/ → BLOCKED (your own source)

RESTRICTIONS:
- Destructive commands blocked (rm, mkfs, dd, kill, shutdown, systemctl)
- File writes restricted to project dirs (/root/claude/, /tmp/, /workspace/)
- System directories blocked (/etc, /boot, /usr, /proc, /sys, /dev)
- Max 60 seconds, max 10,000 chars output.`,
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to execute",
          },
          timeout_ms: {
            type: "number",
            description: `Timeout in milliseconds (default: ${TIMEOUT_MS}, max: 60000)`,
          },
        },
        required: ["command"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const command = args.command as string;
    if (!command) {
      return JSON.stringify({ error: "command is required" });
    }

    // Validate command before execution
    const validation = validateShellCommand(command);
    if (!validation.allowed) {
      console.log(`[shell-guard] BLOCKED: ${command}`);
      return JSON.stringify({
        error: `Command blocked by security policy: ${validation.reason}`,
      });
    }
    console.log(
      `[shell-guard] OK: ${command.length > 120 ? command.slice(0, 120) + "..." : command}`,
    );

    const timeout = Math.min(
      typeof args.timeout_ms === "number" ? args.timeout_ms : TIMEOUT_MS,
      60_000,
    );

    try {
      const output = execSync(command, {
        timeout,
        maxBuffer: 1024 * 1024, // 1MB
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });

      const trimmed =
        output.length > MAX_OUTPUT
          ? output.slice(0, MAX_OUTPUT) +
            `\n... (truncated, ${output.length} total chars)`
          : output;

      return JSON.stringify({ stdout: trimmed, exit_code: 0 });
    } catch (err: unknown) {
      const error = err as {
        status?: number;
        stdout?: string;
        stderr?: string;
        message?: string;
      };
      return JSON.stringify({
        exit_code: error.status ?? 1,
        stdout: (error.stdout ?? "").slice(0, MAX_OUTPUT),
        stderr: (error.stderr ?? error.message ?? "").slice(0, MAX_OUTPUT),
      });
    }
  },
};
