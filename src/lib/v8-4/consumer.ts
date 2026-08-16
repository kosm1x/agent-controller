/**
 * V8.4 — the ledger's CONSUMER: what a full/failed ledger UNLOCKS or DEMOTES.
 *
 * `feedback_gate_pass_must_have_a_consumer`: a gate is only meaningful if
 * something reads its verdict. Here the consumer is the task's terminal
 * status + the delivered report:
 *
 *   mode off      → nothing runs; the ledger is inert rows.
 *   mode shadow   → checks run, verdict recorded on `tasks.output.gates` and
 *                   as a `gates.evaluated` trace event; status untouched.
 *   mode enforce  → a FAILED verdict demotes `completed` →
 *                   `completed_with_concerns`; the ledger block (met / FAILED /
 *                   unverified / ABANDONED) is appended to the deliverable so
 *                   surrender is visible in the report, never silent.
 *
 * Also owns the two harness-authored pieces that ride the same seam: the
 * nanoclaw work-landing gate (declared here at completion, verified on the
 * host) and the numbers-provenance audit (always computed when a deliverable
 * exists; footer only when `TASK_GATES_NUMBERS_ANNOTATE=true`).
 */
import type { AgentType, RunnerOutput } from "../../runners/types.js";
import { getConfig } from "../../config.js";
import { getDatabase } from "../../db/index.js";
import { extractDeliverableText } from "../deliverable.js";
import { emitTraceEvent } from "../../observability/task-trace.js";
import {
  declareGates,
  formatLedgerBlock,
  gatesMode,
  hasGates,
  ledgerSummaryJson,
  type GateSpec,
  type LedgerVerdict,
} from "./gates.js";
import { evaluateLedger, type EvaluateResult } from "./gate-check.js";
import {
  auditNumbers,
  formatUnverifiedFooter,
  numbersAnnotateEnabled,
  takeToolEvidence,
  type NumbersAudit,
} from "./numbers.js";

export const LANDING_GATE_ID = "G-landing";

export const LANDING_GATE_SPEC: GateSpec = {
  id: LANDING_GATE_ID,
  criterion:
    "The work landed on the remote: the branch / PR / commit named in the report exists on origin",
  kind: "landing",
};

/**
 * Did this task's work happen INSIDE a container? Then the host tree is not
 * the tree the work touched and a shell gate run here proves nothing (qa W1
 * 2026-08-16: `npx tsc --noEmit` against the untouched host tree would be a
 * manufactured green). Shell gates are skipped for these; the landing gate is
 * their proof. Mirrors the dispatcher's `needsContainer`.
 */
export function ranInContainer(agentType: AgentType | null | undefined): boolean {
  if (agentType === "nanoclaw") return true;
  if (agentType === "heavy") return getConfig().heavyRunnerContainerized;
  return false;
}

/** Sandboxed coding task (not a chat that misrouted into the sandbox). */
export function needsLandingGate(
  agentType: AgentType,
  tags: readonly string[],
): boolean {
  return agentType === "nanoclaw" && !tags.includes("messaging");
}

export interface CompletionLedgerArgs {
  taskId: string;
  runId: string;
  agentType: AgentType;
  tags: readonly string[];
  taskDescription: string;
  result: RunnerOutput;
  /** Status the dispatcher mapped from the runner result, before the ledger. */
  taskStatus: string;
}

export interface CompletionLedgerOutcome {
  taskStatus: string;
  output: RunnerOutput["output"];
  gates: EvaluateResult | null;
  numbers: NumbersAudit | null;
}

const DELIVERABLE_FIELDS = ["finalAnswer", "text", "content"] as const;

function appendToDeliverable(
  output: RunnerOutput["output"],
  suffix: string,
): RunnerOutput["output"] {
  if (!suffix) return output;
  if (typeof output === "string") return `${output}\n\n${suffix}`;
  if (!output || typeof output !== "object") return output;
  const next = { ...output };
  for (const field of DELIVERABLE_FIELDS) {
    const cur = next[field];
    if (typeof cur === "string" && cur.trim()) {
      next[field] = `${cur}\n\n${suffix}`;
      return next;
    }
  }
  return next;
}

/**
 * Runs at task completion, after the dispatcher mapped runner → status and
 * BEFORE `updateTaskStatus`. Never throws: any internal failure is logged as
 * a trace event and the original status/output pass through unchanged
 * (`feedback_wrapper_must_preserve_failure_channel` — the ledger must not
 * become a new way to lose a deliverable).
 */
