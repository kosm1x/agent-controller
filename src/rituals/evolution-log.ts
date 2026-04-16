/**
 * Evolution log ritual — daily snapshot of the agent-user relationship.
 *
 * Runs at 11:59 PM Mexico City time. Collects system metrics, mental model
 * content, and interaction patterns, then appends an entry to EVOLUTION-LOG.md.
 */

import type { TaskSubmission } from "../dispatch/dispatcher.js";
import { getDatabase } from "../db/index.js";
import { RITUALS_TIMEZONE } from "./config.js";

/**
 * Count today's conversations mechanically from the DB.
 * Conversations are stored with UTC timestamps; we compute the
 * Mexico City day boundaries to filter accurately.
 */
function countTodayConversations(): {
  count: number;
  channels: Record<string, number>;
} {
  const db = getDatabase();
  // Mexico City is fixed UTC-6 (no DST since 2022 reform).
  // Midnight MX = 06:00 UTC same day.
  const now = new Date();
  const mxDate = now.toLocaleDateString("en-CA", {
    timeZone: RITUALS_TIMEZONE,
  });
  const utcStart = `${mxDate} 06:00:00`;

  const rows = db
    .prepare(
      `SELECT tags FROM conversations
       WHERE bank = 'mc-jarvis'
       AND EXISTS (SELECT 1 FROM json_each(tags) je WHERE je.value = 'conversation')
       AND created_at >= ?`,
    )
    .all(utcStart) as Array<{ tags: string }>;

  const channels: Record<string, number> = {};
  for (const row of rows) {
    try {
      const tags = JSON.parse(row.tags) as string[];
      const ch = tags.find((t) => t !== "conversation" && t !== "fast-path");
      if (ch) channels[ch] = (channels[ch] ?? 0) + 1;
    } catch {
      // skip
    }
  }
  return { count: rows.length, channels };
}

export function createEvolutionLogEntry(dateLabel: string): TaskSubmission {
  const { count, channels } = countTodayConversations();
  const channelSummary =
    Object.entries(channels)
      .map(([ch, n]) => `${ch}: ${n}`)
      .join(", ") || "none";

  return {
    title: `Evolution log — ${dateLabel}`,
    description: `You are Jarvis, the system observer. Your job is to document today's interactions for a longitudinal research log.

## Pre-computed metrics (mechanical — do NOT override)
- Conversations today: ${count}
- By channel: ${channelSummary}

## Instructions

1. Call jarvis_file_read to read NorthStar/ files and see today's final state (tasks, completions, streaks).
2. Call memory_search with query "user interactions" in bank "jarvis" to recall today's interactions.
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
| Conversations today | ${count} (${channelSummary}) |
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

4. APPEND this entry to /root/claude/mission-control/docs/EVOLUTION-LOG.md.
   Use shell_exec with: echo '<entry>' >> /root/claude/mission-control/docs/EVOLUTION-LOG.md
   Or use file_write (read full file first, append entry, write back).
   Both tools are available and authorized for this file.

Do NOT modify existing entries. Only append.
If there were zero interactions today, still write an entry noting the quiet day.`,
    agentType: "fast",
    tools: [
      "jarvis_file_read",
      "memory_search",
      "memory_reflect",
      "file_read",
      "file_write",
      "shell_exec",
    ],
  };
}
