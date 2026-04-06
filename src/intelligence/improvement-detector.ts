/**
 * Improvement Detector — v6.0 S5.
 *
 * Scans task outcomes, error logs, and guard triggers for recurring
 * patterns that suggest code changes. Returns ranked candidates.
 *
 * Called by the autonomous improvement ritual.
 */

import { getDatabase } from "../db/index.js";
import { execFileSync } from "child_process";

const MC_DIR = "/root/claude/mission-control";

export interface ImprovementCandidate {
  type: "scope-miss" | "guard-trigger" | "tool-failure" | "task-failure";
  description: string;
  frequency: number;
  severity: "high" | "medium" | "low";
  suggestedAction: string;
}

/**
 * Scan recent data for improvement candidates.
 * Returns candidates ranked by frequency × severity.
 */
export function detectImprovements(
  hoursBack: number = 24,
): ImprovementCandidate[] {
  const candidates: ImprovementCandidate[] = [];
  const db = getDatabase();

  // 1. Recurring task failures (same error pattern)
  try {
    const failures = db
      .prepare(
        `SELECT error, COUNT(*) as cnt FROM tasks
         WHERE status = 'failed'
           AND error IS NOT NULL
           AND error != 'Service shutdown'
           AND created_at > datetime('now', ? || ' hours')
         GROUP BY error
         HAVING cnt >= 2
         ORDER BY cnt DESC
         LIMIT 5`,
      )
      .all(`-${hoursBack}`) as Array<{ error: string; cnt: number }>;

    for (const f of failures) {
      candidates.push({
        type: "task-failure",
        description: f.error.slice(0, 200),
        frequency: f.cnt,
        severity: f.cnt >= 5 ? "high" : f.cnt >= 3 ? "medium" : "low",
        suggestedAction: `Investigate recurring failure: "${f.error.slice(0, 80)}"`,
      });
    }
  } catch {
    /* non-fatal */
  }

  // 2. Hallucination guard triggers
  try {
    const logs = execFileSync(
      "journalctl",
      [
        "-u",
        "mission-control",
        "--since",
        `${hoursBack} hours ago`,
        "--no-pager",
      ],
      { encoding: "utf-8", timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] },
    );
    const guardLines = logs
      .split("\n")
      .filter((l) =>
        /hallucination.*detected|Failed-write hallucination|Guard input/i.test(
          l,
        ),
      );

    if (guardLines.length >= 3) {
      candidates.push({
        type: "guard-trigger",
        description: `Hallucination guard fired ${guardLines.length} times in ${hoursBack}h`,
        frequency: guardLines.length,
        severity: guardLines.length >= 10 ? "high" : "medium",
        suggestedAction:
          "Check tool descriptions and scope patterns for ambiguity causing narration instead of tool calls",
      });
    }

    // 3. Tool-skip nudges (LLM responds with text instead of calling tools)
    const nudgeLines = logs
      .split("\n")
      .filter((l) => /tool skip detected|Post-nudge tool skip/i.test(l));

    if (nudgeLines.length >= 3) {
      candidates.push({
        type: "scope-miss",
        description: `Tool-skip nudge fired ${nudgeLines.length} times — LLM not calling expected tools`,
        frequency: nudgeLines.length,
        severity: nudgeLines.length >= 10 ? "high" : "medium",
        suggestedAction:
          "Review scope patterns — tools may not be in scope for the messages that need them",
      });
    }

    // 4. Failed tool calls (tool called but returned error)
    const failedToolLines = logs
      .split("\n")
      .filter((l) => /Failed tool calls \(excluded/i.test(l));

    if (failedToolLines.length >= 3) {
      // Extract tool names
      const toolCounts = new Map<string, number>();
      for (const line of failedToolLines) {
        const match = line.match(/\[([^\]]+)\]/g);
        if (match && match.length >= 2) {
          const tools = match[match.length - 1].slice(1, -1);
          for (const t of tools.split(", ")) {
            toolCounts.set(t, (toolCounts.get(t) ?? 0) + 1);
          }
        }
      }

      for (const [tool, count] of toolCounts) {
        if (count >= 2) {
          candidates.push({
            type: "tool-failure",
            description: `Tool "${tool}" failed ${count} times`,
            frequency: count,
            severity: count >= 5 ? "high" : "medium",
            suggestedAction: `Check ${tool} handler for bugs or missing validation`,
          });
        }
      }
    }
  } catch {
    /* journalctl may not be available */
  }

  // 5. Required tools not called (task completed but mandatory tools missed)
  try {
    const missed = db
      .prepare(
        `SELECT error, COUNT(*) as cnt FROM tasks
         WHERE error LIKE 'Required tools not called:%'
           AND created_at > datetime('now', ? || ' hours')
         GROUP BY error
         HAVING cnt >= 2
         ORDER BY cnt DESC
         LIMIT 3`,
      )
      .all(`-${hoursBack}`) as Array<{ error: string; cnt: number }>;

    for (const m of missed) {
      candidates.push({
        type: "scope-miss",
        description: m.error.slice(0, 200),
        frequency: m.cnt,
        severity: "medium",
        suggestedAction:
          "Check tool descriptions — LLM may not understand when to call required tools",
      });
    }
  } catch {
    /* non-fatal */
  }

  // Rank by severity weight × frequency
  const severityWeight = { high: 3, medium: 2, low: 1 };
  return candidates
    .sort(
      (a, b) =>
        b.frequency * severityWeight[b.severity] -
        a.frequency * severityWeight[a.severity],
    )
    .slice(0, 5);
}

/**
 * Format improvement candidates as text for the LLM prompt.
 */
export function formatCandidates(candidates: ImprovementCandidate[]): string {
  if (candidates.length === 0) return "No improvement candidates detected.";

  const lines = [`## Improvement Candidates (${candidates.length})`];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    lines.push(
      `\n${i + 1}. **[${c.severity.toUpperCase()}]** ${c.type}: ${c.description}`,
      `   Frequency: ${c.frequency}x | Action: ${c.suggestedAction}`,
    );
  }
  return lines.join("\n");
}
