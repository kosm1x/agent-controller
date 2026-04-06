/**
 * Autonomous Improvement Ritual — v6.0 S5.
 *
 * Runs after overnight tuning (1:30 AM Tue/Thu/Sat).
 * Detects issues → creates branch → fixes → tests → opens PR.
 * All within safety gates: 3 PRs/day, $5/cycle, scope-limited.
 */

import type { TaskSubmission } from "../dispatch/dispatcher.js";
import {
  detectImprovements,
  formatCandidates,
} from "../intelligence/improvement-detector.js";
import { getDatabase } from "../db/index.js";

const MAX_PRS_PER_DAY = 3;
const ALLOWED_PATHS = [
  "src/tools/",
  "src/intel/",
  "src/messaging/scope.ts",
  "src/messaging/prompt-sections.ts",
  "src/messaging/prompt-enhancer.ts",
  "src/video/",
];

/**
 * Check if we're under the daily PR cap.
 */
function canCreatePR(): boolean {
  try {
    const db = getDatabase();
    // Count actual PRs opened (output contains github.com PR URL), not just completed tasks
    const row = db
      .prepare(
        `SELECT COUNT(*) as cnt FROM tasks t
         JOIN runs r ON r.task_id = t.task_id
         WHERE t.title LIKE '🤖 Auto-improvement:%'
           AND t.created_at > datetime('now', '-24 hours')
           AND r.output LIKE '%github.com%/pull/%'`,
      )
      .get() as { cnt: number };
    return row.cnt < MAX_PRS_PER_DAY;
  } catch {
    return false;
  }
}

/**
 * Create the autonomous improvement task submission.
 * Returns null if no improvements detected or safety gates block.
 */
export function createImprovementTask(): TaskSubmission | null {
  // Safety gate: check env var
  if (process.env.AUTONOMOUS_IMPROVEMENT_ENABLED !== "true") {
    console.log(
      "[autonomous-improvement] Disabled (AUTONOMOUS_IMPROVEMENT_ENABLED != true)",
    );
    return null;
  }

  // Safety gate: PR cap
  if (!canCreatePR()) {
    console.log("[autonomous-improvement] Daily PR cap reached, skipping");
    return null;
  }

  // Detect candidates
  const candidates = detectImprovements(24);
  if (candidates.length === 0) {
    console.log("[autonomous-improvement] No candidates detected");
    return null;
  }

  const candidateText = formatCandidates(candidates);
  const topCandidate = candidates[0];

  console.log(
    `[autonomous-improvement] ${candidates.length} candidates. Top: ${topCandidate.type} (${topCandidate.severity}, ${topCandidate.frequency}x)`,
  );

  return {
    title: `🤖 Auto-improvement: ${topCandidate.suggestedAction.slice(0, 50)}`,
    description: `You are Jarvis in self-improvement mode. Fix ONE issue from the candidates below.

${candidateText}

## WORKFLOW (follow exactly)

1. Pick the HIGHEST severity candidate
2. Call jarvis_diagnose to understand the problem deeper
3. Call code_search to find the relevant code
4. Call jarvis_dev action="branch" type="fix" slug="{descriptive-slug}"
5. Use file_read to read the file you need to change
6. Use file_edit to make the MINIMAL fix
7. Call jarvis_test_run to verify (typecheck + tests must pass)
8. If tests fail: diagnose, fix, re-run. Max 3 attempts.
9. Call jarvis_dev action="pr" with a descriptive title and body

## SAFETY RULES

- ONLY modify files in: ${ALLOWED_PATHS.join(", ")}
- NEVER modify adapter.ts, runners/, db/ (core infrastructure)
- Make the SMALLEST change that fixes the issue
- If you can't fix it in 3 attempts, report what you tried and stop
- If tests don't pass after your fix, DO NOT open a PR

## BUDGET

- Max 35 rounds
- This is ONE improvement — don't try to fix multiple issues
- Pick the top candidate and focus

## AFTER COMPLETION

Report: what you fixed, which file(s), the PR link, and test results.`,
    agentType: "fast",
    tools: [
      "jarvis_dev",
      "jarvis_diagnose",
      "jarvis_test_run",
      "code_search",
      "file_read",
      "file_edit",
      "file_write",
      "shell_exec",
      "grep",
      "glob",
      "list_dir",
    ],
    requiredTools: ["jarvis_dev", "code_search"],
  };
}
