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
import { homedir } from "os";
import { dirname, resolve as resolvePath } from "path";
import { fileURLToPath } from "url";
import { getJarvisKbRoot } from "../../db/jarvis-fs.js";
import { realResolve, isOperatorConfigPath } from "./write-guard.js";
import {
  buildFlailingBlockMessage,
  checkFlailing,
  recordCall,
} from "../flailing-guard.js";
import { redactCredentials, redactSecrets } from "../../api/mcp-server/redact.js";
import { scrubSecrets, secretEnvForCommand } from "../../lib/secret-refs.js";

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
export function execGroupKill(
  command: string,
  opts: { timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv; cwd?: string },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", command], {
      detached: true,
      cwd: opts.cwd,
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
  // X API bearer per account (`X_API_BEARER__<handle>`; WS3b R1 W4)
  "BEARER",
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

/**
 * PATH with the shim directory first (and nowhere else), and `DOCKER_CONFIG` pinned (audit B3,
 * see withDockerConfig) — so every caller (shell_exec and the task_gates check_cmd child in
 * gate-check.ts) gets both from one place.
 */
export function withPmShimPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const rest = (env.PATH ?? "/usr/local/bin:/usr/bin:/bin").split(":").filter((d) => d !== PM_SHIM_DIR);
  return withDockerConfig({ ...env, PATH: [PM_SHIM_DIR, ...rest].join(":") });
}

/**
 * Audit B3: the docker CLI reads `$DOCKER_CONFIG`, else `$HOME/.docker` — so `HOME=/tmp/h docker ps`
 * would load another config.json (which can set a context, hence a daemon). The child env pins
 * `DOCKER_CONFIG` to the directory resolved ONCE at startup from mission-control's own environment,
 * so a HOME override in the command no longer moves it (overriding or unsetting `DOCKER_CONFIG`
 * itself is refused by the docker gate).
 */
export const DOCKER_CONFIG_DIR = process.env.DOCKER_CONFIG || resolvePath(process.env.HOME || homedir(), ".docker");

