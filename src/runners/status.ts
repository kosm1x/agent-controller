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
  /**
   * V8.4 (2026-08-16): how the status was obtained. `explicit` = a STATUS
   * line was parsed; `default` = no line, DONE assumed; `api_error` = the
   * API-error short-circuit. Lets the missing-STATUS rate be MEASURED
   * (`mc-ctl gates --status-sources`) instead of quoted from a comment.
   */
  statusSource: "explicit" | "default" | "api_error";
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
 *
 * Covers both "API Error: 4xx" (current SDK shape) and "Error: 5xx"
 * (a future variant that might surface if the SDK ever returns a raw
 * upstream error without its "API Error:" prefix). Line-start anchor
 * `^` (no /m flag) is deliberate — mid-response mentions of "API Error"
 * in legitimate Jarvis explanations MUST NOT demote to BLOCKED.
 */
const API_ERROR_RE = /^\s*(?:API Error|Error):\s*\d{3}\b/;

/**
 * Tail variant (2026-08-21, task 38dca557): when the API rejects a LATER turn
 * of a multi-turn run (e.g. "400 Output blocked by content filtering policy"
 * on the final answer), the SDK appends the error string to the prose already
 * streamed — often with no newline before it ("...registro la entrega de
 * hoy:API Error: 400 ..."). The head anchor above can't see it, the result
 * subtype is still `success`, and the raw error shipped to Telegram as a
 * "completed" reply. A failed call is always the LAST thing in the stream,
 * so anchor on the tail instead. Restricted to the SDK's "API Error:" shape
 * (not bare "Error:") so a narrative sentence ending in "Error: 500." is not
 * demoted; the remainder after the code must be a JSON body or a short
 * fragment with no further sentence (". Word"), so a narrative that
 * continues — or ends with a STATUS line — never matches.
 */
const API_ERROR_TAIL_RE =
  /(?:^|[\s:.,;])(API Error:\s*\d{3}\b(?:\s*\{[^\n]*|(?:(?![.!?]\s+\S)[^\n]){0,200}))\s*$/;

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
  const tailMatch = API_ERROR_RE.test(content)
    ? null
    : API_ERROR_TAIL_RE.exec(content);
  if (API_ERROR_RE.test(content) || tailMatch) {
    const firstLine = tailMatch
      ? tailMatch[1].trim()
      : (content.trim().split("\n")[0] ?? "API error");
    console.log(`[status] API error detected in runner output: ${firstLine}`);
    return {
      status: "BLOCKED",
      concerns: [firstLine.slice(0, 300)],
      cleanContent: content,
      statusSource: "api_error",
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
      statusSource: "default",
    };
  }

  const status = match[1] as RunnerStatus;
  const detail = match[2]?.trim();

  return {
    status,
    concerns: status === "DONE_WITH_CONCERNS" && detail ? [detail] : undefined,
    cleanContent: content.slice(0, match.index).trim(),
    statusSource: "explicit",
  };
}
