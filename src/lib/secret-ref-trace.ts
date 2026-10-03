/**
 * Trace events for ruling-3c refusals (combined audit 2026-10-03, should-fix 2).
 *
 * Every decision point emits a trace event visible in the dashboard SSE
 * stream: a tool call refused for a secret reference / rendered placeholder,
 * and a model request not sent because the outbound scrub could not run.
 * Keyed by the run's task id (execution context first, then the run-tool
 * context); outside a run there is no timeline to write to, so nothing is
 * emitted. Best-effort: `emitTraceEvent` never throws.
 */

import { emitTraceEvent } from "../observability/task-trace.js";
import { currentExecutionContext } from "../inference/execution-context.js";
import { currentRunTaskId } from "../tools/rule-of-two.js";

/** Why a call carrying a secret reference or placeholder was refused. */
export type SecretRefRefusalReason =
  /** A rendered `[oculto · …]` placeholder the call cannot carry. */
  | "rendered_placeholder"
  /** `$SECRET_X` / `{{SECRET_X}}` naming no stored credential. */
  | "unknown_name"
  /** A `${…SECRET_…}` shell expansion other than the bare `${SECRET_X}`. */
  | "shell_expansion";

function traceTaskId(): string | undefined {
  return currentExecutionContext()?.taskId ?? currentRunTaskId();
}

export function traceSecretRefRefused(
  tool: string,
  reason: SecretRefRefusalReason,
  stage: "pre_gate" | "execute",
  /** The caller's own task id when it holds one (the per-task executor). */
  taskIdHint?: string,
): void {
  const taskId = taskIdHint ?? traceTaskId();
  if (!taskId) return;
  emitTraceEvent({
    taskId,
    name: "tool.secret_ref_refused",
    tool,
    attrs: { tool, reason, stage },
  });
}

/** `where`: which choke point refused to send (no detail of the cause). */
export function traceScrubUnavailable(
  where: "openai" | "claude_sdk" | "claude_sdk_tool_error",
): void {
  const taskId = traceTaskId();
  if (!taskId) return;
  emitTraceEvent({
    taskId,
    name: "inference.scrub_unavailable",
    attrs: { where },
  });
}
