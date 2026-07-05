/**
 * Shell execution tool with command validation guard.
 *
 * Executes a shell command with timeout, output limits, and safety checks.
 * The guard prevents accidental destructive commands — not an adversarial sandbox.
 */

import { exec, execFileSync } from "child_process";
import { promisify } from "util";
import type { Tool } from "../types.js";
import { isImmutableCorePath } from "./immutable-core.js";
import { getJarvisKbRoot } from "../../db/jarvis-fs.js";
import { realResolve, isOperatorConfigPath } from "./write-guard.js";
import {
  buildFlailingBlockMessage,
  checkFlailing,
  recordCall,
} from "../flailing-guard.js";
import { redactSecrets } from "../../api/mcp-server/redact.js";

/**
 * Async command runner. Uses child_process.exec (not execSync) so it does NOT
 * block the Node event loop while a command runs. Critical for in-process
 * runners (fast/ritual): a synchronous exec would freeze the loopback HTTP
 * server for the command's full duration — which historically made any
 * in-process `curl http://localhost:8080/...` self-deadlock and return HTTP 000.
 */
const execAsync = promisify(exec);

const MAX_OUTPUT = 10_000; // chars
const TIMEOUT_MS = 30_000; // 30 seconds — default for general commands
const MAX_TIMEOUT_MS = 60_000; // cap for general commands (runaway protection)

// Database CLI ops (TRUNCATE / COPY / migrations on large tables) legitimately
// run far longer than a general command — a 2M-row `TRUNCATE … CASCADE` blew the
// 30s default, its docker-exec retries then tripped the flailing guard, and the
// seed dead-ended (MiniSu, 2026-06-28). Detected DB commands get a much larger
// default + cap so they aren't killed mid-statement. Detection only RAISES the
// allowed timeout, so a false positive is harmless.
const DB_TIMEOUT_MS = 120_000; // 2 min — default for detected DB ops
const DB_MAX_TIMEOUT_MS = 300_000; // 5 min — cap for detected DB ops
const DB_OP_PATTERN =
  /\b(psql|pg_dump|pg_dumpall|pg_restore|mysql|mysqldump|mariadb)\b/i;

/**
 * A command that invokes a DB CLI (psql / pg_* / mysql*), including via
 * `docker exec <container> psql …`. These run long on large tables, so they get
 * the larger DB timeout budget instead of the tight general cap.
 */
export function isDbOp(command: string): boolean {
  return DB_OP_PATTERN.test(command);
}

/**
 * Resolve the exec timeout (ms) for a command. DB ops get a larger default and
 * ceiling than general commands; the agent may override via `timeout_ms` up to
 * that ceiling. A non-positive or non-numeric `timeout_ms` falls back to the
 * default — never to 0, which Node's `exec` treats as "no timeout" and would
 * bypass the ceiling into UNBOUNDED execution. So the cap is a real hard cap.
 */
export function resolveShellTimeout(
  command: string,
  timeoutMsArg: unknown,
): number {
  const dbOp = isDbOp(command);
  const def = dbOp ? DB_TIMEOUT_MS : TIMEOUT_MS;
  const max = dbOp ? DB_MAX_TIMEOUT_MS : MAX_TIMEOUT_MS;
  const requested =
    typeof timeoutMsArg === "number" && timeoutMsArg > 0 ? timeoutMsArg : def;
  return Math.min(requested, max);
}

// ---------------------------------------------------------------------------
// Child-process env scrubbing (H1)
// ---------------------------------------------------------------------------

/**
 * Substrings that mark a process.env key as secret-bearing (case-insensitive).
 * execAsync would otherwise hand the shell_exec child mission-control's FULL
 * process.env (~25 credentials: MC_API_KEY, INFERENCE_* keys, the Google
 * refresh token, GH + Telegram tokens, the X/Twitter cookies, …), so a bare
 * `env` / `printenv` / `echo $MC_API_KEY` inside a command would exfiltrate
 * every one. We hand the child a scrubbed copy that DELETES these keys.
 * Defense-in-depth: an owner task steered by injected web content cannot lift
 * secrets it cannot see. Non-secret vars (PATH/HOME/LANG/TZ/USER/…) carry no
 * keyword and survive, so commands still resolve binaries and run normally.
 */
