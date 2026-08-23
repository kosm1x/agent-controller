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
import {
  formatNoQuedo,
  formatSinReleer,
  formatVerificado,
  isReadbackRow,
} from "./readback.js";
import { emitTraceEvent } from "../../observability/task-trace.js";
import {
  declareGates,
  formatLedgerBlock,
  gatesMode,
  hasGates,
  ledgerSummaryJson,
  ledgerVerdict,
  type GateSpec,
  type LedgerVerdict,
} from "./gates.js";
import { checkCitations, citationMode } from "./citations.js";
import { evaluateLedger, type EvaluateResult } from "./gate-check.js";
import {
  annotateUnverified,
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

const DELIVERABLE_FIELDS = [
  "finalAnswer",
  "text",
  "output",
  "result",
  "content",
] as const;

/**
 * Rewrite the deliverable field in place (the one `extractDeliverableText`
 * picked — same field order). Returns `replaced:false` when the carrier is
 * a shape we cannot edit without re-deriving it (JSON-encoded string).
 */
function replaceDeliverable(
  output: RunnerOutput["output"],
  from: string,
  to: string,
): { output: RunnerOutput["output"]; replaced: boolean } {
  if (typeof output === "string") {
    // extractDeliverableText trims string carriers; compare on the same basis.
    return output.trim() === from.trim()
      ? { output: to, replaced: true }
      : { output, replaced: false };
  }
  if (!output || typeof output !== "object") return { output, replaced: false };
  for (const field of DELIVERABLE_FIELDS) {
    const cur = output[field];
    if (typeof cur === "string" && cur === from) {
      return { output: { ...output, [field]: to }, replaced: true };
    }
  }
  return { output, replaced: false };
}

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
  // Nothing to append to: the warning must still reach the operator
  // (R1 audit W14 — it vanished exactly when the run produced nothing).
  next.text = suffix;
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
  // Usability Phase 3 (2026-08-23): runs on EVERY deliverable — a turn with
  // no tool evidence is exactly the "figure from memory" case (#11265 BSX
  // price quoted with 0 tools) — and the unverified figures are annotated
  // inline `(sin verificar)` unless TASK_GATES_NUMBERS_ANNOTATE=false.
  let numbers: NumbersAudit | null = null;
  const evidence = takeToolEvidence(taskId);
  try {
    if (deliverable) {
      numbers = auditNumbers(deliverable, [...evidence, args.taskDescription]);
      let annotated = 0;
      if (numbersAnnotateEnabled() && numbers.unverified.length > 0) {
        const marked = annotateUnverified(deliverable, numbers);
        const replaced = replaceDeliverable(output, deliverable, marked.text);
        if (replaced.replaced) {
          output = replaced.output;
          annotated = marked.annotated;
        } else {
          // Shape we cannot rewrite in place (JSON-encoded string carrier):
          // the doubt still reaches the reader as a footer.
          output = appendToDeliverable(
            output,
            formatUnverifiedFooter(numbers).trim(),
          );
        }
      }
      emitTraceEvent({
        taskId,
        runId,
        name: "numbers.audited",
        attrs: {
          found: numbers.found.length,
          unverified: numbers.unverified.length,
          evidence_chunks: evidence.length,
          annotated,
        },
      });
      if (output && typeof output === "object") {
        output = {
          ...output,
          numbers_audit: {
            found: numbers.found.length,
            unverified: numbers.unverified.slice(0, 20),
            annotated,
          },
        };
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

  // ── citation existence (usability Phase 3.3) ─────────────────────────────
  // Only fires on a references section or a DOI/arXiv id; positively
  // missing entries are dropped with one note line, unreachable ones kept.
  try {
    const cmode = citationMode();
    const current = extractDeliverableText(output) ?? "";
    if (cmode !== "off" && current) {
      const report = await checkCitations(current, { mode: cmode });
      if (report) {
        emitTraceEvent({
          taskId,
          runId,
          name: "citations.checked",
          attrs: {
            total: report.total,
            resolved: report.resolved,
            missing: report.missing,
            unreachable: report.unreachable,
            dropped: report.dropped.slice(0, 5),
            mode: cmode,
            ms: report.ms,
          },
        });
        if (cmode === "enforce" && report.missing > 0) {
          const replaced = replaceDeliverable(output, current, report.text);
          if (replaced.replaced) output = replaced.output;
        }
      }
    }
  } catch (err) {
    emitTraceEvent({
      taskId,
      runId,
      name: "citations.checked",
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
    // Phase 2 (usability plan, write-class enforce): a read-back gate is
    // deterministic, harness-owned proof that a WRITE landed — or did not.
    // It demotes and speaks under `shadow` AND `enforce` (R1 audit C3: the
    // Spanish lines must not vanish the day the operator flips the mode);
    // other gate kinds keep the mode's semantics below.
    const readbacks = gates.rows.filter((r) => isReadbackRow(r));
    if (readbacks.length > 0) {
      const failedReadback = readbacks.some((r) => r.state === "failed");
      if (failedReadback && taskStatus === "completed") {
        taskStatus = "completed_with_concerns";
      }
      const lines = [
        formatVerificado(gates.rows),
        formatNoQuedo(gates.rows),
        formatSinReleer(gates.rows),
      ]
        .filter(Boolean)
        .join("\n");
      output = appendToDeliverable(output, lines);
      emitTraceEvent({
        taskId,
        runId,
        name: "gates.readback",
        attrs: {
          mode,
          total: readbacks.length,
          failed: readbacks.filter((r) => r.state === "failed").length,
          demoted: failedReadback && args.taskStatus === "completed",
        },
      });
    }
    if (mode === "enforce") {
      // Population = the non-read-back gates (read-backs were adjudicated
      // and rendered above); formatLedgerBlock filters the same way, so the
      // headline can never contradict a «No quedó» line (R2 audit C1).
      const others = gates.rows.filter((r) => !isReadbackRow(r));
      const v = ledgerVerdict(others);
      if (v.verdict === "failed" && taskStatus === "completed") {
        taskStatus = "completed_with_concerns";
      }
      if (others.length > 0) {
        output = appendToDeliverable(output, formatLedgerBlock(others));
      }
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
  const evaluated = await evaluateLedger({
    taskId: childTaskId,
    outputText,
    rerun: true,
    shellGatesRunnable: !ranInContainer(childRow?.agent_type),
  });
  // Read-backs were adjudicated and rendered at the child's completion; the
  // parent's pass/fail decision is over the child's OTHER gates, so a failed
  // write proof demotes (as on a direct task) rather than hard-failing the
  // goal (R3 audit W3).
  const verdict: typeof evaluated = {
    ...evaluated,
    ...ledgerVerdict(evaluated.rows.filter((r) => !isReadbackRow(r))),
  };
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
