/**
 * V8.4 — deterministic gate-check runner (unlazy `gate-check.mjs`, ported).
 *
 * Runs each pending gate's CHECK as a subprocess, decides by EXPECT (substring
 * or /regex/) — or by exit code when there is no EXPECT — and records the
 * deciding tail of the output as evidence. Zero model tokens. A check that
 * times out is FAILED with that fact as evidence, and its whole process group
 * is killed (`feedback_jarvis_shell_test_saturation`: timeouts must kill
 * groups, not just the shell).
 *
 * The check runs with a MINIMAL environment (PATH/HOME/LANG/TZ + MC_TASK_ID),
 * never the service's full env — a gate is a proof, it must not become a
 * secret-bearing side channel. Every check command passes the SAME guard as
 * `shell_exec` (`validateShellCommand`: deny-list, command/process
 * substitution, secret-file reads, primary-checkout git mutation, unscoped
 * vitest) BEFORE it spawns — a plan-authored gate never widens the envelope
 * the model already has — and recorded evidence is secret-redacted (qa C1
 * 2026-08-16). EXPECT regexes run under a vm deadline on a capped haystack
 * so a pathological pattern cannot wedge the event loop (qa C2).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type Database from "better-sqlite3";
import { getDatabase } from "../../db/index.js";
import { getJarvisKbRoot } from "../../db/jarvis-fs.js";
import { pmShimMissing, validateShellCommand, withPmShimPath } from "../../tools/builtin/shell.js";
import { redactSecrets } from "../../api/mcp-server/redact.js";
import {
  MAX_EVIDENCE,
  freezeGates,
  gatesMode,
  isGradeRow,
  ledgerVerdict,
  listGates,
  parseAbandonLines,
  recordGateResult,
  type GateRow,
  type LedgerVerdict,
} from "./gates.js";
import {
  compareNumber,
  isComparatorExpect,
  lastNumber,
  parseExpect,
  safeRegexTest,
} from "./expect.js";
export { safeRegexTest } from "./expect.js";
import { probeLanding, type LandingExec } from "./landing.js";
import { isReadbackRow, runReadback } from "./readback.js";

export const DEFAULT_CHECK_TIMEOUT_MS = 60_000;
/** Wall-clock budget for one whole ledger evaluation (all gates, serial). */
export const DEFAULT_LEDGER_BUDGET_MS = 120_000;
const MAX_OUTPUT_BYTES = 256 * 1024;
/** EXPECT is matched against the LAST 64KB of output — the deciding lines live there. */
const MATCH_WINDOW_BYTES = 64 * 1024;

export interface CheckOutcome {
  ok: boolean;
  /** Deciding tail of stdout+stderr (capped), or the failure reason. */
  evidence: string;
  exitCode: number | null;
  timedOut: boolean;
  /**
   * The check command does not exist on the host (exit 127 + "not found"):
   * it observed nothing, so the ledger records ABANDONED with the reason,
   * never FAILED — a missing binary is not evidence against the criterion.
   */
  notRunnable?: boolean;
}

/** Nested/adjacent quantifiers — the catastrophic-backtracking shapes. Rejected outright. */
// dash: "/bin/sh: 1: gdocs_read: not found" · bash: "bash: gdocs_read: command
// not found" / "/bin/bash: line 1: gdocs_read: command not found".
const COMMAND_NOT_FOUND_RE =
  /^(?:\S*\/)?(?:ba|da)?sh: (?:line )?(?:\d+: )?\S+: (?:command )?not found\s*$/m;

/**
 * Shell variables a check reads that nobody defines at evaluation time. The
 * planner writes `test -n "$DOC_ID" && curl …` (task c4c6ae63 g-1.1) — the
 * variable lived inside the goal's own run; in the bare /bin/sh the harness
 * spawns it is empty, so the check observes nothing and must not FAIL the
 * criterion. `$?`, `$1`, `$$` are not names and are left alone.
 */
export function undefinedShellVars(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const names = new Set<string>();
  for (const m of command.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g)) {
    if (env[m[1]!] === undefined) names.add(m[1]!);
  }
  return [...names];
}