const SECRET_ENV_KEYWORDS = [
  "KEY",
  "TOKEN",
  "SECRET",
  "PASSWORD",
  "PASSWD",
  "PWD",
  "CREDENTIAL",
  "JWT",
  "APIKEY",
  "AUTH",
];

/**
 * Env-key prefixes that hold a credential but contain none of the keywords
 * above — the Twitter CSRF cookies `X_CT0__<account>`. Matched as startsWith.
 */
const SECRET_ENV_PREFIXES = ["X_CT0"];

/** True if the env var NAME looks like it holds a credential. */
export function isSecretEnvKey(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    SECRET_ENV_KEYWORDS.some((kw) => upper.includes(kw)) ||
    SECRET_ENV_PREFIXES.some((p) => upper.startsWith(p))
  );
}

/**
 * A copy of process.env with every secret-looking key removed, for handing to
 * the shell_exec child so it can't read mission-control's credentials.
 */
export function buildScrubbedEnv(): NodeJS.ProcessEnv {
  const scrubbed: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(scrubbed)) {
    if (isSecretEnvKey(key)) delete scrubbed[key];
  }
  return scrubbed;
}

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
  {
    // Block reads of mission-control's OWN .env (the crown jewels: Telegram bot
    // token, Anthropic keys) via shell reader commands. Nothing legitimate reads
    // it through the shell — code reads process.env. Without this, an LLM bypasses
    // the env sandbox: the overnight-tuning agent ran
    // `grep TELEGRAM_BOT_TOKEN /root/claude/mission-control/.env` to lift the bot
    // token and shell out a raw Telegram send (2026-06-20).
    // Scope is deliberately mission-control's .env ONLY — project .envs are lower-
    // stakes AND have documented legit reads (the DENUE analyzer's API key lives in
    // /root/claude/projects/.../denue-data-analysis/.env and fast-runner.ts tells
    // the agent to grep it). A blanket .env block would break authenticated DENUE
    // queries. Order-independent lookaheads (NOT an adjacent `[^|;&]*` span) because
    // a grep alternation arg ("A\|B") contains a `|` that truncates an adjacent
    // match before the path. `.env.<suffix>` is covered; `.environment` is not.
    pattern:
      /(?=[\s\S]*\b(?:cat|head|tail|less|more|xxd|od|strings|awk|sed|grep|nl|file|base64|md5sum|sha256sum|sha512sum|sha1sum|hexdump|tac|rev|cut|tr|paste)\b)(?=[\s\S]*\/root\/claude\/mission-control\/\.env(?:\.[A-Za-z0-9_-]+)?\b)/,
    reason: "read of mission-control .env (secrets) blocked",
  },
];

/** Safe path prefixes for write operations.
 *  Jarvis can read anything but writes are restricted to project dirs.
 *  /root/claude/mission-control/ is OFF LIMITS unless on a jarvis/* branch.
 *  Queue #11 (2026-05-07): jarvis-kb path read dynamically via
 *  getJarvisKbRoot() so JARVIS_KB_MIRROR_DIR overrides flow through tools too. */
