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
 * If no status line is found, defaults to DONE (backward compatibility).
 * The status line is stripped from the returned cleanContent.
 */
export function parseRunnerStatus(content: string): ParsedStatus {
  const match = content.match(STATUS_RE);

  if (!match) {
    return { status: "DONE", cleanContent: content };
  }

  const status = match[1] as RunnerStatus;
  const detail = match[2]?.trim();

  return {
    status,
    concerns: status === "DONE_WITH_CONCERNS" && detail ? [detail] : undefined,
    cleanContent: content.slice(0, match.index).trim(),
  };
}