/**
 * Comparator (`gte N`, `between A B`) ⇒ the last non-empty line must be a bare
 * number that satisfies it; `/regex/flags` ⇒ RegExp test; anything else ⇒
 * substring match. Regex and substring run on the tail window.
 */
export function expectMatches(expect: string, output: string): boolean {
  const parsed = parseExpect(expect);
  if (parsed.kind === "cmp" || parsed.kind === "between") {
    const n = lastNumber(output);
    return n !== null && compareNumber(parsed, n);
  }
  const window =
    output.length > MATCH_WINDOW_BYTES
      ? output.slice(-MATCH_WINDOW_BYTES)
      : output;
  if (parsed.kind === "regex") {
    return safeRegexTest(parsed.pattern, parsed.flags, window);
  }
  return window.includes(parsed.text);
}

/** The last two non-empty lines, joined and secret-redacted — enough to see WHY, never a log dump. */
export function evidenceTail(output: string, max = MAX_EVIDENCE): string {
  const lines = output
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const last = lines.slice(-2).join(" | ");
  return redactSecrets(last || "(no output)").slice(0, max);
}

export type CheckExecutor = (
  command: string,
  opts: { cwd?: string; timeoutMs: number; taskId?: string },
) => Promise<{ output: string; exitCode: number | null; timedOut: boolean }>;

/** Default executor: /bin/sh -c in its own process group, killed whole on timeout. */
export const runShellCheck: CheckExecutor = (command, opts) =>
  new Promise((resolve) => {
    // Same fail-closed rule as shell_exec: no shim, no child (qa R4 W-1).
    const shimMissing = pmShimMissing();
    if (shimMissing) {
      resolve({ output: shimMissing, exitCode: 126, timedOut: false });
      return;
    }
    const child = spawn("/bin/sh", ["-c", command], {
      cwd: opts.cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      // Same package-manager shim as shell_exec — a check may not do what the tool may not do.
      env: withPmShimPath({
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: process.env.HOME ?? "/root",
        LANG: process.env.LANG ?? "C.UTF-8",
        TZ: process.env.TZ ?? "UTC",
        MC_TASK_ID: opts.taskId ?? "",
      }),
    });
    let buf = "";
    let timedOut = false;
    const append = (chunk: Buffer): void => {
      if (buf.length < MAX_OUTPUT_BYTES) {
        buf += chunk.toString("utf-8").slice(0, MAX_OUTPUT_BYTES - buf.length);
      }
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }, opts.timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        output: `spawn error: ${err.message}`,
        exitCode: null,
        timedOut,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // Same journal line as shell_exec: the shim's refusal is the gate's only live signal.
      if (buf.includes("[pm-shim] refused:")) console.error(`[pm-shim] refused (check_cmd): ${redactSecrets(command).slice(0, 300)}`);
      resolve({ output: buf, exitCode: code, timedOut });
    });
  });

