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
 *
 * Ritual exemption (2026-05-24, P1+P2 evolution-log diagnosis)
 *   The evolution-log ritual legitimately runs ~15 sequential `mc-ctl db
 *   "SELECT ..."` calls and ~3 sequential `curl http://localhost:8080/api/...`
 *   calls to assemble the daily entry. Token extraction collides on "select"
 *   and "localhost", tripping FLAILING strikes mid-ritual. Each blocked call
 *   then steered Jarvis toward writing "API unreachable" in the log even though
 *   the loopback was healthy. Per-task ALS is the right plumbing here despite
 *   the comment above: the cost is a single wrap at the dispatcher's
 *   runner.execute() seam (not per-tool), and rituals are the one class of
 *   task where the legitimate signal/strike-noise ratio inverts.
 *
 *   Sub-task inheritance: if a ritual ever spawns a sub-task (swarm/batch
 *   dispatch from inside the runner's tool loop), that sub-task INHERITS the
 *   exemption because ALS stores propagate down the async chain. This is
 *   intentional for the current ritual set (all `fast` agent type, no sub-task
 *   spawn). If a future ritual is changed to spawn a swarm whose sub-tasks
 *   legitimately need flailing protection, wrap each dispatchWithSlot in
 *   `ritualContext.run({ ritualId: '' }, ...)` for non-ritual children and
 *   gate `isInRitualContext()` on non-empty ritualId.
 */

import { AsyncLocalStorage } from "async_hooks";

/** Set by the dispatcher around `runner.execute()` for ritual-tagged
 *  submissions. When a store exists, the guard is fully bypassed: no strikes
 *  checked, no calls recorded. Recording must also be skipped so the ritual's
 *  legitimate-but-repeating SELECT/curl chain doesn't poison the buffer for
 *  the next non-ritual task that runs within the 5-min window. */
export const ritualContext = new AsyncLocalStorage<{ ritualId: string }>();

/** Returns true when the current async context is inside a ritual task. */
export function isInRitualContext(): boolean {
  return ritualContext.getStore() !== undefined;
}

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

/** Read-only diagnostic commands exempt from strike ENFORCEMENT (Phase 4
 *  fold-in, 2026-08-23 ant-colony incident): after three failing
 *  `curl https://ant-colony…` calls, the FIRST `journalctl -u caddy …
 *  ant-colony` — a novel command that would have revealed no ACME attempt
 *  existed — was blocked because it shared the "colony" token. Blocking
 *  novel diagnostics converts "stop flailing" into "stop diagnosing", and
 *  the model then theorizes instead of reading logs.
 *
 *  Exemption is ENFORCEMENT-only: diagnostic calls still record their
 *  failures (recordCall is unchanged), so a loop of failing greps still
 *  strikes the next WRITE-class variation. Network mutators (curl, wget)
 *  stay enforced — they were the original flailing class. */
const DIAG_SIMPLE = new Set([
  // journalctl is handled by its own allow-by-membership branch below.
  "dmesg",
  "ss",
  "netstat",
  // NOT `ip` (`ip link set … down` mutates), NOT `date` (`date -s` sets the
  // clock), NOT `env` (it is a WRAPPER — `env curl …` must be judged as
  // curl), NOT bare `find` (`-delete`/`-exec` mutate — see DIAG_FIND below).
  // R1 audit C2 (2026-08-23).
  "ping",
  "dig",
  "host",
  "nslookup",
  "traceroute",
  "ps",
  "pgrep",
  "lsof",
  "df",
  "du",
  "free",
  "uptime",
  "uname",
  "whoami",
  "id",
  "stat",
  "readlink",
  "which",
  "whereis",
  "type",
  "wc",
  "md5sum",
  "sha1sum",
  "sha256sum",
  "grep",
  "egrep",
  "fgrep",
  "zgrep",
  "cat",
  "head",
  "tail",
  "ls",
  "tr",
  "cut",
  "column",
  "jq",
  "strings",
  "printenv",
]);
// R3 audit C1 (3-strike rule — flag-subtraction failed three rounds):
// membership above is now a POSITIVE property — a binary is listed only if
// it has NO write or exec mode under ANY flag. Dropped for having one:
// `sort` (-o/-uo), `uniq` (IN OUT), `xxd` (IN OUT, -r), `rg` (--pre CMD
// executes it), `file` (-C compiles magic), `hostname` (sets it), `ip`,
// `date`, `env`, bare `find`. The four flag-guarded exceptions below are
// the only binaries where a mutating MODE hides behind flags.

/** `find` mutates through these; a find carrying any of them is enforced. */
const FIND_MUTATING_RE = /-(delete|exec|execdir|ok|okdir|fprint\w*|fls)\b/;

/** The only flag-guarded exceptions: binaries whose mutating modes hide
 *  behind flags (R2 W3, hardened R3 C1). `letters` are dangerous SHORT
 *  flags checked by set-membership inside each `-abc` bundle — a regex
 *  `\b` cannot see inside `-Cw`/`-uo` bundles, which is how R2's fix was
 *  defeated. `longRe` covers `--long` forms (no bundling there). */
const DANGEROUS_FLAGS: Record<string, { letters?: string; longRe?: RegExp }> = {
  dmesg: { letters: "CcDEn", longRe: /^--(clear|console|read-clear)/ },
  ss: { letters: "K", longRe: /^--kill/ },
  git: { longRe: /^--output/ },
};

/** journalctl is the one binary where flag-DENY enumeration failed four
 *  audit rounds in a row (R1 `\n`, R2 vacuum/rotate/…, R3 bundling, R4
 *  --cursor-file/--update-catalog/--smart-relinquish-var — the first a
 *  proven root file-write). Inverted to ALLOW-by-membership (R4 C1): an
 *  option not on this list simply loses the exemption — the command still
 *  runs, it just stays under normal strike enforcement (fail-safe).
 *  Positional args are journal match expressions (reads) — always fine. */
const JOURNALCTL_SHORT_ALLOW = new Set([..."abcDefFgkmMnNopqrStuUx"]);
const JOURNALCTL_LONG_ALLOW = new Set([
  "unit",
  "user-unit",
  "user",
  "system",
  "follow",
  "lines",
  "output",
  "output-fields",
  "since",
  "until",
  "priority",
  "grep",
  "case-sensitive",
  "boot",
  "dmesg",
  "no-pager",
  "no-full",
  "full",
  "all",
  "reverse",
  "catalog",
  "quiet",
  "utc",
  "identifier",
  "facility",
  "merge",
  "no-hostname",
  "disk-usage",
  "list-boots",
  "header",
  "directory",
  "file",
  "root",
  "namespace",
  "no-tail",
  // R5 verify: read-only options that were losing the exemption for no
  // safety gain.
  "cursor",
  "after-cursor",
  "show-cursor",
  "fields",
  "field",
  "machine",
  "list-catalog",
  "dump-catalog",
  "verify",
  "truncate-newline",
]);

/** True iff every flag on a journalctl segment is on the allow-list. */
function journalctlFlagsAllowed(args: string[]): boolean {
  for (const w of args) {
    // R5 audit W1: a negative NUMBER is an option value ("-b -1",
    // "--since -1h"), not a flag — must not cost the exemption.
    if (/^-\d/.test(w)) continue;
    if (w.startsWith("--")) {
      const name = w.slice(2).split("=")[0];
      if (!JOURNALCTL_LONG_ALLOW.has(name)) return false;
    } else if (w.startsWith("-") && w.length > 1) {
      for (const ch of w.slice(1)) {
        if (!JOURNALCTL_SHORT_ALLOW.has(ch)) return false;
      }
    }
  }
  return true;
}

/** True when any arg after the binary carries a dangerous flag — bundled
 *  short letters included. */
function hasDangerousFlag(
  args: string[],
  spec: { letters?: string; longRe?: RegExp },
): boolean {
  for (const w of args) {
    if (w.startsWith("--")) {
      if (spec.longRe?.test(w)) return true;
    } else if (w.startsWith("-") && w.length > 1 && spec.letters) {
      for (const ch of w.slice(1)) {
        if (spec.letters.includes(ch)) return true;
      }
    }
  }
  return false;
}

/** Binaries that are diagnostic only under specific subcommands. The
 *  subcommand is the first token, NOT a flag-skip scan — `git -C /x push`
 *  reads "/x" as the subcommand and correctly fails the allow-list. */
const DIAG_SUBCOMMANDS: Record<string, Set<string>> = {
  systemctl: new Set([
    "status",
    "is-active",
    "is-enabled",
    "is-failed",
    "list-units",
    "list-unit-files",
    "list-timers",
    "list-sockets",
    "show",
    "cat",
  ]),
  caddy: new Set(["validate", "version", "list-modules"]),
  docker: new Set([
    "ps",
    "logs",
    "inspect",
    "images",
    "version",
    "info",
    "stats",
    "top",
    "port",
  ]),
  // NOT `branch`/`remote` — `git branch -D x` and `git remote set-url`
  // mutate (R1 audit C2).
  git: new Set(["status", "log", "diff", "show", "describe", "rev-parse"]),
};

/** True when EVERY top-level segment of the command is a read-only
 *  diagnostic. Scope after three audit rounds (R1 C2, R2 C1/W3, R3 C1):
 *  DIAG_SIMPLE holds only binaries with NO write/exec mode under any flag;
 *  journalctl/dmesg/ss/git are admitted behind bundling-proof dangerous-
 *  flag checks; `find` behind FIND_MUTATING_RE; systemctl/caddy/docker/git
 *  behind first-token subcommand allow-lists. Everything else — an unknown
 *  binary, a real redirect, command substitution, a parse ambiguity —
 *  returns false and stays under normal enforcement (fails toward
 *  "blocked like today"). This is a strike-ENFORCEMENT exemption inside
 *  shell_exec's own guard, not a security boundary: validateShellCommand
 *  still screens every command first. */
export function isReadOnlyDiagnostic(command: string): boolean {
  // Strip harmless redirects, then refuse any remaining `>` (file writes
  // via `awk … > out`, `tee`, etc. are not diagnostics).
  const stripped = command
    .replace(/2>&1/g, " ")
    .replace(/[12&]?>>?\s*\/dev\/null/g, " ");
  if (stripped.includes(">")) return false;
  // Command substitution runs an inner command this parser never sees —
  // refuse (validateShellCommand also blocks these upstream; belt+braces).
  if (/\$\(|`/.test(stripped)) return false;

  // Segment split must mirror /bin/sh -c: NEWLINE, `;` and single `&`
  // (background) are all top-level separators (R1 C2 + R2 C1 —
  // "journalctl -u caddy & curl -X POST …" is two commands). `&&` yields
  // an empty middle segment, which the loop skips.
  const segments = stripped.split(/[\n;&]|\|\||\|/);
  let realSegments = 0;
  for (const seg of segments) {
    if (seg.trim() === "") continue; // empty side of a trailing separator
    realSegments++;
    const words = seg.trim().split(/\s+/).filter(Boolean);
    // Drop wrappers and env assignments: `sudo`, `command`, `env`,
    // `timeout 30`, `FOO=bar`. `env` is a wrapper, not a diagnostic —
    // `env curl …` must be judged as curl (R1 audit C2).
    while (words.length > 0) {
      const w = words[0];
      if (w === "sudo" || w === "command" || w === "env") {
        words.shift();
      } else if (w === "timeout" && /^\d/.test(words[1] ?? "")) {
        words.shift();
        words.shift();
      } else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
        words.shift();
      } else {
        break;
      }
    }
    const bin = words[0];
    if (!bin) return false;
    const base = bin.slice(bin.lastIndexOf("/") + 1);
    if (base === "find") {
      // find is diagnostic only without its mutating actions.
      if (!FIND_MUTATING_RE.test(seg)) continue;
      return false;
    }
    if (base === "journalctl") {
      // R4 C1: allow-by-membership — an unknown flag loses the exemption.
      if (journalctlFlagsAllowed(words.slice(1))) continue;
      return false;
    }
    // R2 W3 / R3 C1: a flag-guarded binary running in a mutating mode is
    // enforced — bundled short flags included.
    const teeth = DANGEROUS_FLAGS[base];
    if (teeth && hasDangerousFlag(words.slice(1), teeth)) return false;
    if (DIAG_SIMPLE.has(base)) continue;
    const subs = DIAG_SUBCOMMANDS[base];
    if (subs) {
      const sub = words[1];
      if (sub && subs.has(sub)) continue;
    }
    return false;
  }
  return realSegments > 0;
}

/** Inspect the current command against history. Returns the shared token
 *  and matching count if the strike limit is met, otherwise null. */
export function checkFlailing(
  command: string,
  now: number = Date.now(),
): { token: string; strikes: number } | null {
  if (isInRitualContext()) return null;
  // Enforcement-only exemption — recordCall still logs these, so failing
  // diagnostics keep striking subsequent write-class variations.
  if (isReadOnlyDiagnostic(command)) return null;
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
  if (isInRitualContext()) return;
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
