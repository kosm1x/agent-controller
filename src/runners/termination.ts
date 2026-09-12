/**
 * Termination reason — a closed set naming WHY a task stopped.
 *
 * Until 2026-09-12 each runner spelled its own `exitReason` string and the
 * terminal trace event (`task.completed` / `task.failed`) carried only the
 * mapped status plus an error excerpt, so "which stop condition fired" was
 * regex archaeology over reply text. Runners now set
 * `RunnerOutput.terminationReason`; the dispatcher derives a fallback for
 * runners that do not and persists it as `attrs.termination_reason` on the
 * terminal trace event. Readers today: the `task_trace_events.attrs` JSON
 * (`mc-ctl trace` prints it; queries by `json_extract(attrs,'$.termination_reason')`).
 * No automated consumer yet — the eval gate and Honest Done are candidates.
 */

import type { RunnerOutput } from "./types.js";

type RunnerStatus = NonNullable<RunnerOutput["status"]>;

export const TERMINATION_REASONS = [
  /** Natural stop with a delivered answer. */
  "completed",
  /** Runner asked the user a clarifying question (NEEDS_CONTEXT). */
  "needs_context",
  /** Runner hit an external blocker it cannot resolve (BLOCKED). */
  "blocked",
  /** Turn / round budget exhausted. */
  "max_rounds",
  /** Token budget exhausted. */
  "token_budget",
  /** Iteration or cost budget exhausted (heavy / swarm orchestrator, SDK max_budget_usd). */
  "budget_exhausted",
  /** Context compaction could not free enough room to continue (openai path). */
  "compaction_exhausted",
  /** Extended-thinking budget exhausted (openai path). */
  "think_exhaustion",
  /** Escalation wrap-up turn ended the run (openai path). */
  "escalation_wrapup",
  /** Escalation aborted the run (openai path). */
  "escalation_abort",
  /** Task row found running after a non-graceful restart (startup reconcile). */
  "orphaned_restart",
  /** Wall-clock deadline (goal or orchestrator timeout). */
  "timeout",
  /** Inference provider failed mid-run. */
  "provider_failure",
  /** The final wrap-up turn failed after the tool loop ended. */
  "wrapup_failed",
  /** Abort signal (operator cancel, watchdog, shutdown). */
  "aborted",
  /** Task finished without calling a tool the submission required. */
  "required_tools_missing",
  /** Any other failure (thrown error, unknown exit string). */
  "error",
] as const;

export type TerminationReason = (typeof TERMINATION_REASONS)[number];

const KNOWN = new Set<string>(TERMINATION_REASONS);

/**
 * Map a runner's raw `exitReason` string plus its structured status to the
 * closed set. `"natural"` (openai loop) and `"stop"` (claude-sdk loop) both
 * mean the loop stopped on its own and resolve through the status: a clarifying question is `needs_context`, a blocker is `blocked`, a
 * delivered answer is `completed`, and a natural stop that still failed is
 * `error`. Unknown strings fold to `error` so the enum stays closed.
 */
export function terminationFromExit(
  exitReason: string | undefined,
  status: RunnerStatus | undefined,
  success: boolean,
): TerminationReason {
  if (exitReason !== undefined && exitReason !== "natural" && exitReason !== "stop") {
    return KNOWN.has(exitReason) ? (exitReason as TerminationReason) : "error";
  }
  if (status === "NEEDS_CONTEXT") return "needs_context";
  if (status === "BLOCKED") return "blocked";
  return success ? "completed" : "error";
}

/**
 * Dispatcher fallback for runners that do not set `terminationReason`:
 * derive it from the task status the dispatcher already mapped.
 */
export function terminationFromTaskStatus(
  taskStatus: string,
  success: boolean,
): TerminationReason {
  if (taskStatus === "needs_context" || taskStatus === "blocked") {
    return taskStatus;
  }
  return success ? "completed" : "error";
}