export async function runCheck(
  row: Pick<GateRow, "check_cmd" | "expect">,
  opts: {
    cwd?: string;
    timeoutMs: number;
    exec: CheckExecutor;
    taskId?: string;
  },
): Promise<CheckOutcome> {
  if (!row.check_cmd) {
    return {
      ok: false,
      evidence: "no CHECK command",
      exitCode: null,
      timedOut: false,
    };
  }
  // Same guard as shell_exec — a check may not do what the tool may not do.
  const guard = validateShellCommand(row.check_cmd);
  if (!guard.allowed) {
    // Nothing ran, so nothing was observed: ABANDONED with the reason, not
    // FAILED — a guard-refused check (`$(...)`, task 35f4f5e5 on 2026-09-14)
    // must not demote a task whose deliverable was never examined.
    return {
      ok: false,
      notRunnable: true,
      evidence: `check rejected by shell guard: ${guard.reason ?? "blocked"}`,
      exitCode: null,
      timedOut: false,
    };
  }
  // The child shell always carries MC_TASK_ID (injected at spawn); the guard
  // must see the same, or every check that names it is abandoned before it
  // runs — the tweet ritual's gate was, nightly, 2026-09-04 → 09-11.
  const missingVars = undefinedShellVars(row.check_cmd, {
    ...process.env,
    MC_TASK_ID: opts.taskId ?? "",
  });
  if (missingVars.length > 0) {
    return {
      ok: false,
      notRunnable: true,
      evidence: `check references undefined variable(s) ${missingVars.map((v) => `$${v}`).join(", ")} — observes nothing`,
      exitCode: null,
      timedOut: false,
    };
  }
  const res = await opts.exec(row.check_cmd, {
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs,
    taskId: opts.taskId,
  });
  if (res.timedOut) {
    return {
      ok: false,
      evidence: `timed out after ${opts.timeoutMs}ms | ${evidenceTail(res.output, 200)}`,
      exitCode: res.exitCode,
      timedOut: true,
    };
  }
  // The shell's own "command not found" diagnostic: the command is not on the
  // host, so the check observed nothing. Keyed on the diagnostic LINE, not on
  // exit 127 — the planner writes pipelines (`gdocs_read … | grep -c Fase`)
  // whose exit status is the last stage's (grep → 1), verified against a real
  // /bin/sh run of the gate from task c4c6ae63 (2026-09-03: five gates FAILED
  // on `gdocs_read: not found` around a Doc whose read-back was MET).
  if (COMMAND_NOT_FOUND_RE.test(res.output)) {
    return {
      ok: false,
      notRunnable: true,
      evidence: `check command not found — observes nothing: ${evidenceTail(res.output, 200)}`,
      exitCode: res.exitCode,
      timedOut: false,
    };
  }
  // With an EXPECT the match decides (a check may exit non-zero by design);
  // without one, the exit code decides.
  const ok = row.expect
    ? expectMatches(row.expect, res.output)
    : res.exitCode === 0;
  const tail = evidenceTail(res.output);
  // A comparator against a non-numeric last line is a FAILED gate that says
  // so — never a pass, never a silent skip (the fix is in the check command).
  const notANumber =
    !ok &&
    !!row.expect &&
    isComparatorExpect(row.expect) &&
    lastNumber(res.output) === null;
  return {
    ok,
    evidence: ok
      ? tail
      : `${notANumber ? "not a number: " : ""}${tail} (exit ${res.exitCode ?? "?"})`,
    exitCode: res.exitCode,
    timedOut: false,
  };
}

/**
 * Where a shell check runs when the caller gave no cwd. 2026-10-08 (swarm
 * task 19b7d51a): no caller passes `cwd`, so every check ran in the service's
 * WorkingDirectory (the mission-control checkout). Three heavy swarm children
 * declared checks on KB-relative paths (`grep -c 'Índice propuesto'
 * projects/bet-book/README.md`, `wc -c < projects/bet-book/marco-legal-…md`);
 * all nine FAILED on "No such file or directory" while the read-back gates on
 * the same files were MET, parent re-verify demoted 3 of 5 goals and the swarm
 * reported `failed`. Replayed from the KB root, all nine pass. A relative path
 * that is missing from the checkout but present under the KB root names a KB
 * file — the deliverable the child wrote — so the check runs there. A path
 * missing in BOTH places still runs in the default cwd and still FAILS: a
 * deliverable that was never written is the right verdict. An explicit cwd
 * always wins. Never moved (qa W1/W3): a write-shaped command — the shell
 * guard's `directives/` deny and write indicators match absolute paths only,
 * so `: > directives/core.md` would truncate the live KB file once moved;
 * checks are observations — and a mixed command that also names a
 * checkout-only path (ambiguous; the old cwd is kept).
 */
const CHECK_WRITE_WORDS = new Set([
  "tee", "cp", "mv", "touch", "mkdir", "rm", "truncate", "dd", "install", "ln",
]);
const SAFE_REDIRECT_TARGET_RE = /^(?:\/dev\/(?:null|stdout|stderr)|&\d*-?)$/;

