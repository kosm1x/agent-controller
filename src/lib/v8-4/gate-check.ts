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
import vm from "node:vm";
import type Database from "better-sqlite3";
import { getDatabase } from "../../db/index.js";
import { validateShellCommand } from "../../tools/builtin/shell.js";
import { redactSecrets } from "../../api/mcp-server/redact.js";
import {
  MAX_EVIDENCE,
  freezeGates,
  gatesMode,
  ledgerVerdict,
  listGates,
  parseAbandonLines,
  recordGateResult,
  type GateRow,
  type LedgerVerdict,
} from "./gates.js";
import { probeLanding, type LandingExec } from "./landing.js";
import { isReadbackRow, runReadback } from "./readback.js";

export const DEFAULT_CHECK_TIMEOUT_MS = 60_000;
/** Wall-clock budget for one whole ledger evaluation (all gates, serial). */
export const DEFAULT_LEDGER_BUDGET_MS = 120_000;
const MAX_OUTPUT_BYTES = 256 * 1024;
/** EXPECT is matched against the LAST 64KB of output — the deciding lines live there. */
const MATCH_WINDOW_BYTES = 64 * 1024;
const REGEX_DEADLINE_MS = 250;

export interface CheckOutcome {
  ok: boolean;
  /** Deciding tail of stdout+stderr (capped), or the failure reason. */
  evidence: string;
  exitCode: number | null;
  timedOut: boolean;
}

/** Nested/adjacent quantifiers — the catastrophic-backtracking shapes. Rejected outright. */
const NESTED_QUANTIFIER_RE = /\([^)]*[+*}][^)]*\)\s*[+*{]|[+*]\s*[+*]/;

/**
 * Regex test with a hard deadline: compiled and executed inside a fresh vm
 * context whose `timeout` terminates a runaway match. Any throw — bad
 * pattern, timeout — is a non-match, never a hang.
 */
export function safeRegexTest(
  pattern: string,
  flags: string,
  haystack: string,
): boolean {
  if (NESTED_QUANTIFIER_RE.test(pattern)) return false;
  try {
    const result: unknown = vm.runInNewContext(
      "new RegExp(pattern, flags).test(haystack)",
      { pattern, flags, haystack },
      { timeout: REGEX_DEADLINE_MS },
    );
    return result === true;
  } catch {
    return false;
  }
}

/** `/regex/flags` ⇒ RegExp test; anything else ⇒ substring match. Both on the tail window. */
export function expectMatches(expect: string, output: string): boolean {
  const window =
    output.length > MATCH_WINDOW_BYTES
      ? output.slice(-MATCH_WINDOW_BYTES)
      : output;
  const rx = expect.match(/^\/(.+)\/([a-z]*)$/);
  if (rx) return safeRegexTest(rx[1], rx[2], window);
  return window.includes(expect);
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
    const child = spawn("/bin/sh", ["-c", command], {
      cwd: opts.cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: process.env.HOME ?? "/root",
        LANG: process.env.LANG ?? "C.UTF-8",
        TZ: process.env.TZ ?? "UTC",
        MC_TASK_ID: opts.taskId ?? "",
      },
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
    return {
      ok: false,
      evidence: `check rejected by shell guard: ${guard.reason ?? "blocked"}`,
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
  // With an EXPECT the match decides (a check may exit non-zero by design);
  // without one, the exit code decides.
  const ok = row.expect
    ? expectMatches(row.expect, res.output)
    : res.exitCode === 0;
  const tail = evidenceTail(res.output);
  return {
    ok,
    evidence: ok ? tail : `${tail} (exit ${res.exitCode ?? "?"})`,
    exitCode: res.exitCode,
    timedOut: false,
  };
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
    // become "a proof can be voided by one line").
    const known = new Set(
      rows.filter((r) => !isReadbackRow(r)).map((r) => r.gate_id),
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
    if (row.check_kind === "manual" && !isReadbackRow(row)) continue; // never flipped by the harness
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
      const outcome = await runCheck(row, {
        cwd: opts.cwd,
        timeoutMs: Math.min(
          timeoutMs,
          Math.max(1, budgetMs - (Date.now() - startedAt)),
        ),
        exec,
        taskId: opts.taskId,
      });
      ran++;
      recordGateResult(
        opts.taskId,
        row.gate_id,
        outcome.ok
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
