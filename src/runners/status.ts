/**
 * Runner status parsing — extracts structured status from LLM output.
 *
 * LLMs are instructed to end responses with a STATUS: line.
 * This module parses that line into a typed status with optional details.
 */

/** Structured status reported by a runner. */
export type RunnerStatus =
  | "DONE"
  | "DONE_WITH_CONCERNS"
  | "NEEDS_CONTEXT"
  | "BLOCKED";

export interface ParsedStatus {
  status: RunnerStatus;
  concerns?: string[];
  cleanContent: string;
}

const STATUS_RE =
  /STATUS:\s*(DONE_WITH_CONCERNS|NEEDS_CONTEXT|BLOCKED|DONE)(?:\s*[—-]\s*(.+))?$/m;

/**
 * Detects LLM output that is actually a raw API-error string from the SDK,
 * not a real completion. The claude-sdk wrapper returns the error body as
 * `text` when the API rejects a request (e.g. 400 invalid_request_error on
 * a malformed JSON body). Without this check, the output has no STATUS line
 * and silently classifies as DONE — masking the outage in `mc-ctl stats`
 * and burying the real failure in a "successful" task row.
 */
const API_ERROR_RE = /^\s*API Error:\s*\d{3}\b/;

/**
 * Parse a STATUS: line from the end of LLM output.
 *
 * CCP10: If no status line is found, defaults to DONE_WITH_CONCERNS
 * (missing status = incomplete task tracking). The concern is logged
 * so monitoring can detect LLMs that consistently omit status lines.
 */
export function parseRunnerStatus(content: string): ParsedStatus {
  // API-error short-circuit: if the runner received a raw API-error string
  // (instead of a real LLM response), classify as BLOCKED so the dispatcher
  // promotes the run to status='failed'. Otherwise a 30-min outage shows
  // up as 100% success in the stats dashboard.
  if (API_ERROR_RE.test(content)) {
    const firstLine = content.trim().split("\n")[0] ?? "API error";
    console.log(`[status] API error detected in runner output: ${firstLine}`);
    return {
      status: "BLOCKED",
      concerns: [firstLine.slice(0, 300)],
      cleanContent: content,
    };
  }

  const match = content.match(STATUS_RE);

  if (!match) {
    // Track internally but don't surface as concern — LLM omits status lines
    // ~67% of the time. Flagging as DONE_WITH_CONCERNS creates noise that
    // drowns real concerns. Metric still logged for observability.
    console.log(
      "[status] No STATUS line in LLM response (tracked, not surfaced)",
    );
    return {
      status: "DONE",
      cleanContent: content,
    };
  }

  const status = match[1] as RunnerStatus;
  const detail = match[2]?.trim();

  return {
    status,
    concerns: status === "DONE_WITH_CONCERNS" && detail ? [detail] : undefined,
    cleanContent: content.slice(0, match.index).trim(),
  };
}
