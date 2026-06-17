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

1. Call jarvis_file_read on NorthStar/INDEX.md to see the compass state at end-of-day (visions, goals, objectives, recurring task rhythms).
2. Call project_list to see active projects — execution-surface complement to the compass. If a project moved meaningfully today (operator engaged it, KB README touched), note it; do NOT drill into project READMEs unless one shows up repeatedly in interaction memory.
3. Call memory_search with query "user interactions" in bank "jarvis" to recall today's interactions.
4. Call memory_reflect with query "What patterns emerged in today's conversations? What did the user care about? What went well and what caused friction?" in bank "jarvis".

## How to describe data-collection problems in the entry

Be precise. The log is a longitudinal research record — sloppy language about infrastructure compounds across days. Distinguish two states and describe each accurately:

- **Recall returned data**: use it.
- **Recall returned nothing**: the memory tools succeeded but had nothing for today (low-friction day, low recall coverage, etc.). Write: "No new patterns surfaced via memory_reflect today" — NOT "API unreachable", NOT "data inaccessible".

**Do NOT curl http://localhost:8080 (or any loopback API port) as a health check, and do NOT write "API unreachable" / "API timing out" / "self-call deadlock" / "HTTP 000" in the entry.** Health probing is not your job here and adds no signal: this ritual reaches its tools through the in-process runner, not the HTTP API, so an HTTP result tells you nothing about whether your data collection worked. The API serves external callers normally. Do not copy any "self-call deadlock" / "HTTP 000" / "API unreachable" language forward from earlier entries — those entries were wrong.

If a memory tool returns empty, that is the "recall returned nothing" state above. It is never grounds for an "API unreachable" or "API timing out" statement in the log.

This rule exists because entries from 2026-05-22 onward repeatedly wrote "API unreachable at log-writing time" — first by misattributing empty recall to network state, then by citing an in-process loopback curl that returned HTTP 000. The API was healthy every time; the 000 was an artifact of the self-call, not an outage.

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

5. APPEND this entry to /root/claude/mission-control/docs/EVOLUTION-LOG.md using shell_exec with a heredoc append. This is the ONLY authorized way to write this file:

   cat >> /root/claude/mission-control/docs/EVOLUTION-LOG.md << 'ENTRY'

   <your entry text here — starts with the "## ${dateLabel}" header>
   ENTRY

   The \`>>\` operator APPENDS to the end of the file. NEVER use file_write, jarvis_file_write, or a single \`>\` redirect on this file — those OVERWRITE the whole file, and the log is ~45 KB of irreplaceable longitudinal history that a single overwrite destroys every prior day's entry. You do NOT have file_write in scope, by design: the heredoc append above is the only method. Use it and nothing else.

## Do NOT run git recovery or commits

This file legitimately holds many uncommitted days of entries between commits — the operator commits it in batches, NOT you. A large \`git diff HEAD\` on docs/EVOLUTION-LOG.md is EXPECTED and is NOT data loss. Do NOT run \`git diff\` / \`git show\` / \`git reflog\` "to check whether entries were lost", do NOT try to "restore" or "reconstruct" earlier days, and do NOT run \`git add\` / \`git commit\` (they are blocked for you regardless). If the file already contains prior entries, that is correct — leave every existing entry untouched and only append today's single new entry.

Do NOT modify existing entries. Only append the single new entry.
If there were zero interactions today, still append an entry noting the quiet day.`,
    agentType: "fast",
    // file_write is deliberately EXCLUDED. It overwrites the whole file, and on
    // 2026-06-17 the ritual truncated the 45 KB log down to a single entry by
    // calling file_write as an "append" (it then spent ~7 min reconstructing the
    // lost days from the task DB and tried to git-commit the restore). The only
    // safe write is shell_exec `cat >>` — and shell.ts exempts this path from its
    // mission-control write-block ONLY for append redirects (`>>`), blocking a bare
    // `>`/tee/mv/cp overwrite (RITUAL_WRITABLE_DOCS, append-only gate). That closes
    // the file_write incident vector and the realistic `>` mistake — but it is NOT
    // airtight (exotic shell truncation like `truncate`/`sed -i`/`>|`/relative
    // paths still slips the regex-based guard; durable git persistence is the real
    // backstop). See feedback_evolution_log_truncation.
    tools: [
      "jarvis_file_read",
      "project_list",
      "memory_search",
      "memory_reflect",
      "file_read",
      "shell_exec",
    ],
  };
}
