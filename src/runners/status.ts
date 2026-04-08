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
 * Parse a STATUS: line from the end of LLM output.
 *
 * CCP10: If no status line is found, defaults to DONE_WITH_CONCERNS
 * (missing status = incomplete task tracking). The concern is logged
 * so monitoring can detect LLMs that consistently omit status lines.
 */
export function parseRunnerStatus(content: string): ParsedStatus {
  const match = content.match(STATUS_RE);

  if (!match) {
    console.warn("[status] No STATUS line in LLM response");
    return {
      status: "DONE_WITH_CONCERNS",
      concerns: ["LLM omitted required status line"],
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