function getAllowWritePrefixes(): string[] {
  return [
    `${getJarvisKbRoot()}/`, // may resolve outside /root/claude via JARVIS_KB_MIRROR_DIR
    "/root/claude/", // every EurekaMD/Jarvis project repo lives here; mission-control is
    // still gated by DENY_WRITE_PATTERNS + isImmutableCorePath above (the allow-list is
    // checked LAST), so this does not weaken its source protection. Replaces a per-repo
    // enumeration that silently blocked writes to any repo it forgot.
    "/tmp/",
    "/workspace/",
  ];
}

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
    const rawTarget = match[1];
    // Discard sinks (/dev/null, /dev/stderr, /dev/stdout) match the same
    // `>` redirect shape but are not real writes — exempt them (raw, pre-realpath)
    // so idioms like `2>/dev/null` don't false-positive.
    if (WRITE_INDICATOR_EXEMPT.has(rawTarget)) continue;
    // realpath so an in-domain symlink can't point the write outside the gates.
    // Security decisions below use this resolved path; the ritual-doc append regex
    // further down still matches the RAW target against the original command text.
    const targetPath = realResolve(rawTarget);
    // SG3: Immutable core — blocked even on jarvis/* branches
    if (isImmutableCorePath(targetPath).immutable) {
      return {
        allowed: false,
        reason: `write to immutable core file blocked: ${targetPath}`,
      };
    }
    // Deny-first: the operator's own config (.claude/ settings+hooks, .mcp.json,
    // umbrella CLAUDE.md) lives under /root/claude/ but is not project content —
    // rewriting it is a guardrail/command-execution vector.
    if (isOperatorConfigPath(targetPath)) {
      return {
        allowed: false,
        reason: `write to operator config blocked: ${targetPath}`,
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
        // Narrow exception: ritual-writable docs (operational logs, not source).
        // APPEND-ONLY: the exemption applies only to an append redirect (`>>`).
        // A bare `>`, `tee` (overwrite), `mv`, or `cp` to one of these paths would
        // TRUNCATE the file — these logs are large, irreplaceable longitudinal
        // history (the 2026-06-17 incident truncated the 45 KB EVOLUTION-LOG.md to
        // a single entry via a whole-file write). Keying the exemption on the
        // operator (not just the path) blocks those overwrite redirects here.
        //
        // BEST-EFFORT, NOT AIRTIGHT: this lives inside the WRITE_INDICATORS loop,
        // so truncation primitives that regex doesn't capture still slip past —
        // `>|` clobber, `truncate -s 0`, `sed -i`, and RELATIVE paths (the service
        // cwd is /root/claude/mission-control, so `> docs/EVOLUTION-LOG.md` hits
        // the real log with no absolute match). This is defense-in-depth against
        // the realistic ritual mistake (`>` vs `>>`); durable git persistence is
        // the only real backstop against truncation. See the WRITE_INDICATORS
        // hardening follow-up + memory feedback_evolution_log_truncation.
        if (targetPath.includes("/mission-control/")) {
          const rel = targetPath.replace(/.*\/mission-control\//, "");
          if (RITUAL_WRITABLE_DOCS.includes(rel)) {
            // Match the RAW redirect target against the original command text —
            // targetPath is now the realpath, which may not appear verbatim.
            const p = rawTarget.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const isAppend = new RegExp(`>>\\s*${p}(?:\\s|$)`).test(sanitized);
            const hasOverwrite = new RegExp(
              `(?:^|[^>])>\\s*${p}(?:\\s|$)`,
            ).test(sanitized);
            if (isAppend && !hasOverwrite) {
              continue;
            }
            return {
              allowed: false,
              reason: `${rel} is append-only via shell_exec — use \`cat >> ${rel}\` (the \`>>\` append redirect), not an overwrite (\`>\`, tee, mv, cp)`,
            };
          }
        }
        return { allowed: false, reason: deny.reason };
      }
    }
    const isSafe = getAllowWritePrefixes().some((prefix) =>
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
  // Annotations: shell may do anything — assume worst case for safety.
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
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
- Timeout: 60s max for general commands; 5 min max for database commands
  (psql, pg_dump/restore, mysql/mysqldump — incl. via 'docker exec'), since
  TRUNCATE/COPY/migrations on large tables run long. Max 10,000 chars output.`,
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to execute",
          },
          timeout_ms: {
            type: "number",
            description: `Timeout in milliseconds. General commands: default ${TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}. Database commands (psql/pg_dump/pg_restore/mysql/mysqldump, incl. via 'docker exec'): default ${DB_TIMEOUT_MS}, max ${DB_MAX_TIMEOUT_MS} — set this higher for a long TRUNCATE/COPY/migration on big tables.`,
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
      // Redact before logging: the journal must never hold plaintext keys that
      // an `export FOO_KEY="…"` command carried into shell_exec (H6).
      console.log(`[shell-guard] BLOCKED: ${redactSecrets(command)}`);
      return JSON.stringify({
        error: `Command blocked by security policy: ${validation.reason}`,
      });
    }

    // 3-strike flailing guard: if the last N shell calls sharing a significant
    // token with this command all failed, short-circuit instead of attempting
    // another variation. The LLM's next turn then escalates to the operator.
    const flail = checkFlailing(command);
    if (flail) {
      // Redact both the command and the flailing token before logging (H6).
      const safeCmd = redactSecrets(command);
      console.log(
        `[shell-guard] FLAILING: token="${redactSecrets(flail.token)}" strikes=${flail.strikes} command="${safeCmd.length > 80 ? safeCmd.slice(0, 80) + "..." : safeCmd}"`,
      );
      // Do NOT record the blocked call — it never executed, so it isn't a 4th
      // strike. The history reflects real attempts only.
      return JSON.stringify({
        exit_code: -1,
        stdout: "",
        stderr: buildFlailingBlockMessage(flail.token, flail.strikes),
      });
    }

    // Redact before logging so a secret embedded in the command (e.g.
    // `export GEMINI_API_KEY="…"`) never reaches the journal (H6).
    const safeCmd = redactSecrets(command);
    console.log(
      `[shell-guard] OK: ${safeCmd.length > 120 ? safeCmd.slice(0, 120) + "..." : safeCmd}`,
    );

    const timeout = resolveShellTimeout(command, args.timeout_ms);

    try {
      const { stdout, stderr } = await execAsync(command, {
        timeout,
        maxBuffer: 1024 * 1024, // 1MB
        encoding: "utf-8",
        // H1: hand the child a scrubbed env so `env`/`printenv`/`echo $VAR`
        // can't exfiltrate mission-control's secrets (see buildScrubbedEnv).
        env: buildScrubbedEnv(),
      });

      const trimmed =
        stdout.length > MAX_OUTPUT
          ? stdout.slice(0, MAX_OUTPUT) +
            `\n... (truncated, ${stdout.length} total chars)`
          : stdout;

      recordCall(command, 0);
      const result: { stdout: string; exit_code: number; stderr?: string } = {
        stdout: trimmed,
        exit_code: 0,
      };
      // Surface non-empty stderr even on success — many tools (npm, tsc, git,
      // curl -v) write progress/diagnostics there. Dropping it blinds the agent.
      if (stderr) result.stderr = stderr.slice(0, MAX_OUTPUT);
      return JSON.stringify(result);
    } catch (err: unknown) {
      // promisify(exec) rejects with the exit code on `code` (number) — unlike
      // execSync, which used `status`. Non-numeric `code` (e.g. "ETIMEDOUT",
      // spawn errors) falls back to 1.
      const error = err as {
        code?: number | string;
        status?: number;
        killed?: boolean;
        signal?: string;
        stdout?: string;
        stderr?: string;
        message?: string;
      };

      // Distinguish a timeout kill from an ordinary non-zero exit. exec kills
      // on timeout with killed=true and no numeric exit code; collapsing that
      // to a generic exit_code:1 makes timeouts masquerade as command failures
      // in the longitudinal log. Surface it as exit_code:-2 with a clear note.
      const timedOut = error.killed === true && typeof error.code !== "number";
      const exitCode = timedOut
        ? -2
        : typeof error.code === "number"
          ? error.code
          : (error.status ?? 1);
      recordCall(command, exitCode);

      const baseStderr = error.stderr ?? error.message ?? "";
      const stderr = timedOut
        ? `command timed out after ${timeout}ms (signal ${error.signal ?? "SIGTERM"})\n${baseStderr}`
        : baseStderr;
      return JSON.stringify({
        exit_code: exitCode,
        stdout: (error.stdout ?? "").slice(0, MAX_OUTPUT),
        stderr: stderr.slice(0, MAX_OUTPUT),
      });
    }
  },
};
