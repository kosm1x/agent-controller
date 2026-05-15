/**
 * Flailing guard for shell_exec — the "3-strike rule" in code.
 *
 * Background: an LLM runner stuck on an upstream failure (expired auth cookies,
 * blocked anti-bot, unreachable host) will write the same kind of script over
 * and over with cosmetic variations, blowing minutes of wall time and dozens
 * of tool calls before escalating. The 2026-05-15 tweet-4 incident produced 12
 * variations of a Playwright tweet poster in 13 minutes, all failing on the
 * same 401 from x.com, before the runner finally surfaced the problem.
 *
 * This guard sits in front of `shell_exec`. It records each call's command +
 * exit code in a small in-process ring buffer, and when a new call shares a
 * significant token with ≥3 prior failures inside a short window, the new call
 * is short-circuited with a clear "STOP and escalate" instruction. The runner's
 * next turn then naturally pivots to surfacing the problem to the operator
 * rather than writing variation N+1.
 *
 * Why process-global (not per-task)
 *   Two concurrent tasks sharing a 6+ char non-stopword token in their shell
 *   commands inside a 5-min window is essentially never. The signal is highly
 *   distinctive; per-task isolation would cost AsyncLocalStorage plumbing
 *   across the runner and SDK paths for negligible accuracy gain. If it ever
 *   does false-positive, the runner's escalation message is still actionable
 *   (operator sees what was attempted), so the failure mode is "stops slightly
 *   early" not "ships bad code."
 */

interface CallRecord {
  command: string;
  exitCode: number;
  tokens: Set<string>;
  ts: number;
}

/** Tokens too generic to be meaningful flailing signals. Path components,
 *  common binaries, project names — anything that would tie unrelated calls
 *  together by sheer coincidence. */
const STOPWORDS = new Set([
  "node",
  "bash",
  "sh",
  "cd",
  "tmp",
  "root",
  "home",
  "claude",
  "mission",
  "control",
  "jarvis",
  "cjs",
  "mjs",
  "json",
  "yaml",
  "yml",
  "tsx",
  "usr",
  "etc",
  "bin",
  "tools",
  "scripts",
  "dist",
  "src",
  "test",
  "tests",
  "data",
  "true",
  "false",
  "null",
  "default",
  "files",
  "file",
  "name",
  "path",
  "exec",
  "echo",
  "grep",
  "find",
  "head",
  "tail",
  "cat",
  "less",
  "more",
  "awk",
  "sed",
  "sort",
  "uniq",
  "wc",
  "tee",
  "curl",
  "wget",
  "ssh",
  "scp",
  "rsync",
  "tar",
  "gzip",
  "zip",
  "unzip",
  "ls",
  "mv",
  "cp",
  "mkdir",
  "touch",
  "ln",
  "ps",
  "top",
  "kill",
  "npm",
  "npx",
  "yarn",
  "pnpm",
  "python",
  "python3",
  "pip",
  "venv",
  "git",
  "branch",
  "commit",
  "diff",
  "status",
  "log",
  "module",
  "modules",
  "package",
  "lock",
  "config",
  "env",
  "vars",
  "stdout",
  "stderr",
  "stdin",
  "output",
  "input",
  "build",
  "watch",
  "serve",
  "start",
  "run",
  "stop",
  "restart",
]);

/** Sliding window — older entries fall off. The signal we care about (LLM
 *  loop) lives entirely inside one turn, which is typically <5 min. */
const WINDOW_MS = 5 * 60 * 1000;
const RING_SIZE = 10;
/** Strike count that triggers a block. Three prior failures sharing a token
 *  with the current call is the threshold; the call attempted next is the
 *  one that gets short-circuited. */
const STRIKE_LIMIT = 3;
const MIN_TOKEN_LEN = 6;

const history: CallRecord[] = [];

/** Prefix lengths emitted per base token. Lets `tweet4_v1` and `tweet4_v2`
 *  collide on `tweet4` even though their full strings differ. Cardinality is
 *  bounded by base-token count, keeping the check O(buffer * tokens). */
const PREFIX_LENGTHS = [6, 8, 10, 12];

/** Extract significant tokens from a command line: alphanumeric runs of
 *  length ≥ MIN_TOKEN_LEN that aren't stopwords, plus fixed-length prefixes
 *  of those runs so version/suffix variants (`_v1` vs `_v2`, `_final` vs
 *  `_login`) still collide on their shared stem. */
export function extractTokens(command: string): Set<string> {
  const out = new Set<string>();
  const lc = command.toLowerCase();
  // Split on anything that isn't an alphanumeric or underscore. Hyphens split
  // intentionally: a flag like `--no-cache` is two tokens, not one.
  for (const raw of lc.split(/[^a-z0-9_]+/)) {
    if (raw.length < MIN_TOKEN_LEN) continue;
    if (STOPWORDS.has(raw)) continue;
    if (/^\d+$/.test(raw)) continue; // pure-numeric (timestamps, ports)
    out.add(raw);
    for (const len of PREFIX_LENGTHS) {
      if (raw.length <= len) break;
      const prefix = raw.slice(0, len);
      if (STOPWORDS.has(prefix)) continue;
      if (/^\d+$/.test(prefix)) continue;
      out.add(prefix);
    }
  }
  return out;
}

/** Drop entries older than the window. Mutates `history` in place. */
function prune(now: number): void {
  while (history.length > 0 && now - history[0].ts > WINDOW_MS) {
    history.shift();
  }
  while (history.length > RING_SIZE) {
    history.shift();
  }
}

/** Inspect the current command against history. Returns the shared token
 *  and matching count if the strike limit is met, otherwise null. */
export function checkFlailing(
  command: string,
  now: number = Date.now(),
): { token: string; strikes: number } | null {
  prune(now);
  const tokens = extractTokens(command);
  if (tokens.size === 0) return null;

  // For each candidate token, count prior FAILED entries sharing it.
  for (const token of tokens) {
    let strikes = 0;
    for (const rec of history) {
      if (rec.exitCode === 0) continue;
      if (rec.tokens.has(token)) strikes++;
    }
    if (strikes >= STRIKE_LIMIT) {
      return { token, strikes };
    }
  }
  return null;
}

/** Record a completed shell_exec invocation. */
export function recordCall(
  command: string,
  exitCode: number,
  now: number = Date.now(),
): void {
  prune(now);
  history.push({
    command,
    exitCode,
    tokens: extractTokens(command),
    ts: now,
  });
}

/** Test-only: wipe the ring. Production code never calls this. */
export function _resetFlailingGuard(): void {
  history.length = 0;
}

/** Build the stop-message the LLM sees instead of the 4th attempt's output.
 *  Phrased as an instruction to the LLM, not a generic error — Jarvis's next
 *  turn should escalate to the operator. */
export function buildFlailingBlockMessage(
  token: string,
  strikes: number,
): string {
  return [
    `FLAILING DETECTED — your last ${strikes} shell_exec calls sharing token "${token}" all failed.`,
    `Per the 3-strike rule, STOP. Do not write another variation of this command.`,
    `Reply to the user now: explain what was attempted, why it kept failing (read the prior errors in your context), and what they can do to unblock you (refresh credentials, post manually, retry from a different network, etc.).`,
    `If you genuinely believe a different approach (not a cosmetic variant) is worth trying, name it in your reply and wait for the user to confirm.`,
  ].join(" ");
}