/** True when the command could write a file: a redirect to a real target, or a write verb. */
export function isWriteShapedCheck(command: string): boolean {
  // Quoted strings are arguments (grep patterns), never redirects or verbs.
  const bare = command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "Q");
  for (const m of bare.matchAll(/(>\||>>|>)\s*([^\s;|<>()]*)/g)) {
    if (!SAFE_REDIRECT_TARGET_RE.test(m[2]!)) return true;
  }
  for (const segment of bare.split(/[|;&()`\n]+/)) {
    const words = segment.trim().split(/\s+/).map((w) => w.replace(/^.*\//, ""));
    if (words.some((w) => CHECK_WRITE_WORDS.has(w))) return true;
    if (
      words.some((w) => w === "sed" || w === "perl") &&
      words.some((w) => /^-[A-Za-z]*i/.test(w) || w.startsWith("--in-place"))
    ) {
      return true;
    }
  }
  return false;
}

export function resolveCheckCwd(
  checkCmd: string,
  deps: {
    cwd?: string;
    kbRoot?: string;
    processCwd?: string;
    exists?: (p: string) => boolean;
  } = {},
): string | undefined {
  if (deps.cwd !== undefined) return deps.cwd;
  if (isWriteShapedCheck(checkCmd)) return undefined;
  const exists = deps.exists ?? existsSync;
  const processCwd = deps.processCwd ?? process.cwd();
  let kbRoot: string | undefined;
  let kbOnly = false;
  for (const raw of checkCmd.split(/[\s|;&<>()]+/)) {
    const token = raw.replace(/^['"]+|['"]+$/g, "");
    if (!token.includes("/") || token.includes("://")) continue;
    if (/^(?:\/|\.\.?\/|~|\$|-)/.test(token)) continue;
    kbRoot ??= deps.kbRoot ?? getJarvisKbRoot();
    const inCheckout = exists(resolvePath(processCwd, token));
    const inKb = exists(resolvePath(kbRoot, token));
    if (inCheckout && !inKb) return undefined; // mixed command: keep the old cwd
    if (inKb && !inCheckout) kbOnly = true;
  }
  return kbOnly ? kbRoot : undefined;
}

export interface EvaluateOptions {
  taskId: string;
  /** The model's final report — ABANDON lines are honored from here; landing claims are read from here. */
  outputText?: string;
  cwd?: string;
  /** Re-run checks that already passed (parent re-verification). */
  rerun?: boolean;
  timeoutMs?: number;
  exec?: CheckExecutor;
  landingExec?: LandingExec;
  landingRepoDir?: string;
  /**
   * False for container-executed tasks (nanoclaw / containerized heavy): the
   * host tree is NOT the tree the work happened in, so a shell check here
   * would prove nothing (or manufacture a false green). Shell gates are then
   * left pending (unverified) and counted in `shellSkipped`; the landing gate
   * is the container task's proof. Default true (host in-process runners).
   */
  shellGatesRunnable?: boolean;
  /** Wall-clock budget across the whole evaluation; gates past it stay pending. */
  budgetMs?: number;
  db?: Database.Database;
}

export interface EvaluateResult extends LedgerVerdict {
  ran: number;
  abandonedNow: number;
  /** Shell gates left pending because the task ran in a container. */
  shellSkipped: number;
  /** Runnable gates left pending because the ledger time budget ran out. */
  budgetExhausted: number;
  rows: GateRow[];
}

function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Freeze → honor ABANDON lines → run every runnable pending (or, on rerun,
 * every non-abandoned) gate → adjudicate. Never called when the mode is off
 * (callers gate on `gatesMode()`); safe to call twice — met rows are only
 * re-run when `rerun` is set.
 */
export async function evaluateLedger(
  opts: EvaluateOptions,
): Promise<EvaluateResult> {
  const db = opts.db ?? getDatabase();
  const timeoutMs =
    opts.timeoutMs ??
    envPositiveInt("TASK_GATES_CHECK_TIMEOUT_MS", DEFAULT_CHECK_TIMEOUT_MS);
  const budgetMs =
    opts.budgetMs ??
    envPositiveInt("TASK_GATES_LEDGER_BUDGET_MS", DEFAULT_LEDGER_BUDGET_MS);
  const shellGatesRunnable = opts.shellGatesRunnable ?? true;
  const startedAt = Date.now();
  const exec = opts.exec ?? runShellCheck;
  freezeGates(opts.taskId, db);
  let rows = listGates(opts.taskId, db);
  let abandonedNow = 0;
  if (opts.outputText) {
    // Read-back gates are harness proofs: a model-authored ABANDON line can
    // never surrender one (R1 audit C2 — "Surrender is visible" must not
    // become "a proof can be voided by one line"). V9 W1 grade gates (GR-*)
    // are the same: the grader's verdict is not the model's to void.
    const known = new Set(
      rows
        .filter((r) => !isReadbackRow(r) && !isGradeRow(r))
        .map((r) => r.gate_id),
    );
    for (const a of parseAbandonLines(opts.outputText)) {
      if (!known.has(a.gateId)) continue;
      if (
        recordGateResult(
          opts.taskId,
          a.gateId,
          { state: "abandoned", reason: a.reason },
          db,
        )
      ) {
        abandonedNow++;
      }
    }
    rows = listGates(opts.taskId, db);
  }
  let ran = 0;
  let shellSkipped = 0;
  let budgetExhausted = 0;
  for (const row of rows) {
    if (row.state === "abandoned") continue;
    if (row.state === "met" && !opts.rerun) continue;
    // Manual rows are never flipped HERE — incl. V9 W1 grade gates (GR-*),
    // which the consumer grades once before this runs (grade-specs.ts).
    if (row.check_kind === "manual" && !isReadbackRow(row)) continue;
    if (Date.now() - startedAt > budgetMs) {
      budgetExhausted++;
      continue;
    }
    if (isReadbackRow(row)) {
      // Phase 2 read-back: re-read the artifact the write claimed, through
      // the same API, and compare (src/lib/v8-4/readback.ts). Shares the
      // ledger budget; its own 15 s cap applies inside runReadback.
      const verdict = await runReadback(row, timeoutMs);
      ran++;
      recordGateResult(
        opts.taskId,
        row.gate_id,
        verdict.ok
          ? { state: "met", evidence: verdict.evidence }
          : { state: "failed", evidence: verdict.evidence },
        db,
      );
      continue;
    }
    if (row.check_kind === "shell") {
      if (!shellGatesRunnable) {
        shellSkipped++;
        continue;
      }
      const cwd = resolveCheckCwd(row.check_cmd ?? "", { cwd: opts.cwd });
      const ranInKb = opts.cwd === undefined && cwd !== undefined;
      const outcome = await runCheck(row, {
        cwd,
        timeoutMs: Math.min(
          timeoutMs,
          Math.max(1, budgetMs - (Date.now() - startedAt)),
        ),
        exec,
        taskId: opts.taskId,
      });
      ran++;
      // The ledger row says where the check ran when it was redirected; an
      // abandoned row (nothing ran) keeps its plain reason.
      if (ranInKb && !outcome.notRunnable) {
        outcome.evidence = `[cwd=kb] ${outcome.evidence}`.slice(0, MAX_EVIDENCE);
      }
      if (outcome.notRunnable) abandonedNow++;
      recordGateResult(
        opts.taskId,
        row.gate_id,
        outcome.notRunnable
          ? {
              state: "abandoned",
              reason: outcome.evidence.slice(0, MAX_EVIDENCE),
            }
          : outcome.ok
            ? { state: "met", evidence: outcome.evidence }
            : { state: "failed", evidence: outcome.evidence },
        db,
      );
    } else if (row.check_kind === "landing") {
      const probe = await probeLanding({
        text: opts.outputText ?? "",
        repoDir: opts.landingRepoDir,
        exec: opts.landingExec,
        timeoutMs,
      });
      ran++;
      if (probe.landed === true) {
        recordGateResult(
          opts.taskId,
          row.gate_id,
          { state: "met", evidence: probe.evidence },
          db,
        );
      } else if (probe.landed === false) {
        recordGateResult(
          opts.taskId,
          row.gate_id,
          { state: "failed", evidence: probe.evidence },
          db,
        );
      }
      // landed === null: no claim to verify — stays pending (unverified), never silently met.
    }
  }
  const finalRows = listGates(opts.taskId, db);
  return {
    ...ledgerVerdict(finalRows),
    ran,
    abandonedNow,
    shellSkipped,
    budgetExhausted,
    rows: finalRows,
  };
}

/** True when the ledger has at least one gate a Stop hook could act on (a runnable check). */
export function hasRunnableGates(rows: readonly GateRow[]): boolean {
  return rows.some((r) => r.state !== "abandoned" && r.check_kind !== "manual");
}

export { gatesMode };