export async function applyCompletionLedger(
  args: CompletionLedgerArgs,
): Promise<CompletionLedgerOutcome> {
  const { taskId, runId, result } = args;
  let output = result.output;
  let taskStatus = args.taskStatus;
  const deliverable = extractDeliverableText(output) ?? "";

  // ── numbers audit (always; free) ─────────────────────────────────────────
  let numbers: NumbersAudit | null = null;
  const evidence = takeToolEvidence(taskId);
  try {
    if (
      deliverable &&
      (evidence.length > 0 || args.tags.includes("scheduled"))
    ) {
      numbers = auditNumbers(deliverable, [...evidence, args.taskDescription]);
      emitTraceEvent({
        taskId,
        runId,
        name: "numbers.audited",
        attrs: {
          found: numbers.found.length,
          unverified: numbers.unverified.length,
          evidence_chunks: evidence.length,
        },
      });
      if (output && typeof output === "object") {
        output = {
          ...output,
          numbers_audit: {
            found: numbers.found.length,
            unverified: numbers.unverified.slice(0, 20),
          },
        };
      }
      if (numbersAnnotateEnabled() && numbers.unverified.length > 0) {
        output = appendToDeliverable(
          output,
          formatUnverifiedFooter(numbers).trim(),
        );
      }
    }
  } catch (err) {
    emitTraceEvent({
      taskId,
      runId,
      name: "numbers.audited",
      attrs: { error: err instanceof Error ? err.message : String(err) },
    });
  }

  // ── completion ledger ────────────────────────────────────────────────────
  const mode = gatesMode();
  if (mode === "off") return { taskStatus, output, gates: null, numbers };

  let gates: EvaluateResult | null = null;
  try {
    if (result.success && needsLandingGate(args.agentType, args.tags)) {
      declareGates(taskId, [LANDING_GATE_SPEC], "harness");
    }
    if (!hasGates(taskId)) return { taskStatus, output, gates: null, numbers };

    gates = await evaluateLedger({
      taskId,
      outputText: deliverable,
      shellGatesRunnable: !ranInContainer(args.agentType),
    });
    emitTraceEvent({
      taskId,
      runId,
      name: "gates.evaluated",
      attrs: {
        mode,
        verdict: gates.verdict,
        total: gates.total,
        met: gates.met,
        failed: gates.failed,
        pending: gates.pending,
        abandoned: gates.abandoned,
        ran: gates.ran,
        shell_skipped: gates.shellSkipped,
        budget_exhausted: gates.budgetExhausted,
        status_before: taskStatus,
      },
    });
    if (output && typeof output === "object") {
      output = { ...output, gates: ledgerSummaryJson(gates.rows, mode) };
    }
    if (mode === "enforce") {
      if (gates.verdict === "failed" && taskStatus === "completed") {
        taskStatus = "completed_with_concerns";
      }
      output = appendToDeliverable(output, formatLedgerBlock(gates.rows));
    }
  } catch (err) {
    emitTraceEvent({
      taskId,
      runId,
      name: "gates.evaluated",
      attrs: { mode, error: err instanceof Error ? err.message : String(err) },
    });
  }
  return { taskStatus, output, gates, numbers };
}

/**
 * Parent-side re-verification of a finished child's ledger (unlazy's
 * verification hierarchy, layer 2: the driver re-runs the leaf's checks;
 * self-certification counts for nothing). Returns null when there is nothing
 * to verify (mode off / no ledger).
 */
export async function reverifyChildLedger(
  parentTaskId: string,
  childTaskId: string,
  childOutput: unknown,
): Promise<LedgerVerdict | null> {
  const mode = gatesMode();
  if (mode === "off" || !hasGates(childTaskId)) return null;
  const outputText =
    typeof childOutput === "string"
      ? (extractDeliverableText(childOutput) ?? childOutput)
      : (extractDeliverableText(childOutput) ?? "");
  const childRow = getDatabase()
    .prepare(`SELECT agent_type FROM tasks WHERE task_id = ?`)
    .get(childTaskId) as { agent_type: AgentType | null } | undefined;
  const verdict = await evaluateLedger({
    taskId: childTaskId,
    outputText,
    rerun: true,
    shellGatesRunnable: !ranInContainer(childRow?.agent_type),
  });
  emitTraceEvent({
    taskId: parentTaskId,
    name: "gates.parent_reverified",
    attrs: {
      mode,
      child_task_id: childTaskId,
      verdict: verdict.verdict,
      failed: verdict.failed,
      pending: verdict.pending,
      abandoned: verdict.abandoned,
      shell_skipped: verdict.shellSkipped,
    },
  });
  return verdict;
}