/** The env with `DOCKER_CONFIG` pinned to DOCKER_CONFIG_DIR. */
export function withDockerConfig(env: NodeJS.ProcessEnv, dir: string = DOCKER_CONFIG_DIR): NodeJS.ProcessEnv {
  return { ...env, DOCKER_CONFIG: dir };
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
export const DENY_COMMANDS = new Set([
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
/** `busybox rm`, `toybox rm`: a multi-call binary runs the applet it names. */
const APPLET_HOSTS = new Set(["busybox", "toybox"]);
export function effectiveBaseCommand(segment: string, applets = false): string {
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
    if (COMMAND_WRAPPERS.has(base) || (applets && APPLET_HOSTS.has(base))) {
      i++;
      // every wrapper: skip its flags and `--`; numeric args for timeout/nice
      while (i < tokens.length && /^(?:-\S*|\d+(?:\.\d+)?[smhd]?)$/.test(tokens[i]!)) i++;
      continue;
    }
    return base;
  }
  return "";
}

/**
 * audit R2 W2: wrappers that run the command after them, with the flags that take a
 * separate value, the positionals they consume first, and the flags whose value IS a
 * command (`timeout -s KILL 5 rm`, `taskset -c 0 rm`, `flock /tmp/l -c 'rm x'`).
 */
type RunWrapper = { values?: string[]; positionals?: number; command?: string[] };
const RUN_WRAPPERS = new Map<string, RunWrapper>([
  ...[...COMMAND_WRAPPERS, ...APPLET_HOSTS, "unbuffer", "catchsegv"].map((w): [string, RunWrapper] => [w, {}]),
  ["env", { values: ["-u", "--unset", "-C", "--chdir"], command: ["-S", "--split-string"] }],
  ["sudo", { values: ["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U", "-T"] }],
  ["exec", { values: ["-a"] }],
  ["time", { values: ["-f", "-o", "--format", "--output"] }],
  ["timeout", { values: ["-s", "--signal", "-k", "--kill-after"], positionals: 1 }],
  ["nice", { values: ["-n", "--adjustment"] }],
  ["ionice", { values: ["-c", "-n", "-p", "-P", "-u", "--class", "--classdata"] }],
  ["stdbuf", { values: ["-i", "-o", "-e", "--input", "--output", "--error"] }],
  ["chrt", { values: ["-T", "-P", "-D", "--sched-runtime", "--sched-period", "--sched-deadline"], positionals: 1 }],
  ["taskset", { positionals: 1 }],
  ["flock", { values: ["-w", "--wait", "--timeout", "-E", "--conflict-exit-code"], positionals: 1, command: ["-c", "--command"] }],
  ["watch", { values: ["-n", "--interval", "-q", "--equexit"] }],
  ["strace", { values: ["-e", "-o", "-p", "-s", "-u", "-E", "-a", "-I", "-X", "-P", "-b", "-O", "-S"] }],
  ["ltrace", { values: ["-e", "-o", "-p", "-s", "-u", "-a", "-n", "-x", "-w", "-A", "-D", "-F"] }],
  ["numactl", { values: ["-C", "-N", "-m", "-i", "-p", "-P", "-w", "--physcpubind", "--cpunodebind", "--membind", "--interleave", "--preferred"] }],
  ["prlimit", { values: ["-p", "--pid", "-o", "--output"] }],
  ["systemd-cat", { values: ["-t", "-p", "--identifier", "--priority", "--stderr-priority"] }],
  ["cgexec", { values: ["-g"] }],
  ["xargs", { values: ["-a", "--arg-file", "-d", "--delimiter", "-E", "-I", "-L", "-n", "--max-args", "-P", "--max-procs", "-s", "--max-chars"] }],
  ["parallel", { values: ["-j", "--jobs", "-S", "--sshlogin", "-a", "--arg-file", "-d", "--delimiter", "-E", "-I", "-L", "-n", "-N", "-P", "-s"] }],
  ["script", { values: ["-E", "-T", "-I", "-O", "-B", "-m"], command: ["-c", "--command"] }],
]);
/** Shells whose `-c` string is judged as a command too (`busybox sh -c 'rm x'`). */
const C_SHELLS = new Set(["sh", "bash", "dash", "ash", "hush", "zsh", "ksh", "mksh"]);
/** An unquoted `{a,b}` / `{a..c}` brace expansion inside one word. */
const BRACE_RE = /\{([^{}\s]*(?:,|\.\.)[^{}\s]*)\}/;
/** `{rm,x}` → rm, x; `r{m,x}` → rm, rx; `{q..s}m` → qm, rm, sm (single-character ranges). Capped at 64 words. */
function braceAlternatives(word: string): string[] {
  let out = [word];
  for (let pass = 0; pass < 4; pass++) {
    const next = out.flatMap((w) => {
      const m = BRACE_RE.exec(w);
      if (!m) return [w];
      const range = /^(.)\.\.(.)$/.exec(m[1]!);
      const items = range
        ? Array.from({ length: Math.min(64, Math.abs(range[2]!.charCodeAt(0) - range[1]!.charCodeAt(0)) + 1) }, (_, k) =>
            String.fromCharCode(Math.min(range[1]!.charCodeAt(0), range[2]!.charCodeAt(0)) + k))
        : m[1]!.split(",");
      return items.map((a) => w.slice(0, m.index) + a + w.slice(m.index + m[0].length));
    });
    if (next.length === out.length && next.every((w, k) => w === out[k])) break;
    out = next.slice(0, 64);
  }
  return out;
}
/**
 * audit R2 W1/W2: every word bash may run as the command of `text` (normalized by
 * normalizeShellText): through RUN_WRAPPERS with their arity, each alternative of a
 * `{a,b}` brace word (deny if any is denied), and a shell's `-c` string. Additive:
 * the deny loop checks these as well as the first token and effectiveBaseCommand.
 */
export function commandWords(text: string, depth = 0): string[] {
  const tokens = spaceRedirections(text.trim()).split(/\s+/).filter(Boolean);
  const inner = (from: number, head = ""): string[] =>
    depth < 4 ? commandWords([head, ...tokens.slice(from)].join(" "), depth + 1) : [];
  let i = 0;
  while (i < tokens.length) {
    const raw = tokens[i]!.replace(/^\(+/, "");
    if (BRACE_RE.test(raw)) {
      return braceAlternatives(raw).map((a) => a.replace(/^[({]+/, "").replace(/[)}]+$/, "").replace(/^.*\//, ""));
    }
    const t = (tokens[i] = raw.replace(/^[({]+/, "").replace(/[)}]+$/, ""));
    if (!t || /^[A-Za-z_]\w*=/.test(t)) { i++; continue; }
    if (REDIRECTION_RE.test(t)) { i += redirectionSpan(tokens, i); continue; }
    const base = t.replace(/^.*\//, "");
    const w = RUN_WRAPPERS.get(base);
    if (w) {
      i++;
      let positionals = w.positionals ?? 0;
      while (i < tokens.length) {
        const a = tokens[i]!;
        if (/^-./.test(a)) {
          const flag = a.replace(/=[\s\S]*$/, "");
          if (w.command?.includes(flag)) return inner(i + 1, a.includes("=") ? a.slice(a.indexOf("=") + 1) : "");
          i += w.values?.includes(a) ? 2 : 1; // a joined value (`-c3`, `--signal=KILL`) is one token
        } else if (/^[A-Za-z_]\w*=/.test(a)) {
          i++; // `env VAR=x`
        } else if (positionals > 0) {
          positionals--;
          i++;
        } else if (/^\d+(?:\.\d+)?[smhd]?$/.test(a)) {
          i++;
        } else {
          break;
        }
      }
      continue;
    }
    if (C_SHELLS.has(base)) {
      for (let k = i + 1; k < tokens.length && /^[-+]/.test(tokens[k]!); k++) {
        if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(tokens[k]!)) return [base, ...inner(k + 1)];
        if (/^[-+][oO]$/.test(tokens[k]!)) k++;
      }
    }
    return [base];
  }
  return [];
}
/** audit R2 W1: `$X` / `${X…}` as the whole command word. */
const BARE_VAR_WORD_RE = /^["']?\$(?:([A-Za-z_]\w*)|\{([A-Za-z_]\w*)[^}]*\}?)["']?$/; // the walkers strip a closing `}`

/** Patterns checked against the full command string. */
/** `word` with quotes/backslashes allowed between its letters (`pro''ject`). */
const quotedWord = (w: string): string => w.split("").join(`[\\\\'"]*`);
/** As quotedWord, and each letter may be a glob (`*`, `?`, `[…]`): `c*eate`, `rec?rd`. */
const globbedWord = (w: string): string =>
  w.split("").map((c) => `(?:${c}|[*?]|\\[[^\\]]*\\])`).join(`[\\\\'"]*`);

/** A bash/sh flag that still executes: not a `-n` (noexec) cluster without `i` — `bash -n x.sh` only parses (R2 decline). */
const SHELL_EXEC_FLAG = `-(?![a-hj-zA-Z]*n[a-hj-zA-Z]*\\s)\\S+`;
/** Command position: start, a separator or `$(`, then `VAR=x` prefixes and wrappers/interpreters with their flags. */
const CMD_POSITION =
  `(?:^|[;&|(\`\\n]|\\$\\()\\s*(?:\\w+=\\S*\\s+)*(?:(?:(?:sudo|nohup|exec|env|time|timeout\\s+\\S+|source|\\.)\\s+(?:-\\S+\\s+|\\w+=\\S*\\s+)*)|(?:(?:bash|sh)\\s+(?:${SHELL_EXEC_FLAG}\\s+)*))*`;
/** A `/` as bash resolves it: `//` and `/./` too, with quotes/backslashes around it. */
const PATH_SEP = `[\\\\'"]*\\/+(?:\\.\\/+)*[\\\\'"]*`;
const DEPLOY_SH = `${globbedWord("deploy")}[\\\\'"]*\\.[\\\\'"]*${quotedWord("sh")}(?![\\w.-])`;

/** mc-ctl subcommands that write or call a gated script — twin of GATED_SUBCOMMANDS (scripts/lib/operator-gate.sh). */
const MC_CTL_RW = [
  "start", "stop", "restart", "cancel", "schedule-delete", "schedule-resume", "hindsight-restart",
  "audit-claim", "jme-dedup", "briefing-gate", "v83-gate", "v83-promote", "rule-of-two",
  "project-create", "judgments", "close-phase", "resume", "task-resume", "audit-closure", "smoke",
  "skills backfill-embeddings", "skills retrieve", "skills certify", "skills archive", "skills revert",
  "jme-preferences --confirm", "jme-preferences --reject",
  "events retrieve", "events aggregate", "events seed",
  "cohort rollup", "gates set-ritual",
  "mcp-token create", "mcp-token revoke",
  "monitoring up", "monitoring down",
];

const MC_CTL_DENY_REASON =
  "operator-only: mc-ctl RW subcommands and mission-control's scripts/deploy.sh run from the operator terminal, never from a task (read-only mc-ctl subcommands stay open)";
/** Whether the bash glob `glob` (`*`, `?`, `[…]`, `[!…]`) matches `word`: a linear DP, no regex backtracking. */
function globMatches(glob: string, word: string): boolean {
  const parts = glob.match(/\[!?\]?[^\]]*\]|[\s\S]/g) ?? [];
  let row = [true, ...Array<boolean>(word.length).fill(false)];
  for (const p of parts) {
    const next = Array<boolean>(word.length + 1).fill(false);
    if (p === "*") next[0] = row[0]!;
    for (let j = 1; j <= word.length; j++) {
      const c = word[j - 1]!;
      if (p === "*") next[j] = row[j]! || next[j - 1]!;
      else if (row[j - 1]) {
        if (p === "?") next[j] = true;
        else if (p.length > 1) {
          const neg = /^\[!/.test(p);
          const body = p.slice(neg ? 2 : 1, -1);
          const inClass = [...body.matchAll(/(.)-(.)|(.)/g)].some((m) => (m[3] !== undefined ? m[3] === c : m[1]! <= c && c <= m[2]!));
          next[j] = inClass !== neg;
        } else next[j] = p === c;
      }
    }
    row = next;
  }
  return row[word.length]!;
}
/** audit R2 W4: an `mc-ctl` word followed by an MC_CTL_RW entry, as bash reads them (normalized, globs expanded). */
function mcCtlGlobDenied(normalized: string): boolean {
  const words = normalized.split(/\s+/).filter(Boolean).flatMap(braceAlternatives); // `{./mc-ctl,restart}`
  return words.some(
    (w, k) =>
      globMatches(w.replace(/^.*\//, ""), "mc-ctl") &&
      MC_CTL_RW.some((e) => e.split(" ").every((part, n) => words[k + 1 + n] !== undefined && globMatches(words[k + 1 + n]!, part))),
  );
}

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
    // string, or a shell metacharacter `; | & ( ) < >` — the same set that
    // ends a captureWriteTargets word) so adversarial suffixes like
    // `/dev/null.bak` or `/dev/null/foo` still hit the deny path with a clear
    // reason, while `(cmd >/dev/null)` is the discard it reads as.
    pattern:
      />\|?\s*\/(?:etc|boot|usr|proc|sys)\/|>\|?\s*\/dev\/(?!(?:null|stderr|stdout)(?:[\s;|&()<>]|$))/, // `>|` too (qa R14 C14-4)
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
  // S6 ruling 5a audit R1 C1: creating a project or re-pointing a live record
  // (aliases = routing cues, kb_readme = injected text) is operator-only.
  {
    // Tolerant of trivial obfuscation (`\-`, `''`, one glob char per letter);
    // a cheap layer only — the structural gate is the scripts' operator-session
    // check (src/lib/operator-gate.ts).
    pattern: new RegExp(
      `${quotedWord("project")}[^a-z]*${globbedWord("record")}|mc-ctl\\W+${quotedWord("project")}[^a-z]*${globbedWord("create")}`,
    ),
    reason:
      "project record create/export is operator-only (mc-ctl project-create / scripts/project-record-*.ts run from the operator terminal)",
  },
  // S6 ruling 5a audit R3: a task typing into the operator's terminal
  // multiplexer would pass the operator-session gate.
  {
    pattern: /\btmux\b.*\b(?:send-keys|paste-buffer|load-buffer|run-shell)\b|\bscreen\b.*\s-X\b/,
    reason: "multiplexer keystroke injection blocked — it types into another session's terminal",
  },
  // S6 item 3c: mc-ctl RW subcommands (twin of GATED_SUBCOMMANDS in
  // scripts/lib/operator-gate.sh, pinned by operator-gate.lock.test.ts), mc-ctl
  // fed its subcommand by xargs, and a `scripts/deploy.sh` (any checkout, by
  // path tail; `./deploy.sh` after a `cd …scripts`) in command position. A
  // cheap layer only — the structural gate is the operator-context check in
  // mc-ctl, deploy.sh and every db/KB-writing script. Read-only subcommands stay open.
  {
    pattern: new RegExp(
      `${globbedWord("mc-ctl")}[\\s'"\\\\]+(?:${MC_CTL_RW.map((e) => e.split(" ").map(globbedWord).join(`[\\s'"\\\\]+`)).join("|")})(?![\\w-])` +
        `|\\bxargs\\b[^|;&\\n]*${globbedWord("mc-ctl")}` +
        `|${CMD_POSITION}\\S*${quotedWord("scripts")}${PATH_SEP}${DEPLOY_SH}` +
        `|^(?=[\\s\\S]*\\b(?:cd|pushd)\\s+\\S*${quotedWord("scripts")}\\/*(?:[\\s;&|)]|$))[\\s\\S]*?${CMD_POSITION}(?:\\.${PATH_SEP})?${DEPLOY_SH}`,
    ),
    reason: MC_CTL_DENY_REASON,
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
/** Linux MAX_ARG_STRLEN (32 pages): the longest `sh -c` argument execve takes. */
const MAX_COMMAND_BYTES = 131_072;

const SECRET_PATH_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\/root\/\.claude\/\.credentials\.json\b/, reason: "credentials.json is off-limits to the shell" },
  { pattern: /\/root\/\.ssh(?:\/|\b)/, reason: "/root/.ssh is off-limits to the shell" },
  { pattern: /\/root\/\.(?:gnupg|aws|docker|kube|config\/gh|config\/gcloud)\b/, reason: "secret dotfile directory is off-limits to the shell" },
  { pattern: /\/etc\/(?:shadow|gshadow|sudoers|ssh)\b/, reason: "system secret is off-limits to the shell" },
  { pattern: /\/proc\/(?:self|\d+)\/(?:environ|mem)\b/, reason: "/proc/<pid>/environ and mem are off-limits to the shell" },
  // Any spelling of a process env under /proc — glob (`/proc/*/environ`), thread-self, task/<tid> (audit 2026-09-22).
  { pattern: /\/proc\/(?:(?!\/proc\/)\S)*environ/, reason: "/proc/<pid>/environ is off-limits to the shell" },
  // Another process's filesystem view (a container's root) — audit 2026-10-01 C1-R2.
  { pattern: /\/proc\/[^\s/]+\/(?:task\/[^\s/]+\/)?(?:root|cwd)\//, reason: "/proc/<pid>/root and cwd are off-limits to the shell as a path prefix" },
  { pattern: /\/root\/(?:\.npmrc|\.netrc|\.pgpass|\.gitconfig|\.git-credentials|\.hapi\.yaml|\.claude\.json)\b/, reason: "dotfile credential is off-limits to the shell" },
  // Key material and backup copies an upload could ship off the box (Hermes PR #107609 review, 2026-10-01).
  { pattern: /\/root\/claude\/Pulso-Aura-Upfront\/store\/(?:auth(?![\w-])|messages\.db)/, reason: "Pulso's WhatsApp session keys and message store are off-limits to the shell" }, // auth-status.txt stays readable
  { pattern: /\/var\/lib\/stalwart\/\S/, reason: "the mail store is off-limits to the shell" }, // the bare directory stays usable (`du -sh`)
  { pattern: /\/var\/lib\/caddy\/(?:(?!\/var\/lib\/caddy\/)\S)*\.key\b/, reason: "Caddy TLS private keys are off-limits to the shell" },
  // /root/.claude/ is default-deny, as in the read guard: only the docs and projects/*/memory continue (no `..`).
  // The bare directory too — `grep -r`/`find`/`tar` on it read every store.
  { pattern: /\/root\/\.claude(?:(?![\w.\/-])|\/(?:(?!(?:(?:CLAUDE|NOW)\.md|rules|agents|global-memory)(?![\w.-])|projects\/[^\s/]+\/memory(?![\w.-]))|(?:(?!\/root\/\.claude(?![\w.-]))\S)*\/\.\.(?![^\s/])))/, reason: "/root/.claude/ (transcripts, saved prompts, session keys) is off-limits to the shell outside its docs and memory" },
  { pattern: /\/var\/lib\/docker\/\S/, reason: "Docker volumes and container filesystems are off-limits to the shell" }, // `du -sh /var/lib/docker` stays usable
  { pattern: /\/var\/lib\/containerd\/\S/, reason: "containerd snapshots (container filesystems) are off-limits to the shell" }, // the bare directory stays usable (`du -sh`)
  { pattern: /\/run\/containerd\/\S/, reason: "mounted container root filesystems are off-limits to the shell" }, // the bare directory stays usable (`ls`)
  // The Docker API socket answers every verb the docker gate refuses (`curl --unix-socket … /containers/create`) — ruling 5, 2026-10-01.
  { pattern: /\/run\/docker\.sock\b/, reason: "the Docker API socket is off-limits to the shell (container file access and new containers are operator-only)" },
  { pattern: /\/root\/(?:claude-)?backups\/\S/, reason: "backup copies are off-limits to the shell" }, // the bare directory stays listable (`ls`/`du`)
  // vps_backup's `mc.db.<ts>` and backup-db.sh's `mc-<date>.db` copies; relative by those names only, like
  // `data/mc.db` below (the shell's default cwd IS mission-control) — another repo's `backups/` stays usable.
  { pattern: /\/root\/claude\/mission-control\/backups\/\S|(?<![\w/.-])(?:\.\/)?backups\/mc(?:\.db|-)/, reason: "backup copies are off-limits to the shell" },
  { pattern: /\/opt\/supabase\/backups\/\S/, reason: "backup copies are off-limits to the shell" }, // pg_dumps + state bundles (mc.db, .env)
  { pattern: /\/root\/claude\/Pulso-Aura-Upfront\/data\/backups\/\S/, reason: "backup copies are off-limits to the shell" }, // crm.db + messages.db copies
  // benchmark-{sonnet,opus}-tier.ts and grade-benchmark.ts full mc.db copies; relative like `data/mc.db` below.
  { pattern: /\/root\/claude\/mission-control\/data\/(?:sonnet|opus|grade)-bench\/\S|(?<![\w/.])(?:\.\/)?data\/(?:sonnet|opus|grade)-bench\/\S/, reason: "benchmark mc.db snapshots are off-limits to the shell" },
  { pattern: /\/root\/claude\/mission-control\/data\/mc\.db/, reason: "mc.db (memories) is off-limits to the shell — all DB access goes through tools" },
  { pattern: /(?<![\w/.])(?:\.\/)?data\/mc\.db\b/, reason: "mc.db (memories) is off-limits to the shell — all DB access goes through tools" }, // `./data/mc.db` too (qa R14 W14-2); `../data/mc.db` is another file (qa R15 W15-2)
  { pattern: /\/opt\/supabase\/volumes\/api\/kong\.yml\b/, reason: "kong.yml (Supabase keys) is off-limits to the shell" },
];

/** `.env`-shaped filenames: absolute, `~`/`$HOME`-headed, or a standalone
 *  bare `.env` (the shell's default cwd IS mission-control). Same allow-by-
 *  membership rule as file_read (isBlockedEnvFile). A regex-escaped `\.env`
 *  is a pattern, not a path. */
const ENV_ABS_RE = /(?<![\w.\\-])(\/(?:[\w.\/-]*\/)?\.env(?:[._-][\w.-]+)?)(?!\w)/g;
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
    .replace(/(?<![\w/])~(?=\/)/g, "/root")
    // `//` and `/./` name the same path (`/root//.ssh`); `/../` is left alone.
    .replace(/\/(?:\.?\/)+/g, "/");
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

/** A `.env`, `.env.*` or `*.env` file as a WRITE target. The read allowlist (ENV_READ_ALLOWLIST) covers
 *  reads only; the file tools refuse every `.env*` write (DANGEROUS_FILE_PREFIXES), and so does the shell. */
const isEnvWriteTarget = (p: string): boolean => /^\.env|\.env$/.test(p.replace(/\/+$/, "").split("/").pop() ?? "");
/** Verbs whose every file argument is written, moved or hard-linked (`ln x.env /tmp/y` makes /tmp/y the same inode). */
const ENV_WRITE_ANY_ARG = new Set(["tee", "mv", "ln"]);
/** Verbs whose LAST positional is the destination; their sources are reads. */
const ENV_WRITE_DEST_ARG = new Set(["cp", "install", "rsync"]);
/** The `.env`-shaped file `segment` (normalized) writes: a redirection target, a tee/mv/ln argument, a
 *  cp/install/rsync destination, a `sed -i`/`perl -i` file, or `dd of=`. Null when it writes none. */
function envWriteTarget(segment: string): string | null {
  const tokens = spaceRedirections(segment).split(/\s+/).filter(Boolean);
  for (let k = 0; k < tokens.length; k++) {
    const op = /^(?:\d*|&)(?:>>?|<>)[|&]?/.exec(tokens[k]!)?.[0];
    if (op === undefined) continue;
    const target = tokens[k]!.slice(op.length) || tokens[k + 1] || "";
    if (isEnvWriteTarget(target)) return target;
  }
  const verb = effectiveBaseCommand(segment, true);
  const at = tokens.findIndex((t) => t.replace(/^.*\//, "") === verb);
  const args = at === -1 ? [] : tokens.slice(at + 1).filter((t) => !REDIRECTION_RE.test(t));
  const positionals = args.filter((t) => !t.startsWith("-"));
  let written: string[] = [];
  if (ENV_WRITE_ANY_ARG.has(verb)) written = positionals;
  else if (ENV_WRITE_DEST_ARG.has(verb)) written = positionals.slice(-1);
  else if (/^(?:sed|perl)$/.test(verb) && args.some((t) => /^-(?:[a-zA-Z]*i|-in-place)/.test(t))) written = positionals;
  else if (verb === "dd") written = args.filter((t) => t.startsWith("of=")).map((t) => t.slice(3));
  return written.find(isEnvWriteTarget) ?? null;
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
 *  These match captureWriteTargets' shape (`>` redirect to absolute path) but
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
    // S6 WS1 (R1-C1): a project record (`projects/<slug>/project.md`) is the
    // project's contract and the hourly kb-reindex projects it onto the row,
    // so a shell write there is a door around project_update and its refusals.
    // Denied: the record itself, the `projects/<slug>` folder and the
    // `projects` dir (a cp/mv INTO either lands a record). Same basename-bound
    // residuals as directives/ above (relative writes after a `cd`). The
    // tail is a negative path-char class (R2 W1), so a glued redirection
    // (`project.md>/dev/null`, `project.md</tmp/x`) is still denied. The
    // `<slug>` segment also matches a FILE directly under `projects/`
    // (`projects/notes.md`), so writes there are denied too (none exist today).
    pattern: /\/jarvis-kb\/projects(?:\/[^/\s]+(?:\/project\.md)?)?\/?(?![\w./-])/i,
    reason:
      "jarvis-kb/projects/<slug>/project.md is the project's record — change a project with project_update",
  },
  {
    pattern: /\/root\/claude\/mission-control\//,
    reason: "Jarvis cannot modify its own source code via shell_exec",
    // Dynamic override: allowed on jarvis/* branches (checked at runtime)
  } as { pattern: RegExp; reason: string },
];

/** Shell operators at the start of an unquoted token, longest spelling first. */
const SHELL_OPERATOR = /&>>|&>|>>|>&|>\||<<<|<<-|<<|<>|<&|>|<|&&|\|\||\|&|[;|&()]/y;
/** Redirections that open their word for writing (`<>` is a read-write open, which creates the file). */
const WRITE_REDIRECTIONS = new Set([">", ">|", ">>", ">&", "&>", "&>>", "<>"]);
/** Operators that end a simple command. */
const COMMAND_SEPARATORS = new Set([";", "|", "&", "(", ")", "&&", "||", "|&"]);
/** Verbs whose arguments are written (tee: every file; mv/cp/scp: the destination). */
const WRITE_VERBS = new Set(["tee", "mv", "cp", "scp"]);
/** Shell binaries: one anywhere in a command may run any text the command produces. */
const SHELL_BINARIES = new Set(["sh", "bash", "dash", "zsh", "ksh", "ash", "rbash", "static-sh", "busybox"]);
/** Builtins that run text as commands; they count in command position only. */
const SHELL_BUILTINS = new Set(["eval", "source", "."]);
/** Shells whose quoting is bash's (`$'…'`): text they run is lexed under re-entry rules. */
const BASH_DIALECT_SHELLS = new Set(["bash", "zsh", "ksh", "rbash"]);
/** Words after which the next word is still in command position. */
const COMMAND_PREFIXES = new Set(["exec", "env", "sudo", "timeout", "nice", "nohup", "xargs", "command", "time", "{", "!", "if", "then", "do", "else", "elif", "while", "until"]);
/** Text judged as commands (a heredoc body, a quoted string) is nested at most this deep. */
const MAX_TEXT_DEPTH = 4;
/** A flat brace group with more alternatives than this is not judged. */
const MAX_BRACE_ALTERNATIVES = 64;
const PROCESS_SUBSTITUTION_REASON = "process substitution <() or >() is blocked";

/** A file a command writes: the word as spelled (`raw`), its value after quote
 *  removal (`value`, what is judged) and whether the write appends (`>>`, `&>>`,
 *  `tee -a`); or, with `refuse`, why the command is refused without judging. */
type WriteTarget = { raw: string; value: string; isAppend: boolean; refuse?: string };
/** A shell word: as spelled, after quote removal, with every quoted or escaped character as NUL,
 *  and whether any part of it was quoted or escaped. */
type ShellWord = { raw: string; value: string; bare: string; quoted: boolean };

/**
 * The words a brace expansion of `w` produces when bash expands it: `w` itself
 * (no unquoted `{…,…}` / `{…..…}` group), the alternatives of ONE flat comma
 * group (`x{,.bak}`, `{a,b}`), or undefined when the expansion is not judged
 * (a sequence group, a `$` inside the group, two groups — so any nesting —,
 * more than MAX_BRACE_ALTERNATIVES alternatives). `${…}` is not a group; a
 * literal `{x}` around a group stays literal. Linear in the word.
 */
function braceExpansion(w: ShellWord): ShellWord[] | undefined {
  type Frame = { open: number; param: boolean; commas: number[]; dots: boolean; dollar: boolean };
  const stack: Frame[] = [];
  const groups: { open: number; close: number; commas: number[] }[] = [];
  let judged = true;
  const { bare, value } = w;
  for (let k = 0; k < bare.length; k++) {
    const ch = bare[k];
    const top = stack[stack.length - 1];
    if (ch === "{") stack.push({ open: k, param: bare[k - 1] === "$", commas: [], dots: false, dollar: false });
    else if (!top) continue;
    else if (ch === ",") top.commas.push(k);
    else if (ch === "." && bare[k + 1] === ".") top.dots = true;
    else if (ch === "$") top.dollar = true;
    else if (ch === "}") {
      stack.pop();
      if (top.param || (top.commas.length === 0 && !top.dots)) continue;
      if (top.dollar || top.commas.length === 0) judged = false; // a `$` inside, or a sequence
      groups.push({ open: top.open, close: k, commas: top.commas });
    }
  }
  if (groups.length === 0) return [w];
  const g = groups[0]!;
  if (!judged || groups.length > 1 || g.commas.length >= MAX_BRACE_ALTERNATIVES) return undefined;
  const cuts = [g.open, ...g.commas, g.close];
  const head = value.slice(0, g.open);
  const tail = value.slice(g.close + 1);
  return cuts.slice(1).map((cut, k) => ({ raw: w.raw, value: head + value.slice(cuts[k]! + 1, cut) + tail, bare: "", quoted: w.quoted }));
}

/**
 * Every file `s` writes through a redirection or a tee/mv/cp/scp verb, as
 * `/bin/sh` reads it. shell_exec runs `/bin/sh -c`, which is dash (POSIX sh),
 * so the dialect modelled is dash; bash rules apply only through re-entry
 * (`bash -c "…"`, text a bash/zsh/ksh word may run), where `opts.reentry` is set.
 *
 * One left-to-right pass splits `s` into words and unquoted operators. A quote
 * (`'…'`, `"…"`) or a backslash escape keeps its characters in the word, so a
 * `>` or a verb inside a quoted span is text (`echo '>/tmp/a"' >/root/.bashrc
 * "'"` writes `/root/.bashrc`, audit R1 C1; `\>>LOG` is text `>` then an
 * overwrite, audit R2 W1). Each word is unquoted once: single quotes are
 * literal; double quotes keep `\"`, `\\`, `\$`, `` \` `` as escapes; `\x`
 * outside quotes is `x`; `\`+newline is nothing. dash has no `$'…'` / `$"…"`:
 * `$'\x2f'` is `$` and a plain single-quoted string. Under bash re-entry those
 * two forms read differently, and a word holding one is refused. An unterminated
 * quote runs to the end (dash refuses that line). A `#` at the start of a word
 * comments out the rest of the line. `$(` and backticks are refused before the
 * write scan, so a quoted run hides no command.
 *
 * A here-document body runs from the newline that ends its opener line to the
 * line that is its delimiter (`<<-`: after leading tabs), or to the end of `s`
 * (dash closes it there and runs the command); the opener line is scanned as
 * usual. The body is lexed as its own text, so a quote in it never reaches the
 * outer command (audit R2 C2). Any receiver can run a body (`| sh`, `| $SHELL`,
 * a file later run by `sh`), so an UNQUOTED body (`<<EOF`, `<<-EOF`) is always
 * judged as commands (audit R3 C1/C2). A QUOTED body (`<<'EOF'`, `<<"EOF"`,
 * `<<\EOF`) and a quoted word are data, unless a shell word is in the command
 * (`sh`, `bash`, `busybox` anywhere unquoted, or `eval` / `source` / `.` / a
 * quoted shell name as a command): then each of them, and each simple command's
 * words joined, is judged as commands too (audit R3 C3: `printf 'cp a /x' | sh`).
 * A command name from a variable (`| $SHELL`, `$0`) is refused. Judged text is
 * lexed with dash rules, or bash's when the shell word is bash/zsh/ksh/rbash,
 * nested at most MAX_TEXT_DEPTH deep. Linear in the length of `s` per depth.
 */
function captureWriteTargets(s: string, opts: { reentry?: boolean; depth?: number; shell?: boolean; quotedText?: boolean } = {}): WriteTarget[] {
  type Token = ShellWord | { op: string };
  const tokens: Token[] = [];
  const out: WriteTarget[] = [];
  const refuse = (raw: string, reason: string): void => {
    out.push({ raw, value: "", isAppend: false, refuse: reason });
  };
  const heredocs: { delim: string; tabs: boolean; quoted: boolean }[] = [];
  const bodies: { text: string; quoted: boolean }[] = [];
  let delimTabs: boolean | undefined; // set by `<<` / `<<-`: the next word is a heredoc delimiter
  // Text judged as commands (a body or a string a shell runs): an unquoted substitution in it runs before
  // any path exists to judge, so it is refused here with the outer check's reasons (3q R4 C1). One in
  // double quotes is refused one level down, where the shell-word rule judges the quoted string itself.
  const commandText = (opts.depth ?? 0) >= 1;
  const substitution = (j: number): void => {
    if (!commandText) return;
    if (s[j] === "`") refuse("`", "backtick substitution is blocked");
    else if (s[j] === "$" && s[j + 1] === "(" && s[j + 2] !== "(") refuse("$(", "command substitution $(...) is blocked");
  };
  const n = s.length;
  let i = 0;
  while (i < n) {
    const c = s[i]!;
    SHELL_OPERATOR.lastIndex = i;
    const op = SHELL_OPERATOR.exec(s)?.[0];
    if (c === " " || c === "\t") i++;
    else if (c === "\\" && s[i + 1] === "\n") i += 2;
    else if (c === "\n") {
      tokens.push({ op: ";" });
      i++;
      for (const h of heredocs) {
        const start = i;
        let end = n;
        while (i < n) {
          const nl = s.indexOf("\n", i);
          const line = s.slice(i, nl < 0 ? n : nl);
          const atDelim = (h.tabs ? line.replace(/^\t+/, "") : line) === h.delim;
          if (atDelim) end = i;
          i = nl < 0 ? n : nl + 1;
          if (atDelim) break;
        }
        bodies.push({ text: s.slice(start, end), quoted: h.quoted });
      }
      heredocs.length = 0;
      delimTabs = undefined;
    } else if (c === "#") while (i < n && s[i] !== "\n") i++; // a comment: `#` at the start of a word
    else if (op !== undefined) {
      tokens.push({ op });
      i += op.length;
      delimTabs = op === "<<-" ? true : op === "<<" ? false : undefined;
      // `<(…)` / `>(…)` glued to a word (`a<(cat)`, `''<(cat)`): dash rejects it, bash re-entry would run it.
      if (/[<>]$/.test(op) && s[i] === "(") refuse(`${op}(`, PROCESS_SUBSTITUTION_REASON);
    } else {
      // A word. `bare` mirrors its value with every quoted or escaped character replaced by NUL.
      const start = i;
      let value = "";
      let bare = "";
      let quoted = false;
      let dollarQuote = false;
      while (i < n && !" \t\n;|&()<>".includes(s[i]!)) {
        const ch = s[i]!;
        if (ch === "\\") {
          if (s[i + 1] !== "\n" && i + 1 < n) {
            value += s[i + 1];
            bare += "\0";
          }
          quoted = true;
          i += 2;
        } else if (ch === "'") {
          const close = s.indexOf("'", i + 1);
          const end = close < 0 ? n : close;
          value += s.slice(i + 1, end);
          bare += "\0".repeat(end - i - 1);
          quoted = true;
          i = end + 1;
        } else if (ch === '"') {
          let j = i + 1;
          for (; j < n && s[j] !== '"'; j++) {
            if (s[j] === "\\" && s[j + 1] === "\n") j++;
            else if (s[j] === "\\" && '\\"$`'.includes(s[j + 1] ?? "x")) value += s[++j];
            else value += s[j];
            bare += "\0";
          }
          quoted = true;
          i = j + 1;
        } else if (ch === "$" && s[i + 1] === "(" && s[i + 2] === "(") {
          // `$((3*4))` is one word: its `(`, `)` and `*` are not operators or a command name.
          let j = i + 1;
          for (let open = 0; j < n; j++) {
            substitution(j);
            if (s[j] === "(") open++;
            else if (s[j] === ")" && --open === 0) break;
          }
          value += s.slice(i, j + 1);
          bare += s.slice(i, j + 1);
          i = j + 1;
        } else {
          dollarQuote ||= ch === "$" && (s[i + 1] === "'" || s[i + 1] === '"');
          substitution(i);
          value += ch;
          bare += ch;
          i++;
        }
      }
      const raw = s.slice(start, Math.min(i, n));
      if (opts.reentry && dollarQuote) refuse(raw, `ANSI-C/locale quoting is not judged under bash re-entry: ${raw}`);
      if (delimTabs !== undefined) heredocs.push({ delim: value, tabs: delimTabs, quoted });
      delimTabs = undefined;
      tokens.push({ raw, value, bare, quoted });
    }
  }

  // A judged word: every word its brace expansion produces; an expansion that is not judged is
  // refused when it can produce an absolute path (`/…`, `{…`); a relative one stays relative.
  const judge = (w: ShellWord, isAppend: boolean): void => {
    const alts = braceExpansion(w);
    if (!alts) {
      if (/^[/{]/.test(w.value)) refuse(w.raw, `brace expansion in a write target is not judged: ${w.raw}`);
      return;
    }
    for (const a of alts) if (a.value.startsWith("/")) out.push({ raw: a.raw, value: a.value, isAppend });
  };
  // The arguments of one simple command (redirections and their words removed). The first word whose
  // value, without a directory, is a verb opens the scan, anywhere in the command (`sudo cp`, `xargs
  // cp`, `"cp"`, `c\p`, `/bin/cp`); later verb words are plain arguments, so the scan stays linear.
  const judgeCommand = (words: ShellWord[]): void => {
    const at = words.findIndex((w) => WRITE_VERBS.has(w.value.replace(/^.*\//, "")));
    if (at < 0) return;
    const op = words[at]!.value.replace(/^.*\//, "");
    // Brace expansion runs before the verb reads its arguments: `cp {a,b} DIR` copies into DIR.
    const args: ShellWord[] = [];
    for (const w of words.slice(at + 1)) {
      const alts = braceExpansion(w);
      if (alts) args.push(...alts);
      else if (/^[/{]/.test(w.value)) refuse(w.raw, `brace expansion in a write target is not judged: ${w.raw}`);
      else args.push(w);
    }
    let isAppend = false;
    let optsDone = false;
    let pendingDir = false;
    let pendingValue = false;
    const dirs: ShellWord[] = [];
    const files: ShellWord[] = [];
    for (const w of args) {
      const v = w.value;
      if (pendingDir) {
        dirs.push(w);
        pendingDir = false;
      } else if (pendingValue) pendingValue = false;
      else if (optsDone || v[0] !== "-" || v === "-") files.push(w);
      else if (v === "--") optsDone = true;
      else if (op === "tee") isAppend ||= /^(?:-\w*a\w*|--append)$/.test(v);
      else if (op === "scp") {
        // `-P port`, `-i file`, `-o opt`, …: a value option last in its cluster takes the next word.
        const k = v.slice(1).search(/[cFiJloPSX]/);
        pendingValue = k >= 0 && k === v.length - 2;
      } else {
        // mv/cp `-t DIR`, `-rtDIR`, `--target-directory[=DIR]` or any prefix of it (`--target=DIR`).
        // `-S SUFFIX` takes the rest of its cluster or the next word: the `t` in `-S.out` is no `-t`.
        const long = /^--([\w-]+)(?:=([\s\S]*))?$/.exec(v);
        const short = long ? null : /^-[^-]*?([tS])([\s\S]*)$/.exec(v);
        if (short?.[1] === "S") pendingValue = !short[2];
        else if (long ? "target-directory".startsWith(long[1]!) : short) {
          const glued = long ? long[2] : short![2] || undefined;
          if (glued === undefined) pendingDir = true;
          else dirs.push({ ...w, value: glued });
        }
      }
    }
    // tee writes every file. mv/cp/scp write the `-t` directory and the destination, which is never
    // the first file and not always the last (`find -exec cp {} DIR \;`), so every later file is
    // judged; a remote scp word (`host:/x`) does not start with `/` and is not.
    for (const w of op === "tee" ? files : [...dirs, ...files.slice(1)]) {
      if (w.value.startsWith("/")) out.push({ raw: w.raw, value: w.value, isAppend });
    }
  };

  // Shell words in one simple command, its command name from a variable, and its quoted text.
  let shell = opts.shell === true;
  let bashDialect = opts.reentry === true;
  const texts: string[] = [];
  const scanCommand = (words: ShellWord[]): void => {
    let at = 0;
    for (;;) {
      while (at < words.length && /^[A-Za-z_]\w*=/.test(words[at]!.value)) at++; // `X=1 cmd`
      const prefix = words[at]?.value.replace(/^.*\//, "");
      if (prefix === undefined || !COMMAND_PREFIXES.has(prefix)) break;
      at++;
      while (at < words.length && words[at]!.value.startsWith("-")) at++; // `sudo -n`, `nice -n 5`
      if (prefix === "timeout" && at < words.length) at++; // its duration
    }
    words.forEach((w, k) => {
      const base = w.value.replace(/^.*\//, "");
      if ((SHELL_BINARIES.has(base) && (!w.quoted || k === at)) || (k === at && SHELL_BUILTINS.has(base))) {
        shell = true;
        bashDialect ||= BASH_DIALECT_SHELLS.has(base);
      }
    });
    // `$SHELL`, `"$0"`, `${X:-sh}`, `${X}rontab`: the variable picks the command. `$HOME/bin/tool` only picks a
    // directory. Not in a quoted string read as commands: `echo "$x" | sh` is an over-approximation already.
    const name = words[at];
    if (!opts.quotedText && name?.value.startsWith("$")) {
      const variable = /^\$(?:\{[^}]*\}|\w+|[#?$!@*-])/.exec(name.value)?.[0];
      if (!variable || !name.value.startsWith("/", variable.length)) {
        refuse(name.raw, `command name from a variable is not judged: ${name.raw}`);
      }
    }
    // `/bin/s?`, `/usr/bin/ba*h`: an unquoted glob picks the command the same way (no glob parser). `[` is test.
    if (!opts.quotedText && name && /[?*[]/.test(name.bare) && name.value !== "[" && name.value !== "[[") {
      refuse(name.raw, `command name from a glob is not judged: ${name.raw}`);
    }
    if (!words.some((w) => w.quoted)) return;
    for (const w of words) if (w.quoted) texts.push(w.value);
    texts.push(words.map((w) => w.value).join(" ")); // `echo "cp a" "/x" | sh` prints one command line
  };

  let words: ShellWord[] = [];
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]!;
    if ("value" in t) words.push(t);
    else if (COMMAND_SEPARATORS.has(t.op)) {
      judgeCommand(words);
      scanCommand(words);
      words = [];
    } else {
      // A redirection consumes the next word. `>&1`, `>&-`, `>&$fd` are dups: their word is not absolute.
      const next = tokens[k + 1];
      if (next && "value" in next) {
        k++;
        if (WRITE_REDIRECTIONS.has(t.op)) judge(next, t.op === ">>" || t.op === "&>>");
      }
    }
  }
  judgeCommand(words);
  scanCommand(words);

  // Text a shell in this command may run: every unquoted heredoc body; with a shell word, every
  // quoted body and quoted text as well. Each is lexed on its own, so its quotes stay inside it.
  const depth = (opts.depth ?? 0) + 1;
  const judgeText = (text: string, quotedText: boolean): void => {
    if (depth > MAX_TEXT_DEPTH) {
      refuse(text.slice(0, 40), `text nested ${depth} deep (a heredoc body or a quoted string) is not judged`);
      return;
    }
    for (const t of captureWriteTargets(text, { reentry: bashDialect, depth, shell, quotedText })) out.push(t);
  };
  for (const b of bodies) if (!b.quoted || shell) judgeText(b.text, opts.quotedText === true);
  if (shell) for (const t of texts) judgeText(t, true);
  return out;
}

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
 *  << 'EOF' ... EOF`. The rest of the opener line (its redirects, pipes, a
 *  `$(`) stays intact; it used to go with the body, so `cat <<'EOF' > /x` hid
 *  its target (3q P1). Unquoted heredocs (`<< EOF`) DO expand vars
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
  // The rest of the opener line (`cat <<'EOF' > /x`, `<<'EOF' | bash`) is
  // shell syntax and is kept; only the body and the delimiter line go.
  const replaceWithQuoteGuard = (input: string, re: RegExp): string =>
    input.replace(re, (match: string, _delim: string, opener: string, offset: number) => {
      const before = input.slice(0, offset);
      if (countOpenDoubleQuotes(before) % 2 === 1) {
        // Inside open "…" — bash sees this as text, not a heredoc.
        return match;
      }
      return `<<HEREDOC_STRIPPED${opener}`;
    });

  let out = replaceWithQuoteGuard(
    command,
    /<<-\s*['"]([^'"\s]+)['"]([^\n]*)\n(?:[\s\S]*?\n)?\t*\1(?=\s|$)/g,
  );
  out = replaceWithQuoteGuard(
    out,
    /<<(?!-)\s*['"]([^'"\s]+)['"]([^\n]*)\n(?:[\s\S]*?\n)?\1(?=\s|$)/g,
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
export const ENV_RESET_WORDS = new Set([
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
function shellVars(scope: string): Map<string, string> {
  const vars = new Map<string, string>([["HOME", process.env.HOME ?? "/root"]]);
  for (const m of scope.matchAll(/(?:^|[\s;&|(])([A-Za-z_]\w*)=([^\s;&|]+)/g)) {
    vars.set(m[1]!, m[2]!.replace(/["'\\]/g, ""));
  }
  return vars;
}
/** `vars`: the assignments in scope — the segment's own by default, the whole command's for the deny-verb check. */
function normalizeShellText(text: string, vars: Map<string, string> = shellVars(text)): string {
  // `$'…'` with its `\xHH`, `\uHHHH`, `\UHHHHHHHH` and `\NNN` (octal) escapes decoded: `$'\x72m'` is rm (audit R2 W1).
  let out = text.replace(/\$'((?:[^'\\]|\\.)*)'/g, (_all, body: string) =>
    body.replace(/\\(?:x([0-9A-Fa-f]{1,2})|u([0-9A-Fa-f]{1,4})|U([0-9A-Fa-f]{1,8})|([0-7]{1,3}))/g, (_e, x?: string, u?: string, U?: string, o?: string) => {
      const n = parseInt(x ?? u ?? U ?? o!, o === undefined ? 16 : 8);
      return n > 0x10ffff ? "" : String.fromCodePoint(n);
    }),
  );
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
 * Docker gate — operator ruling 5, 2026-10-01 ("reads plus psql"). `docker`
 * reaches file content without naming a blocked path (`docker exec <c> cat
 * /app/.env`, `docker cp`, `docker run -v /:/h …`), so no docker verb may read
 * or write container/host files or create a container, except `docker exec
 * supabase-db psql` (with `-e PG*` only, ruling 5b 2026-10-03). Read verbs pass;
 * lifecycle verbs (start/stop/rm/prune/…) stay allowed (ruling 5c 2026-10-03),
 * except `docker volume create` with a bind/device option. Checked inside the flat token
 * walk of checkPackageManagerRaw, so it holds behind the standard wrappers,
 * inside `bash -c`/`eval`/interpreter heredocs and in `npm run` script bodies.
 * At command position (the first word, or behind a wrapper) an unknown verb is
 * refused; elsewhere the word is an argument (`grep docker src`) unless a
 * refused verb follows it — prose like `echo docker run` is refused, the same
 * way the package-manager walk refuses `echo npm install x`.
 */
type DockerClass = "read" | "lifecycle" | "refuse" | "exec";
function dockerVerbs(spec: Partial<Record<DockerClass, string>>): Map<string, DockerClass> {
  const out = new Map<string, DockerClass>();
  for (const [cls, words] of Object.entries(spec)) for (const w of words.split(" ")) out.set(w, cls as DockerClass);
  return out;
}
const DOCKER_VERBS = dockerVerbs({
  read: "ps logs inspect images stats version info top port events history diff search wait help",
  lifecycle: "start stop restart kill rm rmi pause unpause pull tag rename update",
  exec: "exec",
  refuse: "cp run create build bake commit export save import load attach push login logout swarm service stack node secret config checkpoint trust manifest scout sbom init debug",
});
/** Management commands: the SUB-verb decides; an unlisted sub is unknown. */
const DOCKER_BUILDER = dockerVerbs({
  read: "ls du inspect version",
  lifecycle: "prune",
  refuse: "bake build create dap dial-stdio history imagetools policy rm stop use",
});
const DOCKER_SUBS: Record<string, Map<string, DockerClass>> = {
  container: dockerVerbs({
    read: "ls list ps inspect logs stats top port diff wait",
    lifecycle: "start stop restart kill rm pause unpause rename prune update",
    exec: "exec",
    refuse: "cp run create commit export attach",
  }),
  image: dockerVerbs({ read: "ls list inspect history", lifecycle: "rm pull tag prune", refuse: "build save load import push" }),
  network: dockerVerbs({ read: "ls list inspect", lifecycle: "rm prune create connect disconnect" }),
  volume: dockerVerbs({ read: "ls list inspect", lifecycle: "rm prune create" }),
  system: dockerVerbs({ read: "df info events", lifecycle: "prune", refuse: "dial-stdio" }),
  context: dockerVerbs({ read: "ls list show inspect", refuse: "create export import rm update use" }),
  plugin: dockerVerbs({ read: "ls list inspect", refuse: "create disable enable install push rm set upgrade" }),
  builder: DOCKER_BUILDER,
  buildx: DOCKER_BUILDER,
  model: dockerVerbs({}),
  compose: dockerVerbs({
    read: "ps ls list logs top images version events port stats volumes wait",
    lifecycle: "down stop restart start pull rm kill pause unpause",
    // `config`/`convert` print the resolved environment.
    refuse: "exec run up create build cp config convert attach commit export push publish watch scale bridge alpha",
  }),
};
/** `docker`, and the CLI plugins run as their own binaries (`docker-compose up` = `docker compose up`). */
const DOCKER_WORD_RE = /^docker(?:-compose|-buildx|-model)?$/;
/**
 * Queue 4k (ruling 5): the other container-runtime CLIs reach the same containers around the docker gate —
 * `ctr -n moby task exec …` and `runc --root /run/docker/runtime-runc/moby exec …` open a process in
 * supabase-db with no `supabase-db psql` form for ruling 5a to judge. The word itself is refused: at command
 * position always; elsewhere (an argument, like `grep runc src`) only when a RUNTIME_VERBS word follows it in
 * the segment, the way prose naming a refused docker verb is refused.
 */
const RUNTIME_WORD_RE = /^(?:ctr|containerd-ctr|runc|crictl|podman|podman-compose|nerdctl)$/;
const RUNTIME_VERBS = new Set(
  "exec run create start task tasks t container containers c attach cp restore checkpoint debug mount unshare compose up".split(" "),
);
// pflag: in a short-flag token the first value-taking letter takes the rest of the token as its value, and the
// next token only when it is the last character (`-lfatal ps` = log-level fatal, verb ps; `-Dl x ps` = verb ps).
const DOCKER_VALUE_FLAG_RE = /^(?:--(?:config|context|host|log-level|tlscacert|tlscert|tlskey)|-(?:(?![cHl])[A-Za-z])*[cHl])$/;
const COMPOSE_VALUE_FLAG_RE = /^(?:--(?:ansi|env-file|file|parallel|profile|progress|project-directory|project-name)|-(?:(?![fp])[A-Za-z])*[fp])$/;
/** Pointing the CLI at another daemon, context or config. */
const DOCKER_REDIRECT_FLAG_RE = /^(?:--(?:host|context|config)(?:=|$)|-[A-Za-z]*[Hc])/;
/**
 * Any `DOCKER_*=` assignment (ruling 5d, 2026-10-03: "any DOCKER_* prefix … Keep refused"), wherever it
 * appears in the command — not only in front of a docker word. The CLI reads many of these (HOST, CONTEXT,
 * CONFIG, CERT_PATH, TLS_VERIFY, API_VERSION, …) and an assignment reaches docker through indirection the
 * walk cannot see: a script, a Makefile, `npm run`, an interpreter that assembles the word. The cost is a
 * refusal of a non-docker command that sets a `DOCKER_` variable (`DOCKER_FOO=1 npm run x`), which no
 * logged use needs. Case-sensitive: bash and the CLI treat `docker_host` as a different variable.
 */
const DOCKER_ENV_ASSIGN_RE = /(?:^|\.)DOCKER_\w*=/;
/**
 * Audit B2 (ruling 5d, "anywhere"): a builtin that SETS a variable from a name argument
 * (`read DOCKER_HOST`, `printf -v DOCKER_HOST …`, `mapfile`/`readarray`, `declare`/`typeset`/
 * `export`/`local`, `getopts`, `for`/`select` loop variables) reaches the CLI without a
 * `DOCKER_*=` token. A segment that contains one of these words and names a `DOCKER_` variable is
 * refused (`printf` only with `-v`). The cost: in such a segment a `DOCKER_` name is refused even as
 * a read (`export X=$DOCKER_HOST`); no logged use needs it.
 */
const DOCKER_SETTER_WORDS = new Set(["read", "mapfile", "readarray", "declare", "typeset", "export", "local", "getopts", "for", "select"]);
/** A `DOCKER_` name anywhere in a token (`-vDOCKER_HOST`, `r=DOCKER_HOST` for a nameref). */
const DOCKER_NAME_RE = /DOCKER_\w*/;
/**
 * `${DOCKER_HOST:=x}` / `${DOCKER_HOST=x}`: an assign-default expansion sets the variable. Matched on the
 * RAW command — normalizeShellText folds the expansion to its word before the walk sees it.
 */
const DOCKER_ASSIGN_DEFAULT_RE = /\$\{DOCKER_\w*:?=/;
/** Other assignment spellings the `DOCKER_*=` token test misses: `+=`, `V[0]=`, arithmetic `(( V = 1 ))`. */
const DOCKER_OTHER_ASSIGN_RE = /(?<!\w)DOCKER_\w*(?:\[[^\]]*\])?\s*\+?=/;
/**
 * Audit B3: shell_exec pins `DOCKER_CONFIG` (see withDockerConfig) so `HOME=/tmp/h docker ps` cannot
 * point the CLI at another config.json/context. Removing the pin (`unset DOCKER_CONFIG`) is refused
 * (`env -u` is already refused by checkEnvReset); unsetting any other `DOCKER_` variable stays allowed.
 */
const DOCKER_CONFIG_UNPIN_WORDS = new Set(["unset"]);
function checkDockerVarSet(part: string, tokens: string[]): string | null {
  const other = DOCKER_OTHER_ASSIGN_RE.exec(part)?.[0];
  if (other) return dockerRefusal(other.replace(/\s+/g, ""));
  const words = tokens.map((t) => t.replace(/^.*\//, ""));
  const setter = words.find(
    (w, k) => DOCKER_SETTER_WORDS.has(w) || (w === "printf" && tokens.slice(k + 1).some((a) => a.startsWith("-v"))),
  );
  const unpin = words.some((w) => DOCKER_CONFIG_UNPIN_WORDS.has(w));
  for (const t of tokens) {
    const name = DOCKER_NAME_RE.exec(t)?.[0];
    if (!name) continue;
    if (setter) return dockerRefusal(`${setter} ${name}`);
    if (unpin && name === "DOCKER_CONFIG") return dockerRefusal(`unset ${name}`);
  }
  return null;
}

/** A here-string with its operand attached (`<<<docker`): group 1 is the operator. */
const HERE_STRING_RE = /^(\d*<<<)(?=.)/;
/** Flag tokens scanned before a verb; the 64th refuses the invocation, so padding buys nothing and the walk stays linear. */
const DOCKER_SCAN_CAP = 64;
const dockerRefusal = (what: string): string =>
  `\`${what}\` is refused — container file access and new containers are operator-only (operator ruling 2026-10-01); \`docker exec supabase-db psql …\` and the read verbs (ps, logs, inspect, images, stats) are available`;

const runtimeRefusal = (what: string): string =>
  `\`${what}\` is refused — container runtime CLIs (ctr, runc, crictl, podman, nerdctl) reach container exec and file access around the docker gate; operator-only (operator ruling 5, 2026-10-01); \`docker exec supabase-db psql …\` and the docker read verbs (ps, logs, inspect, images, stats) are available`;
/** The runtime word at `tokens[i]`; `strict` = command position. Off command position the next DOCKER_SCAN_CAP tokens are scanned for a verb; a longer tail refuses. */
function checkRuntimeAt(tokens: string[], i: number, strict: boolean): string | null {
  const bin = tokens[i]!.replace(/^.*\//, "");
  if (strict) return runtimeRefusal(bin);
  const end = Math.min(tokens.length, i + 1 + DOCKER_SCAN_CAP);
  for (let k = i + 1; k < end; k++) {
    const verb = tokens[k]!.replace(/^.*\//, "");
    if (RUNTIME_VERBS.has(verb)) return runtimeRefusal(`${bin} ${verb}`);
  }
  return end < tokens.length ? runtimeRefusal(`${bin} …`) : null;
}

/** Index of the first positional at or after `k` (flags and redirections skipped, collected into `flags`); -1 past the cap. */
function dockerPositional(tokens: string[], k: number, valueFlag: RegExp | null, flags: string[]): number {
  for (let n = 0; k < tokens.length; n++) {
    if (n >= DOCKER_SCAN_CAP) return -1;
    const t = tokens[k]!;
    if (REDIRECTION_RE.test(t)) { k += redirectionSpan(tokens, k); continue; }
    if (!t.startsWith("-") || t === "-") return k;
    flags.push(t);
    k += valueFlag?.test(t) ? 2 : 1;
  }
  return tokens.length;
}

/**
 * Ruling 5b (2026-10-03): `-e`/`--env` on the psql form only, for libpq variables. The name must start
 * with `PG` (`PGPASSWORD=x`, or a bare `PGUSER` passed through from the caller's env). `--env-file` stays
 * refused; on any other exec form the container/command check refuses first.
 */
const DOCKER_EXEC_ENV_RE = /^PG\w*(?:=|$)/;

/**
 * Ruling 5a (2026-10-18, operator option a — gate only): `docker exec … supabase-db psql …` runs only as a
 * read-only role. Inside the container the socket is peer/trust, so `-U postgres` (the sole superuser)
 * connects with no password, and `\c - postgres` over that socket switches an exec'd psql to the superuser
 * (verified read-only: current_user=postgres, rolsuper=t). The gate does not parse SQL and does not try to
 * read shell text with a parser simpler than the shell (qa R1 C1: quote-fused `-U'postgres'`). It restricts
 * the INPUT to a closed grammar on which this tokenizer and the shell agree by construction:
 *   - Once a psql form is confirmed, every raw token of the command is a BARE word
 *     (`[A-Za-z0-9_.,:/=-]+`: no quotes, `$`, backslash, globs, parens, redirections), one of the
 *     terminators `|` `;` `&&` `||` `2>&1` `2>/dev/null` (or a newline), a docker env value
 *     `PG…=$SECRET_X` (ruling 3c), or — only as a psql `-c`/`--command` value — ONE whole single-quoted
 *     span with no `'`, backslash or newline inside. The shell gives each such token to its program
 *     literally, so what the gate reads is what psql receives. Anything else: "psql argument grammar".
 *   - psql arguments are a positive allow-list (getopt consumption mirrored): `-U`/`--username[=]` with a
 *     role in PSQL_RO_ROLES, exactly once (docker `-e PGUSER=` may also appear and must agree);
 *     `-d`/`--dbname[=]` or ONE positional (not both) matching `[A-Za-z0-9_]+` (no `=` `/` `:` — so no URI or
 *     conninfo); `-c '<sql>'` / `--command '<sql>'` (repeatable); `-v`/`--set`/`--variable` `NAME=value`;
 *     `-F`/`-R`/`--field-separator=`/`--record-separator=` with a 1–3 char value; the switches `-A -t -q -X -x
 *     -E -1 --csv --tuples-only --no-align --quiet --no-psqlrc --single-transaction --expanded` and short
 *     clusters made only of those letters. Every other flag (`-o`, `-L`, `-f`, `-P`, `-h`, `-p`, `-e`, `-l`,
 *     `-W`, `-0`, `--`, any abbreviation, …) is refused: `-o`/`-L` write container files as the postgres OS
 *     user (qa R1 C2), `-f`/stdin bring unseen meta-commands.
 *   - Defense in depth: a backslash anywhere, any `<<`, docker `-i`/`--interactive`, stdin redirection and a
 *     shell re-entry (`bash -c`, `eval`, here-string to a shell) are refused. `-v` values cannot run a
 *     meta-command (no backslash can reach the text).
 *   - Every bare `supabase-db psql` invocation in the command is checked, and the normalized walk may not
 *     confirm more psql forms than the raw text spells bare (a quoted, `$`-built or interpreter-embedded
 *     form is refused).
 *   - Rulings 5/5b (only `-e PG*` env on docker exec, container exactly `supabase-db`) are unchanged.
 *   - `npm run <script> -- <args>` / `npx <bin> <args>` (argv appended after the checked body) are refused
 *     when the appended args carry a psql-shaped token (queue 4m, checkAppendedArgv).
 *   - Residual by construction (qa R3 I1/W1): the gate judges only the literal command text. A script file
 *     (`sh x.sh`, `node x.js`, `make`) can carry `-U postgres` past it; only a DB-side control (pg_hba for
 *     `postgres`, ruling 5a option b) closes that route.
 */
const PSQL_RO_ROLES = new Set(["mcp_readonly", "longevidad_ro"]);
const PSQL_ROLE_REASON =
  "psql on supabase-db runs only as a read-only role, given once as a bare word (-U mcp_readonly | -U longevidad_ro); ruling 5a 2026-10-18";
const psql5a = (what: string): string => `psql on supabase-db: ${what}; ruling 5a 2026-10-18`;
const PSQL_REENTRY_REASON = psql5a("read-only form not allowed via a shell re-entry (bash -c/eval)");
const PSQL_STDIN_REASON = psql5a("-i / stdin / heredoc refused");
const PSQL_BACKSLASH_REASON = psql5a("backslash (meta-command) refused");
const PSQL_GRAMMAR_REASON = psql5a(
  "psql argument grammar — every token must be a bare word [A-Za-z0-9_.,:/=-] or, as a -c value only, one whole single-quoted span; the role must be a bare word",
);
const PSQL_DBNAME_REASON = psql5a("database name must match [A-Za-z0-9_]+ (no URI/conninfo)");
const PSQL_POSITIONAL_REASON = psql5a("a second positional or a positional beside -d (username slot) is refused (use -U mcp_readonly | -U longevidad_ro)");
const PSQL_DISAGREE_REASON = psql5a("-U and -e PGUSER must name the same read-only role");
const psqlFlagRefusal = (flag: string): string => psql5a(`flag not allowed (${flag})`);
const PSQL_HEAD_REASON = psql5a(
  "psql form must start its segment (docker …, or timeout <n> docker …); argument-appending wrappers refused",
);
const PSQL_PGPASSWORD_REASON = psql5a("PGPASSWORD only as -e PGPASSWORD=$SECRET_… or a bare -e PGPASSWORD (rulings 3c/5b)");
const PSQL_TIMEOUT_RE = /^[0-9]+[smh]?$/;

const PSQL_BARE_RE = /^[A-Za-z0-9_.,:/=-]+$/;
const PSQL_SQUOTED_RE = /^'[^'\\\n]*'$/;
const PSQL_DBNAME_RE = /^[A-Za-z0-9_]+$/;
const PSQL_VAR_RE = /^[A-Za-z_][A-Za-z0-9_]*=[A-Za-z0-9_.-]+$/;
const PSQL_SEP_RE = /^[A-Za-z0-9_.,:/=-]{1,3}$/;
/** Ruling 3c by-name secret use as a docker env value, e.g. `-e PGPASSWORD=$SECRET_T`. */
const PSQL_SECRET_ENV_RE = /^PG[A-Z0-9_]*=\$SECRET_[A-Z0-9_]+$/;
const PSQL_SWITCH_LETTERS = new Set(["A", "t", "q", "X", "x", "E", "1"]);
const PSQL_SWITCH_LONG = new Set([
  "--csv", "--tuples-only", "--no-align", "--quiet", "--no-psqlrc", "--single-transaction", "--expanded",
]);
/** Command terminators; a newline token is "\n". */
const PSQL_END = new Set(["|", ";", "&&", "||", "\n"]);
/** Redirections allowed only at the end of an invocation (a later token must be a terminator or the end). */
const PSQL_REDIR_END = new Set(["2>&1", "2>/dev/null"]);

/**
 * Split the RAW command on unquoted spaces (and unquoted newlines, emitted as a "\n" token); a quoted span
 * stays inside its token verbatim, quotes included. Linear. Token CONTENT is judged by the grammar, never
 * interpreted here, so a spelling this splitter does not understand is simply a token that fails the grammar.
 */
function psqlRawTokens(s: string): string[] {
  const out: string[] = [];
  let buf = "";
  let has = false;
  let q: string | null = null;
  const flush = () => {
    if (has) out.push(buf);
    buf = "";
    has = false;
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (q !== null) {
      buf += ch;
      if (ch === q) q = null;
      continue;
    }
    if (ch === " ") { flush(); continue; }
    if (ch === "\n") { flush(); out.push("\n"); continue; }
    if (ch === "'" || ch === '"') q = ch;
    buf += ch;
    has = true;
  }
  flush();
  return out;
}

/** Indices `p` where `toks[p-1]` is `supabase-db` and `toks[p]` is `psql` (both bare). */
function psqlAnchors(toks: string[]): number[] {
  const out: number[] = [];
  for (let p = 1; p < toks.length; p++) if (toks[p] === "psql" && toks[p - 1] === "supabase-db") out.push(p);
  return out;
}

/**
 * Validate one psql argument span starting at `j` (the token after `psql`) against the closed grammar.
 * Returns the refusal, or the index one past the span (the terminator or the end) and its role.
 */
function checkPsqlSpan(toks: string[], j: number): string | { end: number; role: string } {
  let role: string | undefined;
  let roles = 0;
  let positional = 0;
  let dbFlags = 0;
  const val = (): string | undefined => {
    const n = toks[j + 1];
    if (n === undefined || PSQL_END.has(n) || PSQL_REDIR_END.has(n)) return undefined;
    j++;
    return n;
  };
  for (; j < toks.length; j++) {
    const t = toks[j]!;
    if (PSQL_END.has(t)) break;
    if (PSQL_REDIR_END.has(t)) {
      const n = toks[j + 1];
      if (n !== undefined && !PSQL_END.has(n) && !PSQL_REDIR_END.has(n)) return PSQL_GRAMMAR_REASON; // args after a redirection
      continue;
    }
    if (t.startsWith("<")) return PSQL_STDIN_REASON;
    if (!PSQL_BARE_RE.test(t)) return PSQL_GRAMMAR_REASON;
    let roleVal: string | undefined | null = null; // null = this token is not a role flag
    if (t === "-U" || t === "--username") roleVal = val();
    else if (t.startsWith("--username=")) roleVal = t.slice("--username=".length);
    if (roleVal !== null) {
      if (roleVal !== undefined && !PSQL_BARE_RE.test(roleVal)) return PSQL_GRAMMAR_REASON;
      if (roleVal === undefined || !PSQL_RO_ROLES.has(roleVal)) return PSQL_ROLE_REASON;
      role = roleVal;
      roles++;
      continue;
    }
    if (t === "-d" || t === "--dbname" || t.startsWith("--dbname=")) {
      const v = t.startsWith("--dbname=") ? t.slice("--dbname=".length) : val();
      if (v !== undefined && !PSQL_BARE_RE.test(v)) return PSQL_GRAMMAR_REASON;
      if (v === undefined || !PSQL_DBNAME_RE.test(v)) return PSQL_DBNAME_REASON;
      dbFlags++;
      continue;
    }
    if (t === "-c" || t === "--command") {
      const v = val();
      if (v === undefined || !PSQL_SQUOTED_RE.test(v)) return PSQL_GRAMMAR_REASON;
      continue;
    }
    if (t === "-v" || t === "--set" || t === "--variable" || t.startsWith("--set=") || t.startsWith("--variable=")) {
      const eq = t.startsWith("--") ? t.indexOf("=") : -1;
      const v = eq !== -1 ? t.slice(eq + 1) : val();
      if (v === undefined || !PSQL_VAR_RE.test(v)) return PSQL_GRAMMAR_REASON;
      continue;
    }
    if (t === "-F" || t === "-R" || t.startsWith("--field-separator=") || t.startsWith("--record-separator=")) {
      const v = t.startsWith("--") ? t.slice(t.indexOf("=") + 1) : val();
      if (v === undefined || !PSQL_SEP_RE.test(v)) return PSQL_GRAMMAR_REASON;
      continue;
    }
    if (PSQL_SWITCH_LONG.has(t)) continue;
    if (/^-[A-Za-z0-9]+$/.test(t)) {
      for (const L of t.slice(1)) if (!PSQL_SWITCH_LETTERS.has(L)) return psqlFlagRefusal(t);
      continue;
    }
    if (t.startsWith("-")) return psqlFlagRefusal(t.replace(/=.*/, "="));
    positional++;
    if (!PSQL_DBNAME_RE.test(t)) return PSQL_DBNAME_REASON;
  }
  // One positional = the database. A second one (or one beside -d) lands in psql's username slot.
  if (positional > 1 || (positional === 1 && dbFlags > 0)) return PSQL_POSITIONAL_REASON;
  if (roles !== 1 || role === undefined) return PSQL_ROLE_REASON;
  return { end: j, role };
}

/**
 * Fold 2 (qa R2): a psql form is the HEAD of its segment (raw tokens between terminators): exactly `docker …`
 * or `timeout <n> docker …`. Anything in front (`xargs`, `env`, `nice`, `find -exec`, a path, a variable)
 * may append words the grammar never saw — `echo -U postgres | xargs docker exec … psql -U mcp_readonly`
 * makes psql take the LAST -U. Then docker's `-e`/`--env` names on the form are an allow-list: PGUSER=<bare>
 * (its role must agree with -U), PGDATABASE=<dbname>, PGPASSWORD (bare pass-through or =$SECRET_…); every
 * other name (PGOPTIONS, PGSERVICE, PGSYSCONFDIR, PGHOST, PGPASSFILE, …) can redirect the connection or its
 * options. `start` = the segment's first token, `db` = the index of `supabase-db`; the docker flags in
 * between were already shaped by checkDockerExec (only i/t/e clusters, --tty, --interactive, --env[=]).
 */
function checkPsqlHead(toks: string[], start: number, db: number): string | null {
  let k = start;
  if (toks[k] === "timeout") {
    if (!PSQL_TIMEOUT_RE.test(toks[k + 1] ?? "")) return PSQL_HEAD_REASON;
    k += 2;
  }
  if (toks[k] !== "docker") return PSQL_HEAD_REASON;
  for (k++; k < db; k++) {
    const t = toks[k]!;
    let v: string | undefined;
    if (t === "--env") v = toks[++k];
    else if (t.startsWith("--env=")) v = t.slice("--env=".length);
    else {
      const m = /^-[it]*e(.*)$/.exec(t);
      if (m) v = m[1] || toks[++k];
    }
    if (v === undefined) continue;
    const name = v.replace(/=.*/s, "");
    if (name === "PGUSER") {
      if (!/^PGUSER=[A-Za-z0-9_]+$/.test(v)) return PSQL_ROLE_REASON; // the role itself is compared with -U
    } else if (name === "PGDATABASE") {
      if (!/^PGDATABASE=[A-Za-z0-9_]+$/.test(v)) return PSQL_DBNAME_REASON;
    } else if (name === "PGPASSWORD") {
      if (v !== "PGPASSWORD" && !/^PGPASSWORD=\$SECRET_[A-Z0-9_]+$/.test(v)) return PSQL_PGPASSWORD_REASON;
    } else return psql5a(`env name not allowed on the psql form (${name})`);
  }
  return null;
}

/** Per-command state for the ruling-5a check: the raw text, its one-time grammar verdict, confirmed forms. */
type PsqlCtx = { raw: string; confirmed: number; parsed?: { verdict: string | null; anchors: number; roles: Set<string> } };

/** The grammar verdict for the whole raw command: every bare `supabase-db psql` span + every token outside them. */
function parsePsqlRaw(raw: string): NonNullable<PsqlCtx["parsed"]> {
  const roles = new Set<string>();
  const done = (verdict: string | null, anchors = 0) => ({ verdict, anchors, roles });
  if (raw.includes("\\")) return done(PSQL_BACKSLASH_REASON);
  if (raw.includes("<<")) return done(PSQL_STDIN_REASON);
  const toks = psqlRawTokens(raw);
  const anchors = psqlAnchors(toks);
  const inSpan = new Uint8Array(toks.length);
  const segStart = new Uint32Array(toks.length);
  for (let i = 0, st = 0; i < toks.length; i++) {
    segStart[i] = st;
    if (PSQL_END.has(toks[i]!)) st = i + 1;
  }
  for (const p of anchors) {
    const head = checkPsqlHead(toks, segStart[p]!, p - 1);
    if (head) return done(head);
    const span = checkPsqlSpan(toks, p + 1);
    if (typeof span === "string") return done(span);
    roles.add(span.role);
    inSpan.fill(1, p + 1, span.end);
  }
  for (let i = 0; i < toks.length; i++) {
    if (inSpan[i]) continue;
    const t = toks[i]!;
    if (PSQL_END.has(t) || PSQL_REDIR_END.has(t) || PSQL_BARE_RE.test(t) || PSQL_SECRET_ENV_RE.test(t)) continue;
    return done(t.startsWith("<") ? PSQL_STDIN_REASON : PSQL_GRAMMAR_REASON);
  }
  return done(null, anchors.length);
}

/**
 * Called once per psql form the normalized walk confirms. The raw command is judged once (parsePsqlRaw, so
 * a long chain stays linear); the walk may not confirm more psql forms than the raw text spells bare.
 * `envUser` is this invocation's docker `-e PGUSER=` value; every span's -U must equal it (a chained
 * command agrees throughout).
 */
function checkPsqlReadonly(ctx: PsqlCtx, envUser: string | undefined): string | null {
  ctx.confirmed++;
  ctx.parsed ??= parsePsqlRaw(ctx.raw);
  const { verdict, anchors, roles } = ctx.parsed;
  if (verdict) return verdict;
  if (ctx.confirmed > anchors) return PSQL_GRAMMAR_REASON;
  if (envUser !== undefined && [...roles].some((r) => r !== envUser)) return PSQL_DISAGREE_REASON;
  return null;
}

/**
 * `exec [-i|-t|--interactive|--tty|-e PG…|--env PG…] supabase-db psql …` is the one exec form; `k` is the
 * index after `exec`. Short flags follow pflag: `i`/`t` are booleans, `e` takes the rest of its token as
 * its value (`-ePGHOST=h`, `-ie PGUSER=u` takes the next token); any other letter is refused. Once the
 * `supabase-db psql` form is confirmed, ruling 5a (read-only role) applies via checkPsqlReadonly.
 */
function checkDockerExec(tokens: string[], k: number, label: string, reentry: boolean, psql: PsqlCtx): string | null {
  let bad: string | undefined;
  let c = -1;
  let interactive = false;
  let envUser: string | undefined;
  for (let n = 0; k < tokens.length; n++) {
    if (n >= DOCKER_SCAN_CAP) break;
    const t = tokens[k]!;
    if (REDIRECTION_RE.test(t)) { k += redirectionSpan(tokens, k); continue; }
    if (!t.startsWith("-") || t === "-") { c = k; break; }
    k++;
    if (t === "--interactive") { interactive = true; continue; }
    if (t === "--tty") continue;
    let value: string | undefined;
    if (t === "--env") value = tokens[k++] ?? "";
    else if (t.startsWith("--env=")) value = t.slice("--env=".length);
    else if (/^-[A-Za-z]/.test(t)) {
      const letters = t.slice(1);
      const e = letters.indexOf("e");
      const bools = e === -1 ? letters : letters.slice(0, e);
      if (!/^[it]*$/.test(bools)) { bad = t; break; }
      if (bools.includes("i")) interactive = true;
      if (e !== -1) value = letters.slice(e + 1) || (tokens[k++] ?? "");
    } else { bad = t; break; }
    if (value !== undefined) {
      if (!DOCKER_EXEC_ENV_RE.test(value)) { bad = `${t} ${value}`.trim(); break; }
      const u = /^PGUSER=(.*)$/.exec(value);
      if (u) envUser = u[1];
    }
  }
  if (c === -1 && !bad && k >= tokens.length) c = tokens.length;
  let cmd = c + 1;
  while (c !== -1 && cmd < tokens.length && REDIRECTION_RE.test(tokens[cmd]!)) cmd += redirectionSpan(tokens, cmd);
  if (bad || c === -1 || tokens[c] !== "supabase-db" || tokens[cmd] !== "psql") {
    return dockerRefusal(`${label} ${bad ?? (c === -1 ? "…" : `${tokens[c] ?? ""} ${tokens[cmd] ?? ""}`.trim())}`);
  }
  // Ruling 5a (2026-10-18): the supabase-db psql form runs read-only only.
  if (reentry) return PSQL_REENTRY_REASON;
  if (interactive) return PSQL_STDIN_REASON;
  return checkPsqlReadonly(psql, envUser);
}

/**
 * Ruling 5c (2026-10-03): `docker volume create` stays a lifecycle verb, except a local-driver bind or
 * device volume — any option that sets `type=none`, `o=…bind…` or `device=` — which mounts a host path
 * into every container that uses the volume. The tokenizer splits on commas, so a word after an `o=`
 * value (`o=rw,bind` → `o=rw` `bind`) is still part of it. `k` is the index after `create`.
 */
function checkVolumeCreate(tokens: string[], k: number): string | null {
  let inO = false;
  for (let n = 0; k < tokens.length; k++, n++) {
    if (n >= DOCKER_SCAN_CAP) return dockerRefusal("docker volume create …"); // padding past the cap refuses
    const raw = tokens[k]!;
    if (REDIRECTION_RE.test(raw)) { k += redirectionSpan(tokens, k) - 1; inO = false; continue; }
    // Every pflag spelling of the option: `--opt X`, `--opt=X`, `-o X`, `-oX`, `-o=X` (audit B1: `-o=type=none`).
    const t = raw.replace(/^(?:--opt=|-o=?(?=.))/, "");
    if (t !== raw) inO = false;
    else if (raw.startsWith("-")) { inO = false; continue; }
    const oValue = /^o=/i.test(t);
    if (/^type=none$/i.test(t) || /^device=/i.test(t) || ((inO || oValue) && /\br?bind\b/i.test(t))) {
      return dockerRefusal(`docker volume create ${t}`);
    }
    if (oValue) inO = true;
  }
  return null;
}

/** The docker word at `tokens[i]`; `strict` = command position (an unknown verb is refused there). `reentry` = behind a shell re-entry (bash -c/eval); `psql` = the ruling-5a state (raw command + confirmed psql forms). */
function checkDockerAt(tokens: string[], i: number, strict: boolean, reentry: boolean, psql: PsqlCtx): string | null {
  const bin = tokens[i]!.replace(/^.*\//, "");
  const flags: string[] = [];
  let k = i;
  let verb = bin.slice("docker-".length); // a plugin binary is its own verb
  if (bin === "docker") {
    k = dockerPositional(tokens, i + 1, DOCKER_VALUE_FLAG_RE, flags);
    if (k === -1) return dockerRefusal(`docker ${flags.slice(0, 3).join(" ")} …`);
    verb = tokens[k] ?? "";
  }
  const redirect = flags.find((f) => DOCKER_REDIRECT_FLAG_RE.test(f));
  if (!verb) return strict && redirect ? dockerRefusal(`docker ${redirect}`) : null; // `docker --version`, `ls /usr/bin/docker`
  let cls = DOCKER_VERBS.get(verb);
  let label = `docker ${verb}`;
  const subs = DOCKER_SUBS[verb];
  if (subs) {
    const s = dockerPositional(tokens, k + 1, verb === "compose" ? COMPOSE_VALUE_FLAG_RE : null, []);
    if (s === -1) return dockerRefusal(`${label} …`);
    const sub = tokens[s] ?? "";
    cls = sub ? subs.get(sub) : "read"; // no sub: the usage text
    if (sub) label = `${label} ${sub}`;
    k = s;
  }
  if (cls === undefined) return strict ? dockerRefusal(`${label} (unknown verb)`) : null;
  if (redirect) return dockerRefusal(`docker ${redirect}`);
  if (cls === "exec") return checkDockerExec(tokens, k + 1, label, reentry, psql);
  if (cls === "refuse") return dockerRefusal(label);
  return verb === "volume" && tokens[k] === "create" ? checkVolumeCreate(tokens, k + 1) : null;
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
export function checkPackageManagerRaw(
  command: string,
  cwd: string = process.cwd(),
  opts: { docker?: boolean } = {},
): string | null {
  const scan = spaceRedirections(normalizeShellText(`${stripQuotedHeredocs(command)}\n${interpreterHeredocBodies(command)}`));
  const assignDefault = opts.docker !== false ? DOCKER_ASSIGN_DEFAULT_RE.exec(command)?.[0] : undefined;
  if (assignDefault) return dockerRefusal(assignDefault);
  const psqlCtx: PsqlCtx = { raw: command, confirmed: 0 };
  const psqlMeta = PSQL_META_RE.test(command); // once per walk: a per-word raw rescan is quadratic (4m fold W1)
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
    // Docker (ruling 5): command position = leading assignments/redirections, or behind a wrapper,
    // shell keyword or shell re-entry (sticky, like checkEnvReset); after a docker word the rest is its
    // arguments. Skipped for a `bash -c` re-validation (opts.docker false): that string arrives with its
    // `-x` flags stripped (`docker -l debug ps` → `docker debug ps`), and this walk already saw it intact.
    // A here-string fed to a shell is its script (`bash <<< 'docker run x'`), so after a re-entry word its
    // operand is not skipped as a redirection target, and an attached operand (`<<<docker`) is split off.
    const dTokens = tokens.flatMap((t) => {
      const op = HERE_STRING_RE.exec(t)?.[1];
      return op ? [op, t.slice(op.length)] : [t];
    });
    if (opts.docker !== false && !dTokens.some((t) => DOCKER_ENV_ASSIGN_RE.test(t))) {
      const varSet = checkDockerVarSet(part, dTokens);
      if (varSet) return varSet;
    }
    let lead = true;
    let behindWrapper = false;
    let reentry = false;
    let inDocker = false;
    for (let i = 0; i < dTokens.length && opts.docker !== false; i++) {
      const t = dTokens[i]!;
      if (DOCKER_ENV_ASSIGN_RE.test(t)) return dockerRefusal(t.replace(/=.*/, "="));
      const word = t.replace(/^.*\//, "");
      if (DOCKER_WORD_RE.test(word)) {
        const verdict = checkDockerAt(dTokens, i, !inDocker && (lead || behindWrapper), reentry, psqlCtx);
        if (verdict) return verdict;
        inDocker = true;
      }
      if (inDocker) continue;
      if (RUNTIME_WORD_RE.test(word)) {
        const verdict = checkRuntimeAt(dTokens, i, lead || behindWrapper);
        if (verdict) return verdict;
      }
      if (lead && REDIRECTION_RE.test(t)) {
        if (!(reentry && /^\d*<<<$/.test(t))) i += redirectionSpan(dTokens, i) - 1;
        continue;
      }
      if (SHELL_REENTRY.has(word)) reentry = true;
      if (isWrapper(word) || SHELL_REENTRY.has(word) || /^(?:if|while|until)$/.test(word)) behindWrapper = true;
      else if (!/^[A-Za-z_]\w*=/.test(t)) lead = false;
    }
    for (let i = 0; i < tokens.length; i++) {
      if (!PM_WORD_RE.test(pmWord(tokens[i]!))) continue;
      const verdict = checkPackageManagerMutation(verbWindow(tokens, i).join(" "), cwd, { flat: i !== 0 });
      if (verdict) return verdict;
      const argv = checkAppendedArgv(tokens, i, psqlMeta); // after the mutation rules, so their reasons win
      if (argv) return argv;
    }
  }
  return null;
}

/**
 * Queue 4m (ruling 5a, operator option a): `npm run <script> -- <args>` (and `npx <bin> <args>`) appends argv
 * after the script body this gate checked, so `npm run db -- -U postgres` hands a superuser role to a
 * `psql` inside the script. The appended args — everything after the script name (or after the bin for
 * npx, after the verb for the `test`/`start`/`stop`/`restart` shorthands and the pnpm/yarn/bun `<script>`
 * shorthand) up to the end of the segment — may not carry a psql-shaped token: `-U`, a cluster of psql
 * boolean short flags ending in `U` or a fused value (`-AtU`, `-Upostgres`; `-DUSE_X` passes), `--username`
 * or an abbreviation (`--user=`), `PGUSER=`, `psql`, `-c`/`--command` followed by an SQL keyword, or a
 * `\c`/`\connect` meta-command (tokens are normalized, so the backslash is read from the raw command, once
 * per walk). Script files stay a documented limit (5a block).
 * Cost: getopt_long prefix matching makes `--user`/`--u…` resolve to psql's `--username`, so another tool's
 * `--user=` in appended args is refused too.
 * Linear (fold W1): the scan covers the DOCKER_SCAN_CAP tokens after the manager word; a longer segment refuses
 * (a real `npm run x -- <args>` never carries 64+ args), like checkRuntimeAt.
 */
const NPM_SCRIPT_VERBS = /^(?:run|run-script|rum|urn|exec|x|dlx)$/;
const NPM_SHORTHAND_VERBS = /^(?:test|t|tst|start|stop|restart)$/;
/** psql's boolean short options may precede `-U` in one cluster (`-AtU`); a value-taking letter would eat the U. */
const PSQL_USER_FLAG_RE = /^(?:-[aAbeEHlnqsStwWxXzZ01V]*U|--u(?:s(?:e(?:r(?:n(?:a(?:m(?:e)?)?)?)?)?)?)?(?:=|$))/;
const SQL_WORD_RE =
  /^(?:select|insert|update|delete|alter|drop|create|grant|revoke|set|reset|copy|truncate|do|call|begin|commit|rollback|show|with|explain|vacuum|analyze|comment|reindex|lock|listen|notify|prepare|execute|declare|refresh|table|values)$/i;
const PSQL_META_RE = /\\c(?:onnect)?(?![A-Za-z])/;
function checkAppendedArgv(tokens: string[], i: number, meta: boolean): string | null {
  const base = pmWord(tokens[i]!);
  if (base !== "npx" && !NODE_PM_RE.test(base)) return null;
  const end = Math.min(tokens.length, i + 1 + DOCKER_SCAN_CAP);
  const capped = end < tokens.length;
  let k = i + 1;
  const positional = (): string | undefined => {
    while (k < end && tokens[k]!.startsWith("-") && tokens[k] !== "--") k += PM_VALUE_FLAGS.has(tokens[k]!) ? 2 : 1;
    return k < end ? tokens[k++] : undefined;
  };
  const pastCap = (label: string): string =>
    psql5a(`\`${label} …\` appends argv after the checked script body past the ${DOCKER_SCAN_CAP}-token scan cap (queue 4m) — put the arguments inside the script`);
  const verb = positional();
  if (!verb) return capped ? pastCap(base) : null;
  // npm: only the script runners append argv; other managers: any verb may be a script shorthand.
  if (base === "npm" && !NPM_SCRIPT_VERBS.test(verb) && !NPM_SHORTHAND_VERBS.test(verb)) return null;
  const script = base === "npx" || NPM_SHORTHAND_VERBS.test(verb) || !NPM_SCRIPT_VERBS.test(verb) ? verb : positional();
  const label = [base, base === "npx" ? "" : verb, script === verb ? "" : script].filter(Boolean).join(" ");
  if (script === undefined && capped) return pastCap(label);
  for (let a = k; a < end; a++) {
    const t = tokens[a]!;
    const word = t.replace(/^.*\//, "");
    const command = /^(?:-c|--command)$/.test(t) ? tokens[a + 1] : /^(?:-c(?!-)|--command=)(.+)$/.exec(t)?.[1];
    if (
      PSQL_USER_FLAG_RE.test(t) ||
      t.includes("PGUSER=") ||
      word === "psql" ||
      (command !== undefined && SQL_WORD_RE.test(command)) ||
      (meta && /^(?:c|connect)$/.test(t))
    ) {
      return psql5a(
        `\`${label} … ${t}\` appends argv after the checked script body and carries a psql-shaped argument (queue 4m) — put the role inside the script`,
      );
    }
  }
  return capped ? pastCap(label) : null;
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
 * to run. Only the dependency-trust and docker rules apply to the body (a repo's own
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
    // `bash -n x.sh` / `sh -n x.sh` only parse (noexec), unless `-i` makes the shell interactive (R2 decline).
    const leading = rest.slice(0, (rest.findIndex((t) => !t.startsWith("-")) + 1 || rest.length + 1) - 1);
    if (base !== "eval" && leading.some((t) => /^-[a-hj-zA-Z]*n[a-hj-zA-Z]*$/.test(t)) && !leading.some((t) => /^(?:-[a-zA-Z]*i[a-zA-Z]*|--interactive)$/.test(t))) {
      return null;
    }
    // `bash -c "…"` / `eval …`: validate the string as its own command.
    const inner = rest.filter((t) => base === "eval" || !/^-[a-z]+$/.test(t)).join(" ");
    if (inner.trim()) {
      const verdict = validateShellCommand(inner, { reentry: true });
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
export function validateShellCommand(command: string, opts: { reentry?: boolean } = {}): {
  allowed: boolean;
  reason?: string;
} {
  // The command runs as ONE `sh -c` argv string, which the kernel refuses
  // (E2BIG) at MAX_ARG_STRLEN; nothing longer could run, and refusing it here
  // bounds the regex scans below (audit 2026-10-01 W3).
  const bytes = Buffer.byteLength(command, "utf8");
  if (bytes > MAX_COMMAND_BYTES) {
    return { allowed: false, reason: `command too long (${bytes} bytes; limit ${MAX_COMMAND_BYTES})` };
  }
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
  const pmRawViolation = checkPackageManagerRaw(command, undefined, { docker: !opts.reentry });
  if (pmRawViolation) {
    return { allowed: false, reason: pmRawViolation };
  }

  // Every assignment in the command, for the deny-verb check (audit R2 W1); computed once: linear.
  const commandVars = shellVars(sanitized);
  let mcCtlHit = false;

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
    // audit R1 C1b: and as bash reads the word — quotes, backslashes and `$'…'` removed
    // (`c''rontab`, `\crontab`, `"systemctl"`), with a busybox/toybox applet as its command.
    // audit R2 W1/W2: `$'\x72m'`, `X=rm; $X` (an assignment anywhere in the command), `{rm,x}`,
    // and the command behind `timeout -s KILL 5`, `chrt -f 1`, `busybox sh -c` and the other RUN_WRAPPERS.
    const unquoted = normalizeShellText(trimmed, commandVars);
    const verb = [baseName, effective, effectiveBaseCommand(unquoted, true), ...commandWords(unquoted)].find((v) => DENY_COMMANDS.has(v));

    if (verb) {
      // An unquoted heredoc body is scanned line by line (its text may be a
      // program); literal file content goes through a QUOTED heredoc.
      const hint = /<<-?\s*\w+/.test(sanitized)
        ? " — if this is literal file content, use a quoted heredoc (<<'EOF') or file_write"
        : "";
      return { allowed: false, reason: `command '${verb}' is blocked${hint}` };
    }
    // R2 fold: a write to a `.env`-shaped file is refused even where the read allowlist admits the read.
    const envWrite = envWriteTarget(unquoted);
    if (envWrite) {
      return { allowed: false, reason: `'${envWrite}' is a .env file — writing, moving or linking one from the shell is operator-only (the .env read allowlist covers reads only)` };
    }
    // audit R2 W1: a bare `$X` / `${X…}` command word whose variable this command assigns
    // (`X=crontab; $X`) runs whatever was assigned — spell the command out instead.
    const bareVar = [effective, ...commandWords(trimmed)]
      .map((w) => BARE_VAR_WORD_RE.exec(w))
      .find((m) => m && commandVars.has((m[1] ?? m[2])!));
    if (bareVar) {
      return { allowed: false, reason: `command word \`${bareVar[0]}\` is a variable this command assigns — spell the command out` };
    }
    // audit R2 W4: a globbed or variable mc-ctl subcommand (`./mc-ctl re*rt`, `C=restart; ./mc-ctl $C`).
    // Judged after DENY_PATTERNS, whose project-create entry carries the more specific reason.
    mcCtlHit ||= mcCtlGlobDenied(unquoted);

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
    // audit R2 W1: `{x,sudo}`, `busybox sh -c 'su …'`: an env-reset word behind the forms only commandWords reads.
    const resetWord = commandWords(unquoted).find((w) => ENV_RESET_WORDS.has(w));
    if (resetWord) {
      return { allowed: false, reason: `command '${resetWord}' is blocked` };
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
  if (mcCtlHit) {
    return { allowed: false, reason: MC_CTL_DENY_REASON };
  }

  // Secret paths by PATH, not by reader verb (SEC-01 / SEC-03).
  const secretVerdict = checkSecretPaths(sanitized);
  if (!secretVerdict.allowed) return secretVerdict;

  // Check write paths — if command writes to absolute paths, verify they're safe.
  // The raw command: captureWriteTargets skips every heredoc body itself and
  // judges the opener line, so the stripped form's heuristics do not steer it.
  for (const { raw: rawTarget, value, isAppend, refuse } of captureWriteTargets(command, { reentry: opts.reentry })) {
    if (refuse) return { allowed: false, reason: refuse };
    // Discard sinks (/dev/null, /dev/stderr, /dev/stdout) match the same
    // `>` redirect shape but are not real writes — exempt them (the unquoted
    // word, pre-realpath) so idioms like `2>/dev/null` don't false-positive.
    if (WRITE_INDICATOR_EXEMPT.has(value)) continue;
    // realpath so an in-domain symlink can't point the write outside the gates.
    // Security decisions below use this resolved path; the ritual-doc append regex
    // further down still matches the RAW target against the original command text.
    const targetPath = realResolve(value);
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
        // BEST-EFFORT, NOT AIRTIGHT: this lives inside the captureWriteTargets loop,
        // so truncation primitives it doesn't capture still slip past —
        // `>|` clobber, `truncate -s 0`, `sed -i`, and RELATIVE paths (the service
        // cwd is /root/claude/mission-control, so `> docs/EVOLUTION-LOG.md` hits
        // the real log with no absolute match). This is defense-in-depth against
        // the realistic ritual mistake (`>` vs `>>`); durable git persistence is
        // the only real backstop against truncation. See the write-target
        // hardening follow-up + memory feedback_evolution_log_truncation.
        if (targetPath.includes("/mission-control/")) {
          const rel = targetPath.replace(/.*\/mission-control\//, "");
          if (RITUAL_WRITABLE_DOCS.includes(rel)) {
            // Match the RAW redirect target against the original command text —
            // targetPath is now the realpath, which may not appear verbatim.
            const p = rawTarget.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            // Exempt only when THIS match is an append (`>>`, `&>>`, `tee -a`): every
            // other write to the log (`>>LOG|cp a LOG`, `>>LOG | tee LOG`) is its own
            // match and lands here as an overwrite (audit R1 W1).
            const hasOverwrite = new RegExp(
              `(?:^|[^>])>\\|?\\s*${p}(?:[\\s;|&()<>]|$)`, // `>|` clobbers too (qa R15 N15-1)
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
  (psql, pg_dump/restore, mysql/mysqldump; via docker only \`docker exec supabase-db psql …\`), since
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
            description: `Timeout in milliseconds. General commands: default ${TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}. Database commands (psql/pg_dump/pg_restore/mysql/mysqldump, incl. \`docker exec supabase-db psql\`): default ${DB_TIMEOUT_MS}, max ${DB_MAX_TIMEOUT_MS} — set this higher for a long TRUNCATE/COPY/migration on big tables.`,
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
        // Ruling 3c: plus exactly the stored secrets this command names as $SECRET_X.
        // Audit B3: withPmShimPath also pins DOCKER_CONFIG so a HOME override cannot move the docker config.
        env: { ...withPmShimPath(buildScrubbedEnv()), ...secretEnvForCommand(command) },
      });

      // Best-effort backstop for credential SHAPES (sk-…, KEY=…, JSON secret
      // fields) that reach stdout past the text guard above (audit 2026-09-22:
      // globs, cd-relative paths, interpreter one-liners). Encoded output
      // (base64, xxd) and unrecognised names still pass — the process-level
      // defence is buildScrubbedEnv. Redact before the cut so a key is never split;
      // stored secrets (ruling 3c) are scrubbed first for the same reason.
      const safeOut = redactCredentials(scrubSecrets(stdout));
      const trimmed =
        safeOut.length > MAX_OUTPUT
          ? safeOut.slice(0, MAX_OUTPUT) +
            `\n... (truncated, ${safeOut.length} total chars)`
          : safeOut;

      recordCall(command, 0);
      const result: { stdout: string; exit_code: number; stderr?: string } = {
        stdout: trimmed,
        exit_code: 0,
      };
      // Surface non-empty stderr even on success — many tools (npm, tsc, git,
      // curl -v) write progress/diagnostics there. Dropping it blinds the agent.
      if (stderr) result.stderr = redactCredentials(scrubSecrets(stderr)).slice(0, MAX_OUTPUT);
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
        stdout: redactCredentials(scrubSecrets(error.stdout ?? "")).slice(0, MAX_OUTPUT),
        stderr: redactCredentials(scrubSecrets(stderr)).slice(0, MAX_OUTPUT),
      });
    }
  },
};
