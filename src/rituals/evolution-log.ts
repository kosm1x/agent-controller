/**
 * Evolution log ritual — daily snapshot of the agent-user relationship.
 *
 * Runs at 11:59 PM Mexico City time. Collects system metrics, mental model
 * content, and interaction patterns, then appends an entry to EVOLUTION-LOG.md.
 */

import type { TaskSubmission } from "../dispatch/dispatcher.js";

export function createEvolutionLogEntry(dateLabel: string): TaskSubmission {
  return {
    title: `Evolution log — ${dateLabel}`,
    description: `You are Jarvis, the system observer. Your job is to document today's interactions for a longitudinal research log.

## Instructions

1. Call jarvis_file_read to read NorthStar/ files and see today's final state (tasks, completions, streaks).
2. Call memory_search with query "conversations today" in bank "jarvis" to recall today's interactions.
3. Call memory_reflect with query "What patterns emerged in today's conversations? What did the user care about? What went well and what caused friction?" in bank "jarvis".

## What to write

Based on the data above, compose a daily log entry in this EXACT format (in English):

\`\`\`
## ${dateLabel}

### System state
| Metric | Value |
|--------|-------|
| Tasks processed today | [from snapshot: completed_today] |
| Total tasks | [from snapshot: pending_tasks + completed] |
| Conversations today | [estimate from memory search] |
| Streak days | [from snapshot] |

### Interactions summary
[2-3 sentences: what topics came up, what Fede asked about, what tools were used most]

### What Jarvis learned
[2-3 sentences: any new patterns, preferences, or corrections detected. If nothing notable, say "No new patterns detected — still in cold start phase."]

### Friction points
[Any misunderstandings, slow responses, or repeated questions. If none, say "None detected."]

### Research notes
[1-2 sentences: observations relevant to the agent-user co-evolution paper. What phase are we in? Any milestone crossed?]
\`\`\`

4. Use file_write to APPEND this entry to /root/claude/mission-control/docs/EVOLUTION-LOG.md.
   IMPORTANT: Read the file first with file_read, then write the FULL content back with the new entry appended at the end.

Do NOT modify existing entries. Only append.
If there were zero interactions today, still write an entry noting the quiet day.`,
    agentType: "heavy",
    tools: [
      "jarvis_file_read",
      "memory_search",
      "memory_reflect",
      "file_read",
      "file_write",
    ],
  };
}
