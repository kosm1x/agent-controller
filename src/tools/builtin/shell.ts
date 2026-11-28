/**
 * Shell execution tool: runs a command with a timeout and an output limit after
 * the command text check, which lives in shell-check.ts.
 */

import { exec, spawn } from "child_process";
import { existsSync } from "fs";
import { promisify } from "util";
import type { Tool } from "../types.js";
import { homedir } from "os";
import { dirname, resolve as resolvePath } from "path";
import { fileURLToPath } from "url";
import { validateShellCommand } from "./shell-check.js";
import {
  buildFlailingBlockMessage,
  checkFlailing,
  recordCall,
} from "../flailing-guard.js";
import { redactCredentials, redactSecrets } from "../../api/mcp-server/redact.js";
import { scrubSecrets, secretEnvForCommand } from "../../lib/secret-refs.js";
import { noStoredLoginEnv } from "../../mcp/env-deny.js";
import { agentGithubEnv, redactAgentToken } from "../../lib/github-authority.js";
import { currentRunTaskId } from "../rule-of-two.js";

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

/** `{ MC_TASK_ID }` for the current run's task; `{}` outside a run (queue 4aa). */
function taskIdEnv(): NodeJS.ProcessEnv {
  const taskId = currentRunTaskId();
  return taskId ? { MC_TASK_ID: taskId } : {};
}

/**
 * Package-manager PATH shim (dependency trust audit 2026-09-16). The directory
 * ships next to this module in src/ and dist/ (build copies it), and in the
 * sandbox through the read-only dist mount. Every package-manager name in it is
 * a symlink to pm-shim.sh, which passes read-only verbs to the real binary and
 * refuses installs, registry/auth changes and registry execution — in every
 * shell spelling, because name lookup happens after expansion. The command text
 * check in shell-check.ts is another layer.
 */
export const PM_SHIM_DIR = resolvePath(dirname(fileURLToPath(import.meta.url)), "pm-shim");

/**
 * pip inside venvs only (operator ruling 2026-10-21, queue 4ae): pip refuses to run outside a virtualenv
 * on every entry point (`pip`, `python -m pip`, `-mpip`, `pip.main()`), and its command line > env >
 * config precedence means `pip config set` cannot undo it. Only the literal `--isolated` argv token
 * makes pip ignore it — refused by the string gate (checkEnvReset), with a `PIP_*` name as PIP_ENV_NAME_RE spells it.
 */
export const PIP_VENV_ENV = { PIP_REQUIRE_VIRTUALENV: "1" } as const;

/**
 * PATH with the shim directory first (and nowhere else), `DOCKER_CONFIG` pinned (audit B3,
 * see withDockerConfig) and PIP_VENV_ENV set — so every caller (shell_exec and the task_gates
 * check_cmd child in gate-check.ts) gets all three from one place.
 */
export function withPmShimPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const rest = (env.PATH ?? "/usr/local/bin:/usr/bin:/bin").split(":").filter((d) => d !== PM_SHIM_DIR);
  return withDockerConfig({ ...env, ...PIP_VENV_ENV, PATH: [PM_SHIM_DIR, ...rest].join(":") });
}

/**
 * Output masking for every shell_exec stdout/stderr return: the agent's token
 * by VALUE (whatever its shape), stored secrets (ruling 3c), then credential
 * shapes. Runs before any cut so nothing is split.
 */
function maskShellOutput(text: string): string {
  return redactCredentials(scrubSecrets(redactAgentToken(text)));
}

/**
 * GitHub children run under the agent's own account: children get no stored login by default.
 * The env gets the no-stored-login settings (an empty `GH_CONFIG_DIR`, git's credential helpers
 * reset) and, when it is configured, the agent's own token as `GH_TOKEN`
 * with the github.com credential helper that reads it — so `gh` or `git push` typed in the shell
 * runs as the agent. `GH_TOKEN` is the ONE secret-shaped name added back after the
 * buildScrubbedEnv scrub, on purpose: it is the agent's own login, limited to what the operator
 * granted that account, and output masking (maskShellOutput) covers its value and its shape.
 */
export function withAgentGithubEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, ...noStoredLoginEnv(), ...(agentGithubEnv() ?? {}) };
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

// The command validation guard lives in shell-check.ts; its exported names are re-exported here.
export {
  DENY_COMMANDS,
  effectiveBaseCommand,
  commandWords,
  checkUnscopedTestRun,
  ENV_RESET_WORDS,
  checkEnvReset,
  checkPackageManagerRaw,
  checkPackageManagerMutation,
  checkPrimaryMcGitMutation,
  validateShellCommand,
} from "./shell-check.js";

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
- Running build commands and scoped tests (npx tsc, python scripts, npx vitest run <path/to/file.test.ts>); an unscoped test run (npm test, a bare npx vitest run) is refused
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
        // Queue 4aa: MC_TASK_ID names the current run's task (absent outside a run) so a
        // child can bind a receipt to it; the gate harness injects the same name.
        env: {
          ...withAgentGithubEnv(withPmShimPath(buildScrubbedEnv())),
          ...secretEnvForCommand(command),
          ...taskIdEnv(),
        },
      });

      // Best-effort backstop for credential SHAPES (sk-…, KEY=…, JSON secret
      // fields) that reach stdout past the text guard above (audit 2026-09-22:
      // globs, cd-relative paths, interpreter one-liners). Encoded output
      // (base64, xxd) and unrecognised names still pass — the process-level
      // defence is buildScrubbedEnv. Redact before the cut so a key is never split;
      // stored secrets (ruling 3c) are scrubbed first for the same reason.
      const safeOut = maskShellOutput(stdout);
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
      if (stderr) result.stderr = maskShellOutput(stderr).slice(0, MAX_OUTPUT);
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
        stdout: maskShellOutput(error.stdout ?? "").slice(0, MAX_OUTPUT),
        stderr: maskShellOutput(stderr).slice(0, MAX_OUTPUT),
      });
    }
  },
};
