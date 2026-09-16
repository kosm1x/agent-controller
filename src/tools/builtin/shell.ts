/**
 * Shell execution tool with command validation guard.
 *
 * Executes a shell command with timeout, output limits, and safety checks.
 * The guard prevents accidental destructive commands — not an adversarial sandbox.
 */

import { exec, execFileSync, spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import { promisify } from "util";
import type { Tool } from "../types.js";
import { isImmutableCorePath, isBlockedEnvFile } from "./immutable-core.js";
import { dirname, resolve as resolvePath } from "path";
import { fileURLToPath } from "url";
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
void execAsync; // superseded by execGroupKill (group-kill on timeout); kept for import parity

/**
 * exec-compatible runner that kills the ENTIRE process group on timeout.
 *
 * Why: `promisify(exec)`'s timeout SIGTERMs only the direct child (the
 * shell). Grandchildren survive — 2026-07-12 incident: Jarvis ran
 * `timeout 90 npx vitest run` repeatedly; each timeout killed the parent
 * and ORPHANED the vitest worker pool. 13 stacked node workers, 8.3 GB
 * RAM, load 10+, event loop starved → operator saw "Jarvis stopped
 * completely". `detached: true` makes the child a group leader so
 * `kill(-pid)` reaps every descendant.
 *
 * Error shape mirrors promisify(exec) where the caller depends on it:
 * numeric `code` for non-zero exits, `killed: true` + non-numeric code on
 * timeout, `stdout`/`stderr` accumulated either way. Output caps at
 * maxBuffer by truncation (exec would reject; truncation is kinder to the
 * agent and the incident class here is runaway output, not protocol).
 */
function execGroupKill(
  command: string,
  opts: { timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", command], {
      detached: true,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let killedByTimeout = false;

    const append = (buf: string, chunk: Buffer): string =>
      buf.length >= opts.maxBuffer
        ? buf
        : buf + chunk.toString("utf-8").slice(0, opts.maxBuffer - buf.length);

    child.stdout.on("data", (c: Buffer) => (stdout = append(stdout, c)));
    child.stderr.on("data", (c: Buffer) => (stderr = append(stderr, c)));

    const killGroup = (): void => {
      killedByTimeout = true;
      try {
        process.kill(-child.pid!, "SIGKILL"); // negative pid = whole group
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    };
    const timer = setTimeout(killGroup, opts.timeout);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(Object.assign(err, { stdout, stderr }));
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (killedByTimeout) {
        reject(
          Object.assign(new Error(`timed out after ${opts.timeout}ms`), {
            killed: true,
            signal: signal ?? "SIGKILL",
            stdout,
            stderr,
          }),
        );
      } else if (code !== 0) {
        reject(
          Object.assign(new Error(`exit ${code}`), {
            code: code ?? 1,
            signal,
            stdout,
            stderr,
          }),
        );
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

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

/**
 * Package-manager PATH shim (dependency trust audit 2026-09-16). The directory
 * ships next to this module in src/ and dist/ (build copies it), and in the
 * sandbox through the read-only dist mount. Every package-manager name in it is
 * a symlink to pm-shim.sh, which passes read-only verbs to the real binary and
 * refuses installs, registry/auth changes and registry execution — in every
 * shell spelling, because name lookup happens after expansion. The string gate
 * below stays as the second layer for absolute-path literals.
 */
export const PM_SHIM_DIR = resolvePath(dirname(fileURLToPath(import.meta.url)), "pm-shim");

/** PATH with the shim directory first (and nowhere else). */
export function withPmShimPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const rest = (env.PATH ?? "/usr/local/bin:/usr/bin:/bin").split(":").filter((d) => d !== PM_SHIM_DIR);
  return { ...env, PATH: [PM_SHIM_DIR, ...rest].join(":") };
}

/** Fail closed: a dist/ built without the shim must not hand the child install authority. */
export function pmShimMissing(dir: string = PM_SHIM_DIR): string | null {
  return existsSync(resolvePath(dir, "npm"))
    ? null
    : `[pm-shim] missing: ${dir}/npm — the package-manager shim was not built into this tree (run \`npm run build\`); shell_exec refuses to run without it`;
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
  // Destructive equivalents of rm the verb list missed (security audit SEC-11).
  "truncate",
  "shred",
  "unlink",
]);

/**
 * Leading keywords/wrappers and their flags a base-command check must look
 * through: `for … do systemctl …`, `sudo -n systemctl …`, `env -i bash`,
 * `timeout 5 pkill`, `(cd /x && …`. Returns "" when nothing remains.
 * Strictly ADDITIVE to the first-token check (only ever finds more verbs).
 */
const COMMAND_WRAPPERS = new Set([
  "env", "sudo", "nohup", "command", "exec", "time", "timeout", "nice",
  "ionice", "stdbuf", "setsid", "do", "then", "else", "elif", "!",
]);
/** A redirection operator at the start of a token: `2>/dev/null`, `>`, `>|`, `<in`, `2>&1`, `2>&-`, `&>`, `>>log`, `<<<str`, `<>`. */
const REDIRECTION_RE = /^\d*(?:>>?\|?|<<<|<>|<<?|&>>?)(?:&[\d-]*)?/;
/** Tokens a redirection at `i` occupies: 2 when the target is detached (`2> /dev/null`), else 1. */
function redirectionSpan(tokens: string[], i: number): number {
  const op = REDIRECTION_RE.exec(tokens[i]!)![0];
  return op === tokens[i] && !/&[\d-]*$/.test(op) && i + 1 < tokens.length ? 2 : 1;
}
/** Bash splits words on `<` and `>`, not only on whitespace: `cp>/tmp/zz npm zz` is `cp npm zz >/tmp/zz` and
 *  `cat<npm>zz` copies npm. Every tokenizer below sees the operator as its own word, and a named fd (`{fd}>`)
 *  is dropped like a numeric one (qa R13 C13-1). Idempotent, one linear pass. */
function spaceRedirections(text: string): string {
  // The space goes right before the operator: `sqlite3>o` is the word `sqlite3` (qa R14 C14-3 — an earlier
  // `\d*` in the lookahead split its digit off); a digit run is an fd only when it is the whole word
  // (` 2>&1` stays, `cp2>o` is the word `cp2`) — a word starts after whitespace OR a delimiter: `(2>/dev/null rm`
  // and `true;2>/dev/null rm` are fd redirections too (qa R15 C15-1). Lookahead first so the lookbehinds run only at operators.
  return text.replace(/\{\w+\}(?=&?[<>])/g, "").replace(/(?=&>|[<>])(?<=[^\s<>&|])(?<!(?:^|[\s();&|])\d+)/g, " ");
}
/** Shell separators. The `&` of `2>&1`/`>&2`/`&>f` and the `|` of `>|` are not separators — splitting there
 *  put `cp 2>&1 npm zz` in two segments whose second began with `1` (qa R12 C12-1, R13 C13-1). Single
 *  characters, so the first `&` of `&&>f` still separates and `&>f` opens the next segment. */
const SEGMENT_SPLIT_RE = /[\n;]|(?<![<>])\||(?<![<>])&(?!>)/;
export function effectiveBaseCommand(segment: string): string {
  const tokens = spaceRedirections(segment.trim()).replace(/^[({]+\s*/, "").split(/\s+/);
  let i = 0;
  while (i < tokens.length) {
    // A subshell/group can open at any command position and close on the command word itself:
    // `do (rm …` runs rm, `(reboot)` runs reboot (qa R16 W16-2, pre-existing).
    const t = (tokens[i] = tokens[i]!.replace(/^[({]+/, "").replace(/[)}]+$/, ""));
    if (!t) { i++; continue; }
    const base = t.replace(/^.*\//, "");
    if (/^[A-Za-z_]\w*=/.test(t)) { i++; continue; } // VAR=x prefix
    if (REDIRECTION_RE.test(t)) { i += redirectionSpan(tokens, i); continue; } // `2>/dev/null rm …` runs rm (qa R12 C12-1)
    if (COMMAND_WRAPPERS.has(base)) {
      i++;
      // every wrapper: skip its flags and `--`; numeric args for timeout/nice
      while (i < tokens.length && /^(?:-\S*|\d+(?:\.\d+)?[smhd]?)$/.test(tokens[i]!)) i++;
      continue;
    }
    return base;
  }
  return "";
}

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
      />\|?\s*\/(?:etc|boot|usr|proc|sys)\/|>\|?\s*\/dev\/(?!(?:null|stderr|stdout)(?:\s|[|;&]|$))/, // `>|` too (qa R14 C14-4)
    reason: "redirect to system directory",
  },
  {
    pattern: /chmod\s+[67]77/,
    reason: "overly permissive chmod",
  },
  { pattern: /\bmkfs\b/, reason: "filesystem format" },
  { pattern: /\bdd\s+/, reason: "disk destroyer" },
  {
    pattern: /\bgit\s+(?:-C\s+\S+\s+)?remote\s+(set-url|add|remove|rename)\b/,
    reason:
      "git remote modification blocked — use gh_repo_create(cwd) for a new repo or git_push(remote) for an existing one",
  },
  {
    pattern: /\bgit\b[^|;&]*\b(push|commit|add)\b/,
    reason:
      "git operations blocked in shell_exec — use git_commit/git_push tools",
  },
  // Destructive rm-equivalents via find (SEC-11).
  {
    pattern: /\bfind\b[^|;&]*\s-(?:delete|exec(?:dir)?\s+(?:rm|shred|unlink|truncate)\b)/,
    reason: "find -delete / -exec rm is blocked",
  },
];

/**
 * Secret-bearing paths: any command text that NAMES one is refused, whatever
 * the verb (security audit SEC-01, 2026-09-10). The former rules keyed on a
 * list of reader commands (cat/head/…), which any interpreter
 * (`python3 -c "open(...)"`), unlisted coreutil (`sort`, `cp`, `install`),
 * redirect (`done < …`) or uploader (`curl --data-binary @…`) walked around.
 * Matched against the command with quotes removed and `~`/`$HOME` expanded,
 * so `"/root/.ssh"/id_rsa` and `$HOME/.ssh/id_rsa` are the same spelling.
 *
 * Deliberately TEXT-shaped and absolute-path only. Deferred (documented
 * false NEGATIVES — HEAD allowed them too): relative spellings after `cd`
 * and `..`-headed paths, `$VAR` indirection, globs/brace expansion, a bare
 * `.env` inside an interpreter-fed heredoc, `.env_prod`-style names, and
 * recursive read-outs / archives that never NAME the secret (`grep -rn KEY
 * <dir>`, `tar czf … <dir>`, `rsync`, `ls -R`) — those belong to the
 * sandbox/allow-list layers. Three audit rounds showed a token/cwd pipeline
 * does not converge; the residual class needs a shell-word normal form
 * (queued 2026-09-10). The wrapper list in effectiveBaseCommand is
 * non-exhaustive by design (verb/flag lists never converge).
 *
 * Accepted false POSITIVES (a one-line workaround exists for each): a bare
 * `.env` mentioned as text in mission-control's cwd (`jq '.env'`, `echo 'set
 * .env'`, `cp x/.env.example x/.env`) and a secret DIRECTORY named in prose
 * (`echo "see /root/.ssh/config"`). `.env.example|sample|template` are
 * readable — a relaxation of the old shell rule, matching file_read.
 */
const SECRET_PATH_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\/root\/\.claude\/\.credentials\.json\b/, reason: "credentials.json is off-limits to the shell" },
  { pattern: /\/root\/\.ssh(?:\/|\b)/, reason: "/root/.ssh is off-limits to the shell" },
  { pattern: /\/root\/\.(?:gnupg|aws|docker|kube|config\/gh)\b/, reason: "secret dotfile directory is off-limits to the shell" },
  { pattern: /\/etc\/(?:shadow|gshadow|sudoers|ssh)\b/, reason: "system secret is off-limits to the shell" },
  { pattern: /\/proc\/(?:self|\d+)\/(?:environ|mem)\b/, reason: "/proc/<pid>/environ and mem are off-limits to the shell" },
  { pattern: /\/root\/(?:\.npmrc|\.netrc|\.pgpass|\.gitconfig|\.git-credentials)\b/, reason: "dotfile credential is off-limits to the shell" },
  { pattern: /\/root\/claude\/mission-control\/data\/mc\.db/, reason: "mc.db (memories) is off-limits to the shell — all DB access goes through tools" },
  { pattern: /(?<![\w/.])(?:\.\/)?data\/mc\.db\b/, reason: "mc.db (memories) is off-limits to the shell — all DB access goes through tools" }, // `./data/mc.db` too (qa R14 W14-2); `../data/mc.db` is another file (qa R15 W15-2)
  { pattern: /\/opt\/supabase\/volumes\/api\/kong\.yml\b/, reason: "kong.yml (Supabase keys) is off-limits to the shell" },
];

/** `.env`-shaped filenames: absolute, `~`/`$HOME`-headed, or a standalone
 *  bare `.env` (the shell's default cwd IS mission-control). Same allow-by-
 *  membership rule as file_read (isBlockedEnvFile). A regex-escaped `\.env`
 *  is a pattern, not a path. */
const ENV_ABS_RE = /(?<![\w.\\-])(\/[\w.\/-]*\/\.env(?:[._-][\w.-]+)?)(?!\w)/g;
const ENV_BARE_RE = /(?<![\w.\/\\$@-])(?:\.\/)?(\.env(?:[._-][\w.-]+)?)(?![\w\/])/g;

/** Unquoted heredoc bodies as index ranges. A bare `.env` inside one is
 *  skipped REGARDLESS of receiver — prose piped to `cat`/`tee` is data, and an
 *  interpreter-fed body naming a bare `.env` is a deferred residual (absolute
 *  secret paths are still refused anywhere, including inside bodies). */
function heredocBodyRanges(text: string): Array<[number, number]> {
  // Line by line, one pass: the tags of a line open bodies in order on the lines that follow, each closed
  // by the first line that is `\t*TAG` (qa R13 W13-1: a regex with `[^\n]*` re-scanned the line at every
  // `<<`, quadratic on `<<<x` repeats). An unterminated body runs to the end and is not ranged.
  const ranges: Array<[number, number]> = [];
  const lineEnd = (p: number): number => { const e = text.indexOf("\n", p); return e === -1 ? text.length : e; };
  let pos = 0;
  while (pos < text.length) {
    const end = lineEnd(pos);
    const tags = [...text.slice(pos, end).matchAll(/<<-?\s*(\w+)/g)].map((m) => m[1]!);
    pos = end + 1;
    for (const tag of tags) {
      if (pos >= text.length) return ranges;
      const bodyStart = pos;
      let closed = false;
      while (pos < text.length) {
        const e = lineEnd(pos);
        const line = text.slice(pos, e);
        const m = /^\t*(\w+)/.exec(line);
        if (m && m[1] === tag && (line.length === m[0].length || /\s/.test(line[m[0].length]!))) {
          if (pos > bodyStart) ranges.push([bodyStart, pos - 1]);
          pos = e + 1;
          closed = true;
          break;
        }
        pos = e + 1;
      }
      if (!closed) return ranges;
    }
  }
  return ranges;
}

function checkSecretPaths(sanitized: string): { allowed: boolean; reason?: string } {
  // Quote splicing (`"/root/.ssh"/id_rsa`) and `~`/`$HOME` heads collapse to
  // one spelling before matching.
  const normalized = sanitized
    .replace(/(?<!\\)["']/g, "")
    .replace(/\$\{HOME\}|\$HOME/g, "/root")
    .replace(/(?<![\w/])~(?=\/)/g, "/root");
  for (const { pattern, reason } of SECRET_PATH_PATTERNS) {
    const hit = normalized.match(pattern);
    if (hit) return { allowed: false, reason: `'${hit[0]}': ${reason}` };
  }
  let m: RegExpExecArray | null;
  ENV_ABS_RE.lastIndex = 0;
  while ((m = ENV_ABS_RE.exec(normalized)) !== null) {
    if (isBlockedEnvFile(m[1]!)) {
      return {
        allowed: false,
        reason: `'${m[1]}' is a secrets file — .env files are off-limits to the shell (only the DENUE analyzer's .env is allow-listed)`,
      };
    }
  }
  const bodies = heredocBodyRanges(normalized);
  ENV_BARE_RE.lastIndex = 0;
  while ((m = ENV_BARE_RE.exec(normalized)) !== null) {
    const at = m.index;
    if (bodies.some(([a, b]) => at >= a && at < b)) continue;
    const abs = resolvePath(process.cwd(), m[1]!);
    if (isBlockedEnvFile(abs)) {
      return {
        allowed: false,
        reason: `'${m[1]}' resolves to ${abs} — .env files are off-limits to the shell (only the DENUE analyzer's .env is allow-listed)`,
      };
    }
  }
  return { allowed: true };
}

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
    // Standing orders on disk (audit R2-C2): the KB root is on the write
    // allow-list, so the directives tree is denied here like file_write /
    // code_edit deny it. Basename-bound on purpose — the guard sees command
    // text, not a resolved path; relative writes after a `cd` stay a known
    // residual (queue).
    pattern: /\/jarvis-kb\/directives(?:\/|$)/i,
    reason:
      "jarvis-kb/directives/ holds Jarvis's standing orders — changes go through jarvis_propose_directive",
  },
  {
    pattern: /\/root\/claude\/mission-control\//,
    reason: "Jarvis cannot modify its own source code via shell_exec",
    // Dynamic override: allowed on jarvis/* branches (checked at runtime)
  } as { pattern: RegExp; reason: string },
];

/** Heuristic tokens that indicate a write to a path. */
const WRITE_INDICATORS =
  /(?:>\|?\s*|>>\s*|tee\s+|mv\s+\S+\s+|cp\s+\S+\s+)(\/[^\s]+)/g; // `>|` is a plain truncating write (qa R14 C14-4)

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
 * Unscoped full-suite test runs are banned on this VPS (2026-07-12 incident:
 * repeated `timeout 90 npx vitest run` orphaned worker pools — 13 stacked
 * node processes, 8.3 GB RAM, load 10+, event loop starved, service looked
 * dead to the operator). This is the shell-tool mirror of the operator
 * session's vitest-scope-guard hook, which does not protect this code path.
 *
 * A vitest invocation must carry a scope: an explicit file/dir argument,
 * `-t`/`--testNamePattern`, `--changed`, or the `related` mode. `npm test`
 * (package script = bare `vitest run`) is blocked outright.
 *
 * @internal exported for tests
 */
export function checkUnscopedTestRun(segment: string): string | null {
  const SCOPED_HINT =
    'unscoped full-suite test runs exhaust VPS memory. Scope it: `npx vitest run <path/to/file.test.ts>`, `npx vitest run --changed`, or `npx vitest run -t "<name>"`';

  // npm test / npm run test — resolves to a bare full-suite run.
  if (/(?:^|\s)npm\s+(?:run\s+)?test(?::\S+)?(?:\s|$)/.test(segment)) {
    return `\`npm test\` runs the FULL vitest suite — ${SCOPED_HINT}`;
  }

  // vitest must be the segment's INVOCATION — the base command, or preceded
  // only by wrapper commands (`npx`, `timeout 90`, `env`, `nice`). An
  // argument occurrence (`grep vitest package.json`) is data, not a run.
  const tokens = segment.trim().split(/\s+/);
  const WRAPPERS = /^(npx|timeout|env|nice|node)$/;
  let i = 0;
  while (
    i < tokens.length &&
    (WRAPPERS.test(tokens[i].replace(/^.*\//, "")) ||
      /^\d+[smh]?$/.test(tokens[i]))
  ) {
    i++;
  }
  if (tokens[i]?.replace(/^.*\//, "") !== "vitest") return null;

  // Scope check over the ARGUMENT tokens (audit W2 fold 2026-07-12: a
  // slash inside a FLAG — `--config ./vitest.config.ts`,
  // `--outputFile=./out.json` — is not a scope; only a positional path
  // argument, a name filter, --changed, or the `related` mode count).
  const argTokens = tokens.slice(i + 1);
  const scoped = argTokens.some((tok, idx) => {
    if (tok === "--changed" || tok === "--testNamePattern" || tok === "-t")
      return true;
    if (tok.startsWith("--testNamePattern=")) return true;
    if (tok === "related") return true;
    if (tok.startsWith("-")) return false; // flags never scope
    // Skip the value of a flag that consumes one (--config x, -t "name") —
    // a path there configures the run, it doesn't scope it.
    const prev = argTokens[idx - 1];
    if (prev === "--config" || prev === "-c" || prev === "-t") return false;
    return tok.includes("/") || /\.test\.|\.spec\./.test(tok);
  });
  return scoped ? null : `unscoped \`vitest\` run — ${SCOPED_HINT}`;
}

/**
 * Dependency-trust gate (2026-09-16 dependency trust audit). shell_exec runs
 * on the HOST with mission-control as cwd and nothing above blocked a package
 * manager: `npm install <pkg>` rewrites the live node_modules under the
 * running service (that class crashed it 2026-07-12 and 2026-09-01; the
 * operator-side mc-guard hook never sees this path) and adds every
 * transitive the package declares to the lockfile. `npx <pkg>` is the same
 * authority in one step — with stdin not a TTY npm assumes `--yes`, fetches
 * the package from the registry into its cache and runs it (`man npm-exec`).
 * `npm config set registry …` redirects every later fetch. A dependency or
 * registry change is an operator decision: the shell may run bins that are
 * ALREADY installed under the cwd's node_modules/.bin and nothing else.
 *
 * Allowed: `npm run <script>`, `npm ls/view/outdated/audit`,
 * `npm install-scripts ls`, `npm config get/list`, `npx tsx|tsc|vitest …`.
 *
 * @internal exported for tests
 */
const NODE_PM_RE = /^(?:npm|pnpm|yarn|bun)$/;
const NODE_PM_MUTATING = new Set([
  "install", "i", "add", "ci", "install-ci-test", "cit", "install-test", "it",
  "update", "up", "upgrade", "uninstall", "unlink", "remove", "rm", "un", "r",
  "link", "ln", "dedupe", "ddp", "prune", "rebuild", "rb", "init", "create",
  "config", "set", "login", "adduser", "publish", "token",
  // qa R4 C-2: verbs the shim refuses that the string layer let through when
  // the shim was stripped from PATH — registry-side mutations and cache/pack.
  "unpublish", "deprecate", "star", "unstar", "pack", "owner", "access",
  "dist-tag", "hook", "org", "team", "profile", "edit", "explore", "logout",
  "cache", "patch", "patch-commit", "patch-remove", "import", "fetch", "store",
  "setup", "self-update", "policies", "plugin", "pm", "exec-env",
]);
/** `<verb> <arg>` pairs where only the ARG makes it a mutation (`npm audit fix`, `npm version patch`). */
const NODE_PM_MUTATING_PAIRS: Record<string, (arg: string) => boolean> = {
  audit: (a) => a === "fix",
  version: (a) => a !== "",
  pkg: (a) => a !== "get",
  "install-scripts": (a) => a !== "ls" && a !== "list",
};
const NODE_PM_REMOTE_EXEC = new Set(["exec", "x", "dlx"]);
const PY_PM_RE = /^(?:pip|pip3|pipx|uv|poetry|pipenv|conda)$/;
const PY_PM_MUTATING = new Set([
  "install", "uninstall", "add", "remove", "sync", "lock", "run", "venv",
  "update", "upgrade", "download", "wheel", "self", "publish", "build", "init",
  "export", "create", "clean", "rename", "clone", "pack", "update-shell",
]);
/** `uv pip|tool|python <sub>`: the SUB-verb decides (`uv pip list` is a read, qa R4 W-2). */
const UV_MUTATING_SUBS: Record<string, Set<string>> = {
  pip: new Set(["install", "uninstall", "sync", "compile", "download"]),
  tool: new Set(["run", "install", "uninstall", "upgrade", "update-shell", "uvx"]),
  python: new Set(["install", "uninstall", "pin", "upgrade"]),
  cache: new Set(["clean", "prune"]),
};
/** Always fetch-and-run a registry package (or download a package manager). */
const REMOTE_EXEC_BINS = new Set(["bunx", "uvx", "corepack"]);
const NPX_REMOTE_FLAG_RE = /^(?:-y|--yes|-p|--package(?:=.*)?|-c|--call(?:=.*)?)$/;
/** Flags whose VALUE is the next token — skipped so the verb is the first real positional. */
const PM_VALUE_FLAGS = new Set([
  "--prefix", "--registry", "-w", "--workspace", "-C", "--cwd", "--dir",
  "--loglevel", "--userconfig", "--cache", "--scope", "--tag", "--otp",
  "--filter", "--project", "--python",
]);
/** Shells that re-enter the parser on a string argument: the string is validated as a command of its own (qa R1 C1). */
const SHELL_REENTRY = new Set(["bash", "sh", "zsh", "dash", "ksh", "eval"]);
/** Every command word the gate has an opinion about (the flat walk starts a check at each). */
const PM_WORD_RE = /^(?:npm|pnpm|yarn|bun|npx|bunx|uvx|corepack|pip|pip3|pipx|uv|poetry|pipenv|conda|python|python3)$/;
const CD_WORD_RE = /^(?:cd|pushd|popd)$/;
/** A package manager named by its entry file instead of its PATH name (`node /usr/lib/node_modules/npm/bin/npm-cli.js`). */
const PM_ENTRY_RE = /(?:^|\/)(?:(npm|npx)-cli\.js|(pip3?)\/__main__\.py)$/;
function pmWord(token: string): string {
  const m = PM_ENTRY_RE.exec(token);
  return m ? (m[1] ?? m[2])! : token.replace(/^.*\//, "");
}
const HEREDOC_INTERPRETERS = /^(?:bash|sh|zsh|dash|ksh|eval|xargs|node|nodejs|python3?|perl|ruby|php|deno|bun|tsx)$/;
/**
 * The PATH shim (pm-shim/) is reached by NAME through PATH. Two things defeat
 * it (qa R4 C-1/C-2): replacing the child's PATH/environment before the
 * package manager runs, and copying the real binary under another name. Both
 * are refused as spelled; the shell has no legitimate need for either.
 */
const ENV_RESET_WORDS = new Set([
  "sudo", "su", "runuser", "setpriv", "chroot", "systemd-run", "at", "batch",
  "machinectl", "nsenter", "unshare", "capsh", "enable", "builtin", "doas",
]);
const LOGIN_SHELL_FLAG_RE = /^(?:--login|-[a-zA-Z]*l[a-zA-Z]*)$/;
const PATH_ASSIGN_RE = /(?:^|\.)PATH\s*[:=]/;
/** Wrappers beyond COMMAND_WRAPPERS that run their last argument as a command (util-linux / coreutils). */
const MORE_WRAPPERS = new Set(["xargs", "busybox", "toybox", "flock", "watch", "chrt", "taskset", "script", "unbuffer"]);
/** Commands whose arguments are DATA: a `"PATH":` key in a JSON body is not an env dict (qa R6 W6-3). */
const DATA_WORDS = new Set(["curl", "wget", "http", "jq", "gh", "git", "grep", "sed", "awk", "echo", "printf"]);
/** Commands that copy, move or splice a file: fed a package-manager binary they mint an unshimmed alias. */
const COPY_WORDS = new Set([
  "ln", "cp", "mv", "install", "rsync", "cat", "tee", "head", "tail", "sed",
  "awk", "tar", "cpio",
]);
/** Reads of a binary path that mint nothing (`ls -l /usr/bin/npm`, `test -x …`). */
const READ_WORDS = new Set([
  "ls", "file", "stat", "readlink", "realpath", "which", "type", "test", "[", "[[",
  "grep", "du", "wc", "md5sum", "sha256sum", "find", "namei", "basename", "dirname", "diff", "cmp",
]);
/** `/usr/bin/npm`, `…/npm-cli.js`, `/usr/lib/node_modules/npm` (the package dir), `/root/.local/bin/uvx` — not `node_modules/npm/package.json`. */
function isPmBinaryPath(token: string): boolean {
  if (!token.includes("/")) return false;
  return PM_WORD_RE.test(pmWord(token.replace(/\/+$/, "")));
}
/** The flag tokens directly after `tokens[i]` (before the first positional). */
function leadingFlags(tokens: string[], i: number): string[] {
  const out: string[] = [];
  for (let k = i + 1; k < tokens.length && tokens[k]!.startsWith("-"); k++) out.push(tokens[k]!);
  return out;
}

/** @internal exported for tests */
function isWrapper(word: string): boolean {
  return COMMAND_WRAPPERS.has(word) || MORE_WRAPPERS.has(word);
}
/** Words this rule set knows as commands — the only ones that become `cmdWord` behind a wrapper. */
function isKnownCommand(word: string): boolean {
  return READ_WORDS.has(word) || COPY_WORDS.has(word) || DATA_WORDS.has(word) || ENV_RESET_WORDS.has(word) ||
    SHELL_REENTRY.has(word) || /^(?:env|hash|command|alias|export|unset|declare|typeset|readonly|node|nodejs|python3?)$/.test(word);
}
export function checkEnvReset(segment: string): string | null {
  // Parentheses/brackets/commas split too, so a literal path inside an interpreter
  // program (`symlinkSync('/usr/bin/npm', …)`) is its own token. A shell GLOB naming a
  // manager binary (`cp /usr/bin/np? zz`) is deliberately not modelled here: three audit
  // rounds (R6–R8) each found a grammar the string layer got wrong (`[!]]`, POSIX classes,
  // brace ranges) or a cost it could not bound; the rename class belongs to the structural
  // closer queued in docs/planning/next-sessions-queue.md, not to a second shell parser.
  const raw = spaceRedirections(normalizeShellText(segment.trim())).split(/[\s(),[\]{}]+/).filter(Boolean);
  // A redirection is not a word: `2>/dev/null cp npm zz` runs cp and `<npm cat >zz` copies npm (qa R12
  // C12-1). Each one (with a detached target: `2> /dev/null`) moves to the END of the token list with
  // its operator stripped, so command position survives it and its target is checked as an argument.
  const tokens: string[] = [];
  const redirected: string[] = [];
  for (let k = 0; k < raw.length; k++) {
    const a = raw[k]!;
    const op = REDIRECTION_RE.exec(a)?.[0];
    if (op === undefined) { tokens.push(a); continue; }
    const target = redirectionSpan(raw, k) === 2 ? raw[++k]! : a.slice(op.length);
    if (target) redirected.push(target);
  }
  tokens.push(...redirected);
  const why = (what: string): string =>
    `\`${what}\` replaces the child PATH/environment, which removes the package-manager shim — run it with the inherited environment (shell_exec already runs as root); anything that needs another environment is an operator decision (dependency trust audit 2026-09-16)`;
  const copies = (what: string): string =>
    `\`${what}\` copies or references a package-manager binary under another name, which bypasses the shim — ${OPERATOR}`;
  // One hoisted pass: the LAST index of a `PATH` token, an `=` token and a manager binary/name
  // token. Every lookahead below is then O(1) and unbounded in reach — a windowed lookahead was
  // padded through with 64 `-v` flags (qa R11 C11-1), and an unbounded per-token scan was
  // quadratic (qa R10 C10-1).
  let lastPath = -1;
  let lastEq = -1;
  let lastPm = -1;
  for (let k = 0; k < tokens.length; k++) {
    const a = tokens[k]!;
    if (/^PATH(?:=|$)/.test(a)) lastPath = k;
    if (a.includes("=")) lastEq = k;
    if (isPmBinaryPath(a) || PM_WORD_RE.test(a)) lastPm = k;
  }
  // Command position: the first token, and every token after a wrapper, `xargs`, `busybox`,
  // `-exec`, a leading assignment or a leading flag (`env -i bash`). Behind a wrapper it is
  // STICKY for the rest of the segment and every rule below is UNCONDITIONAL there: a wrapper's
  // option values (`timeout -s KILL 5`, `flock /var/lock/ls`, `xargs -I ls`) are not enumerated
  // and cannot be told from the command they precede, so any attempt to decide "have we passed
  // the real command word yet" was decoyed (qa R9 C9-1, R10 W10-1/W10-2, R11 C11-2 — three
  // rounds, 3-strike stop). The accepted cost, disclosed in the audit doc §5: behind a wrapper,
  // an admin word (`sudo`, `su`, `at`, …) or a copy word followed by a manager name anywhere in
  // the segment is refused even as prose (`timeout 5 echo look at this`); 0 corpus rows start
  // with a wrapper.
  let cmdPos = true;
  let sticky = false;
  let cmdWord = "";
  let lastKnown = ""; // behind a wrapper: the last KNOWN command word, for the data/entry exemptions
  let readSeen = false; // behind a wrapper: a read word has appeared …
  let otherSeen = false; // … and a known non-read word has appeared
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const word = t.replace(/^.*\//, "");
    // `PATH=/x npm …`, `process.env.PATH='/x'`, `os.environ["PATH"]=…`, `env={"PATH": …}` — anywhere.
    if (PATH_ASSIGN_RE.test(t) || (t === "PATH" && /^[:=]/.test(tokens[i + 1] ?? ""))) {
      // `PATH:` (a dict/JSON key) counts only where it could be an env dict — not in a curl body (qa R6 W6-3).
      if (!/PATH\s*:/.test(`${t}${tokens[i + 1] ?? ""}`) || !DATA_WORDS.has(sticky ? lastKnown : cmdWord)) return why(t);
    }
    // A manager's binary path as an ARGUMENT of anything but a read (`fs.symlinkSync('/usr/bin/npm', …)`,
    // `shutil.copy('/usr/bin/npm', …)`, `busybox cp /usr/bin/npm zz`) — qa R5 W5-2. Behind a wrapper the
    // read exemption holds only while READ words alone have been seen (a decoy `flock /var/lock/ls` cannot
    // buy it for a later `node`/`cp`/`dd`; an unknown word buys nothing either — qa R11 C11-2).
    if (isPmBinaryPath(t)) {
      const entry = PM_ENTRY_RE.test(t) && /^(?:node|nodejs|python3?)$/.test(sticky ? lastKnown : cmdWord); // `node …/npm-cli.js <verb>` stays with the verb rules
      if (!sticky && !cmdPos && !READ_WORDS.has(cmdWord) && !entry) return copies(`${cmdWord} ${t}`);
      if (sticky && !(readSeen && !otherSeen) && !entry) return copies(`${lastKnown || cmdWord} ${t}`);
    }
    if (cmdPos && t.startsWith("-")) continue; // a leading flag is read from its command word above, and keeps command position
    if (cmdPos) {
      if (!sticky) cmdWord = word;
      else if (isKnownCommand(word)) {
        lastKnown = word;
        if (READ_WORDS.has(word)) readSeen = true;
        else otherSeen = true;
      }
      const flags = leadingFlags(tokens, i);
      if (ENV_RESET_WORDS.has(word)) return why(word);
      if (/^(?:export|unset|declare|typeset|readonly)$/.test(word) && lastPath > i) return why(`${word} PATH`);
      if (word === "env") {
        const flag = flags.find((a) => /^(?:-[a-zA-Z]*[iu][a-zA-Z]*|--ignore-environment|--unset(?:=.*)?|-S|--split-string(?:=.*)?)$/.test(a));
        if (flag) return why(`env ${flag}`);
      }
      if ((word === "hash" || word === "command") && flags.some((a) => /^-[a-zA-Z]*p/.test(a))) return why(`${word} -p`);
      if (word === "alias" && lastEq > i) return why("alias");
      if (SHELL_REENTRY.has(word) && word !== "eval" && flags.some((a) => LOGIN_SHELL_FLAG_RE.test(a))) return why(`${word} --login`);
      // `cp /usr/bin/npm zz`, and the bare name after `cd /usr/bin` (`cp npm zz`) — anywhere later in the segment.
      if (COPY_WORDS.has(word) && lastPm > i) return copies(`${word} ${tokens[lastPm]}`);
    }
    const wrapper = isWrapper(word);
    if (cmdPos && wrapper) sticky = true;
    cmdPos = sticky || wrapper || /^-exec(?:dir)?$/.test(t) || /^[A-Za-z_]\w*=/.test(t);
  }
  return null;
}

/** `cd -` / `cd $VAR`: the directory is unknowable here, so `npx` cannot prove a local bin. */
const UNKNOWN_CWD = "/nonexistent/unknown-cwd";
const OPERATOR =
  "a dependency or registry change is an operator decision (dependency trust audit 2026-09-16) — report the exact command for the operator instead";

/** Where a `cd` segment leaves the shell (relative paths resolve against the current cwd, qa R2 H-2). */
function nextCwd(segment: string, cwd: string): string {
  // Only a segment that IS a cd/pushd/popd moves the cwd (`echo 'cd x'` does not, qa R3 N-5).
  const m = /^\(*\s*(cd|pushd|popd)(?:\s+([^)]*?))?\s*\)*$/.exec(segment);
  if (!m) return cwd;
  if (m[1] === "popd") return UNKNOWN_CWD;
  const target = (m[2] ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .find((t) => t !== "--" && !/^-[PLe@]+$/.test(t)) // `cd -- /x`, `cd -P /x`
    ?.replace(/["']/g, "")
    .replace(/\$\{?HOME\}?/g, process.env.HOME ?? "/root");
  if (target === undefined) return m[1] === "pushd" ? UNKNOWN_CWD : (process.env.HOME ?? "/root");
  if (target === "-" || target.includes("$")) return UNKNOWN_CWD;
  if (target === "~" || target.startsWith("~/")) return resolvePath(process.env.HOME ?? "/root", target.slice(2));
  return resolvePath(cwd === UNKNOWN_CWD ? "/" : cwd, target);
}

/** Bodies of quoted heredocs fed to an interpreter — code, not prose (qa R1 C2). */
function interpreterHeredocBodies(command: string): string {
  const out: string[] = [];
  const re = /^([^\n]*?)<<-?\s*['"]([^'"\s]+)['"]([^\n]*)\n([\s\S]*?)\n\t*\2(?=\s|$)/gm;
  for (const m of command.matchAll(re)) {
    // The body reaches an interpreter through ANY stage of the receiver line:
    // `bash <<'EOF'`, `cat <<'EOF' | bash`, `tee x <<'EOF' | sh` (qa R3 N-1).
    const stages = `${m[1]} ${m[3]}`.split(/\|\||&&|\||;|&/);
    if (stages.some((st) => HEREDOC_INTERPRETERS.test(effectiveBaseCommand(st.trim())))) out.push(m[4]!);
  }
  return out.join("\n");
}

/**
 * Shell spellings that are no-ops to the shell but blind a string scanner
 * (qa R1 C3, R2 C-3): `$'npm'`, `"npm"`, `n\pm`, `P=npm; $P install`. Every
 * substitution is a linear regex (no nested quantifiers).
 */
function normalizeShellText(text: string): string {
  const vars = new Map<string, string>([["HOME", process.env.HOME ?? "/root"]]);
  for (const m of text.matchAll(/(?:^|[\s;&|(])([A-Za-z_]\w*)=([^\s;&|]+)/g)) {
    vars.set(m[1]!, m[2]!.replace(/["'\\]/g, ""));
  }
  let out = text.replace(/\$'((?:[^'\\]|\\.)*)'/g, "$1");
  // `${P:-npm}` `${P-npm}` `${P:=npm}` `${P:+npm}` `${P:?x}` (qa R3 N-2): the
  // expansion is the variable when known, else the default word — innermost
  // first so `${A:-${B:-npm}}` folds in two passes.
  for (let pass = 0; pass < 8; pass++) {
    const next = out.replace(
      /\$\{([A-Za-z_]\w*)(:?[-=+?])([^{}]*)\}/g,
      (_all, n: string, op: string, word: string) =>
        op.endsWith("+") ? word : (vars.get(n) ?? (op.endsWith("?") ? "" : word)),
    );
    if (next === out) break;
    out = next;
  }
  return (
    out
      // `$P` / `${P}`: known value, else empty — so `npm${X}` / `npm$X` read as `npm`.
      .replace(/\$\{?([A-Za-z_]\w*)\}?/g, (_all, n: string) => vars.get(n) ?? "")
      .replace(/["'\\]/g, "")
  );
}

/**
 * Wrapper-proof layer of the dependency-trust gate (qa R1 C1–C4, R2 C-1..C-4).
 * The per-segment walk is defeated by anything that re-enters a shell
 * (`bash -c "…"`, `xargs`, `node -e "execSync('…')"`), by quoted-heredoc bodies
 * (stripped before the segment scan) and by quoting the command word. So the
 * whole command — normalized, plus the bodies of quoted heredocs whose
 * receiver is an interpreter (prose piped to `cat`/`tee` stays data) — is
 * flattened into one token stream and the SAME token rules run from every
 * position that names a package manager, tracking `cd` on the way. A flat
 * walk is linear: no regex over the command text, so no backtracking (qa R2
 * C-4 — the previous regex layer wedged the event loop for 29 s on 229 chars).
 * @internal exported for tests
 */
export function checkPackageManagerRaw(command: string, cwd: string = process.cwd()): string | null {
  const scan = spaceRedirections(normalizeShellText(`${stripQuotedHeredocs(command)}\n${interpreterHeredocBodies(command)}`));
  // Segment-aware walk (qa R3 N-3/N-4/N-5): parentheses carry a cwd stack, only
  // a segment that STARTS with cd/pushd/popd moves the cwd, and the token
  // rules see the whole segment from each package-manager word onward
  // (bounded by positionals, not raw tokens, so flag padding buys nothing).
  // Environment/PATH rewrites and binary copies, per line (parentheses are
  // tokenized inside checkEnvReset, so an interpreter call keeps its arguments).
  for (const line of scan.split(SEGMENT_SPLIT_RE)) {
    const envReset = checkEnvReset(line);
    if (envReset) return envReset;
  }
  const stack: string[] = [];
  for (const part of scan.split(/([()])|[\n;]|(?<![<>])\||(?<![<>])&(?!>)/)) {
    if (!part) continue;
    if (part === "(") {
      stack.push(cwd);
      continue;
    }
    if (part === ")") {
      cwd = stack.pop() ?? cwd;
      continue;
    }
    const tokens = part.split(/[\s,[\]{}`$]+/).filter(Boolean);
    if (tokens.length === 0) continue;
    if (CD_WORD_RE.test(tokens[0]!.replace(/^.*\//, ""))) {
      cwd = nextCwd(tokens.join(" "), cwd);
      continue;
    }
    for (let i = 0; i < tokens.length; i++) {
      if (!PM_WORD_RE.test(pmWord(tokens[i]!))) continue;
      const verdict = checkPackageManagerMutation(verbWindow(tokens, i).join(" "), cwd, { flat: i !== 0 });
      if (verdict) return verdict;
    }
  }
  return null;
}

/** Tokens from `start` until 8 positionals are collected; flags beyond 64 are dropped, not counted. */
function verbWindow(tokens: string[], start: number): string[] {
  const out: string[] = [];
  let positionals = 0;
  let flags = 0;
  for (let k = start; k < tokens.length && positionals < 8; k++) {
    const t = tokens[k]!;
    if (k > start && REDIRECTION_RE.test(t)) { k += redirectionSpan(tokens, k) - 1; continue; } // `npm >/tmp/o install x` (qa R13)
    if (t.startsWith("-") && k > start) {
      if (flags++ < 64) out.push(t);
      continue;
    }
    positionals++;
    out.push(t);
  }
  return out;
}

function findUp(cwd: string, rel: string): boolean {
  if (cwd === UNKNOWN_CWD) return false;
  for (let dir = cwd; ; dir = resolvePath(dir, "..")) {
    if (existsSync(resolvePath(dir, rel))) return true;
    if (dir === resolvePath(dir, "..")) return false;
  }
}

/**
 * `npm run <name>` executes `scripts[<name>]` (plus `pre<name>`/`post<name>`)
 * from the nearest package.json as a shell command: the body is validated
 * like a command typed into the tool (qa R4 C-3 — a script body
 * `PATH=/usr/bin npm install x` reached the real npm). The lookup mirrors
 * npm's: `--prefix`/`-C`/`--cwd` move the root; a workspace flag or an
 * unknowable cwd cannot be resolved and is refused; no package.json = nothing
 * to run. Only the dependency-trust rules apply to the body (a repo's own
 * `rm -rf dist` build step is not this gate's business). Depth-bounded so
 * `a: npm run b` / `b: npm run a` terminates.
 */
let scriptDepth = 0;
function checkPackageJsonScript(pm: string, name: string, rest: string[], cwd: string): string | null {
  if (!name) return null; // `npm run` lists scripts
  let root = cwd;
  for (let k = 0; k < rest.length; k++) {
    const t = rest[k]!;
    const m = /^(--prefix|-C|--cwd|--dir)(?:=(.*))?$/.exec(t);
    if (m) root = resolvePath(root === UNKNOWN_CWD ? "/" : root, m[2] ?? rest[k + 1] ?? "");
    if (/^(?:-w|--workspaces?|--filter|-r|--recursive)(?:=|$)/.test(t)) {
      return `\`${pm} run ${name}\` with a workspace flag runs script bodies this gate cannot resolve — ${OPERATOR}`;
    }
  }
  if (root === UNKNOWN_CWD) return `\`${pm} run ${name}\` from an unknowable cwd cannot be checked against its package.json — ${OPERATOR}`;
  let scripts: Record<string, unknown> | undefined;
  for (let dir = root; ; dir = resolvePath(dir, "..")) {
    const file = resolvePath(dir, "package.json");
    if (existsSync(file)) {
      try {
        scripts = (JSON.parse(readFileSync(file, "utf-8")) as { scripts?: Record<string, unknown> }).scripts;
      } catch {
        return `\`${pm} run ${name}\`: ${file} is not readable JSON, so its script body cannot be checked — ${OPERATOR}`;
      }
      break;
    }
    if (dir === resolvePath(dir, "..")) break;
  }
  if (!scripts || typeof scripts !== "object") return null;
  if (name === "t" || name === "tst") name = "test";
  if (scriptDepth >= 4) return `\`${pm} run ${name}\` nests package.json scripts more than 4 deep — ${OPERATOR}`;
  // npm synthesizes `restart` as `npm stop --if-present && npm start` when no restart script exists (qa R5 C5-1).
  const names = name === "restart" && typeof scripts.restart !== "string" ? ["stop", "start", "restart"] : [name];
  scriptDepth++;
  try {
    for (const key of names.flatMap((n) => [`pre${n}`, n, `post${n}`])) {
      const body = scripts[key];
      if (typeof body !== "string" || !body.trim()) continue;
      const verdict = checkPackageManagerRaw(body, root);
      if (verdict) return `inside package.json script \`${key}\` (${body.trim().slice(0, 80)}): ${verdict}`;
    }
  } finally {
    scriptDepth--;
  }
  return null;
}

export function checkPackageManagerMutation(
  segment: string,
  cwd: string,
  opts: { flat?: boolean } = {},
): string | null {
  const tokens = normalizeShellText(segment.trim()).split(/\s+/);
  let i = 0;
  while (
    i < tokens.length &&
    (COMMAND_WRAPPERS.has(tokens[i]!.replace(/^.*\//, "")) ||
      /^[A-Za-z_]\w*=/.test(tokens[i]!) ||
      /^(?:-\S*|\d+(?:\.\d+)?[smhd]?)$/.test(tokens[i]!))
  ) {
    i++;
  }
  let base = tokens[i] ? pmWord(tokens[i]!) : "";
  if (!base) return null;
  let rest = tokens.slice(i + 1);
  // `python3 -m pip install x` — the module is the package manager (qa R1 C4).
  if (/^python3?$/.test(base)) {
    const m = rest.indexOf("-m");
    if (m !== -1 && rest[m + 1] && PY_PM_RE.test(rest[m + 1]!)) {
      base = rest[m + 1]!;
      rest = rest.slice(m + 2);
    }
  }
  // Verb = first positional after flags and the values of value-taking flags
  // (`npm --prefix /x install y`). An argument that merely EQUALS a verb
  // (`npm ls i`) is not the verb (qa R1 W3).
  let sub = "";
  for (let k = 0; k < rest.length; k++) {
    const t = rest[k]!;
    if (t.startsWith("-")) {
      // `-w`/`--workspace` take a value for npm only (pnpm/bun: boolean, qa R4 W-5).
      if (PM_VALUE_FLAGS.has(t) && !(/^(?:-w|--workspace)$/.test(t) && base !== "npm")) k++;
      continue;
    }
    sub = t;
    break;
  }

  if (SHELL_REENTRY.has(base) && !opts.flat) {
    // `bash -c "…"` / `eval …`: validate the string as its own command.
    const inner = rest.filter((t) => base === "eval" || !/^-[a-z]+$/.test(t)).join(" ");
    if (inner.trim()) {
      const verdict = validateShellCommand(inner);
      if (!verdict.allowed) return `inside \`${base}\`: ${verdict.reason}`;
    }
    return null;
  }
  if (REMOTE_EXEC_BINS.has(base)) {
    return `\`${base}\` fetches and runs a registry package — ${OPERATOR}`;
  }
  // The positional after the verb (`npm audit FIX`, `uv pip INSTALL`).
  const arg = rest.slice(rest.indexOf(sub) + 1).find((t) => !t.startsWith("-")) ?? "";
  if (NODE_PM_RE.test(base)) {
    // Repo-defined scripts are the sanctioned entry point (build, typecheck, …)
    // — but the script BODY runs as a shell command, so it is validated too (qa R4 C-3).
    if (sub === "run" || sub === "run-script") return checkPackageJsonScript(base, arg, rest, cwd);
    if (/^(?:test|t|tst|start|stop|restart)$/.test(sub)) return checkPackageJsonScript(base, sub, rest, cwd);
    if (base === "yarn" && !opts.flat && rest.length === 0) return `bare \`yarn\` installs — ${OPERATOR}`;
    // `yarn workspace <name> add x` (qa R2 M-1): the verb follows the workspace name.
    if (base === "yarn" && sub === "workspace") sub = rest[rest.indexOf("workspace") + 2] ?? "";
    if (NODE_PM_REMOTE_EXEC.has(sub)) {
      return `\`${base} ${sub}\` fetches and runs a registry package — ${OPERATOR}`;
    }
    if (sub === "config" || sub === "c") {
      return /^(?:get|list|ls)$/.test(arg)
        ? null
        : `\`${base} config ${arg}\` changes the registry/auth setup — ${OPERATOR}`;
    }
    if (NODE_PM_MUTATING.has(sub) || NODE_PM_MUTATING_PAIRS[sub]?.(arg)) {
      return `\`${base} ${sub}${arg ? ` ${arg}` : ""}\` mutates node_modules/lockfile, package.json or the registry — ${OPERATOR}`;
    }
    // `pnpm build` / `yarn build` / `bun build`: shorthand for `run build` (qa R5 W5-1).
    if (base !== "npm" && sub) return checkPackageJsonScript(base, sub, rest, cwd);
    return null;
  }
  if (PY_PM_RE.test(base)) {
    const uvSub = base === "uv" ? UV_MUTATING_SUBS[sub] : undefined;
    if (PY_PM_MUTATING.has(sub) || uvSub?.has(arg)) {
      return `\`${base} ${sub}${uvSub ? ` ${arg}` : ""}\` installs Python packages — ${OPERATOR}`;
    }
    return null;
  }
  if (base === "npx") {
    const remoteFlag = rest.find((t) => NPX_REMOTE_FLAG_RE.test(t));
    if (remoteFlag) {
      return `\`npx ${remoteFlag}\` fetches a registry package — ${OPERATOR}`;
    }
    if (!sub) return null;
    // An explicit version spec (`tsx@latest`, `tsx@9.9.9`) is never satisfied
    // by the local bin: npm resolves it against the registry (qa R1 C5).
    if (/^(?:@[^/]+\/)?[^@]+@/.test(sub)) {
      return `\`npx ${sub}\` carries a version spec — npm resolves that against the registry, not the local bin; ${OPERATOR}`;
    }
    // Scoped: the PACKAGE must be installed (`@evil/tsx` would otherwise pass
    // on the unscoped bin name, qa R1 C6). Unscoped: the bin must exist. A
    // `./node_modules/.bin/x` path is checked as written.
    // npx looks in every ancestor node_modules, so `cd scripts && npx tsx` is local (qa R3 N-4).
    const local = sub.startsWith("@")
      ? /^@[\w.-]+\/[\w.-]+$/.test(sub) && findUp(cwd, `node_modules/${sub}`)
      : /^(?:\.\/)?node_modules\/\.bin\/[\w.-]+$/.test(sub)
        ? existsSync(resolvePath(cwd, sub))
        : /^[\w.-]+$/.test(sub) && findUp(cwd, `node_modules/.bin/${sub}`);
    if (!local) {
      return `\`npx ${sub}\` is not installed under ${cwd}/node_modules — npm would fetch it from the registry and run it (non-TTY stdin assumes --yes); ${OPERATOR}`;
    }
  }
  return null;
}

/**
 * P1 (2026-07-12): mutating git on the PRIMARY mission-control checkout is
 * blocked at the shell layer too — it is shared with live operator sessions
 * (Jarvis's staging/checkouts contaminated two operator commits and flipped
 * the branch under an active session). His git work belongs in the dedicated
 * worktree (/root/claude/mission-control-jarvis, jarvis_dev bootstraps it).
 * Read-only git (status/log/diff/show/branch listing) stays allowed anywhere.
 *
 * A segment is blocked when a mutating git subcommand targets the primary:
 * via `-C /root/claude/mission-control`, a `cd` to it earlier in the COMMAND,
 * or NO repo path at all (shell_exec's default cwd IS the primary checkout).
 *
 * @internal exported for tests
 */
const GIT_MUTATING_RE =
  /^(add|commit|checkout|switch|restore|reset|stash|merge|rebase|clean|cherry-pick|am|apply|worktree|push|pull|mv|rm)$/;

export function checkPrimaryMcGitMutation(
  segment: string,
  fullCommand: string,
): string | null {
  const tokens = segment.trim().split(/\s+/);
  const gitIdx = tokens.findIndex((t) => t.replace(/^.*\//, "") === "git");
  if (gitIdx === -1) return null;

  // Locate the subcommand (skip -C <path> and -c key=val option pairs).
  let i = gitIdx + 1;
  let explicitRepo: string | null = null;
  while (i < tokens.length) {
    if (tokens[i] === "-C") {
      explicitRepo = tokens[i + 1] ?? null;
      i += 2;
    } else if (tokens[i] === "-c") {
      i += 2;
    } else if (tokens[i]?.startsWith("-")) {
      i++;
    } else {
      break;
    }
  }
  const sub = tokens[i];
  if (!sub || !GIT_MUTATING_RE.test(sub)) return null;

  const PRIMARY = "/root/claude/mission-control";
  const targetsPrimary = (p: string | null): boolean =>
    p !== null &&
    (p === PRIMARY || p.startsWith(PRIMARY + "/")) &&
    !p.startsWith(PRIMARY + "-jarvis");

  // Explicit -C wins; otherwise the last `cd <path>` in the full command;
  // otherwise the default cwd — which IS the primary checkout.
  let repo: string | null = explicitRepo;
  if (repo === null) {
    const cds = [...fullCommand.matchAll(/\bcd\s+(\S+)/g)];
    repo = cds.length > 0 ? cds[cds.length - 1][1] : PRIMARY;
  }
  if (!targetsPrimary(repo)) return null;

  return (
    `mutating git (\`${sub}\`) on the primary mission-control checkout is blocked — ` +
    `it is shared with operator sessions. Use the jarvis worktree ` +
    `(/root/claude/mission-control-jarvis, jarvis_dev bootstraps it) or the git_* tools.`
  );
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

  // Split on shell separators to check each segment. A newline is a
  // separator too — a multi-line command used to be judged by line 1 only
  // (security audit, qa R1 C4).
  const segments = spaceRedirections(sanitized).split(/\s*(?:\|\||&&|(?<![<>])\||;|(?<![<>])&(?!&|>)|\n)\s*/); // `2>&1` and `>|` are not separators (qa R12 C12-1, R13 C13-1); spaced AFTER the process-substitution check, which `x=>(1)` would trip

  // cwd as the package-manager gate sees it: an absolute `cd` earlier in the
  // command moves it; otherwise shell_exec's default cwd (the primary checkout).
  let segmentCwd = process.cwd();
  const cwdStack: string[] = []; // `(cd /tmp && ls) && npx …` — the subshell's cd does not leak (qa R3 N-5)
  let pendingPops = 0;

  // Dependency-trust gate, raw-string layer (wrapper/heredoc/quote-proof).
  const pmRawViolation = checkPackageManagerRaw(command);
  if (pmRawViolation) {
    return { allowed: false, reason: pmRawViolation };
  }

  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed) continue;

    for (; pendingPops > 0; pendingPops--) segmentCwd = cwdStack.pop() ?? segmentCwd;
    for (let k = 0; k < (/^\(+/.exec(trimmed)?.[0].length ?? 0); k++) cwdStack.push(segmentCwd);
    segmentCwd = nextCwd(trimmed, segmentCwd);
    pendingPops = /\)+$/.exec(trimmed)?.[0].length ?? 0; // the subshell closes AFTER this segment runs

    // Extract base command (first token), strip any path prefix
    const firstToken = trimmed.split(/\s/)[0];
    const baseName = firstToken.replace(/^.*\//, ""); // /usr/bin/rm → rm
    // …and the verb behind leading keywords/wrappers (`do systemctl`,
    // `sudo -n systemctl`, `env -i bash`). Additive: checked as well as, not
    // instead of, the first token.
    const effective = effectiveBaseCommand(trimmed);

    if (DENY_COMMANDS.has(baseName) || DENY_COMMANDS.has(effective)) {
      const verb = DENY_COMMANDS.has(baseName) ? baseName : effective;
      // An unquoted heredoc body is scanned line by line (its text may be a
      // program); literal file content goes through a QUOTED heredoc.
      const hint = /<<-?\s*\w+/.test(sanitized)
        ? " — if this is literal file content, use a quoted heredoc (<<'EOF') or file_write"
        : "";
      return { allowed: false, reason: `command '${verb}' is blocked${hint}` };
    }

    // Resource guard: unscoped full-suite test runs (2026-07-12 incident).
    const testRunViolation = checkUnscopedTestRun(trimmed);
    if (testRunViolation) {
      return { allowed: false, reason: testRunViolation };
    }

    // Dependency-trust gate: no package installs / registry execs from the shell.
    const pmViolation = checkEnvReset(trimmed) ?? checkPackageManagerMutation(trimmed, segmentCwd);
    if (pmViolation) {
      return { allowed: false, reason: pmViolation };
    }

    // Worktree guard: mutating git on the shared primary checkout (P1).
    const gitViolation = checkPrimaryMcGitMutation(trimmed, sanitized);
    if (gitViolation) {
      return { allowed: false, reason: gitViolation };
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

  // Secret paths by PATH, not by reader verb (SEC-01 / SEC-03).
  const secretVerdict = checkSecretPaths(sanitized);
  if (!secretVerdict.allowed) return secretVerdict;

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
              `(?:^|[^>])>\\|?\\s*${p}(?:\\s|$)`, // `>|` clobbers too (qa R15 N15-1)
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

    const shimMissing = pmShimMissing();
    if (shimMissing) {
      console.error(shimMissing);
      return JSON.stringify({ exit_code: -1, stdout: "", stderr: shimMissing });
    }

    try {
      const { stdout, stderr } = await execGroupKill(command, {
        timeout,
        maxBuffer: 1024 * 1024, // 1MB
        // H1: hand the child a scrubbed env so `env`/`printenv`/`echo $VAR`
        // can't exfiltrate mission-control's secrets (see buildScrubbedEnv).
        // PATH starts with the package-manager shim (see PM_SHIM_DIR).
        env: withPmShimPath(buildScrubbedEnv()),
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
      // The shim's refusal is the gate's only live signal: put it in the journal (console.error, like
      // `[pm-shim] missing`) so the operator can watch `grep -c 'pm-shim\] refused'` without reading turns.
      if (stderr.includes("[pm-shim] refused:")) console.error(`[pm-shim] refused (shell_exec): ${redactSecrets(command).slice(0, 300)}`);
      return JSON.stringify({
        exit_code: exitCode,
        stdout: (error.stdout ?? "").slice(0, MAX_OUTPUT),
        stderr: stderr.slice(0, MAX_OUTPUT),
      });
    }
  },
};
