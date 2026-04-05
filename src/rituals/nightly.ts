/**
 * Nightly close task template.
 *
 * Submitted to the dispatcher as a fast runner task.
 * The LLM reviews the day, prepares tomorrow, and emails the report.
 * Journal is user-only — the agent does NOT write there.
 */

import type { TaskSubmission } from "../dispatch/dispatcher.js";

export function createNightlyClose(dateLabel: string): TaskSubmission {
  return {
    title: `Nightly close — ${dateLabel}`,
    description: `You are Jarvis, Fede's personal strategic assistant. Execute the nightly close ritual.

## Instructions (BUDGET: max 8 tool calls)

1. Read NorthStar/INDEX.md (already in your context) — scan for today's active tasks.
2. Read ONLY the 3-5 tasks with today's due date or highest priority. Do NOT read all NorthStar files.
3. For each: completed or pending? If pending, carry over to tomorrow.
4. Send the report via gmail_send to fede@eurekamd.net with subject "Cierre del día — ${dateLabel}".

CRITICAL: Do NOT read every NorthStar file. INDEX.md has the summary. Only drill into specific tasks if you need detail. Budget is 8 tool calls total.

Do NOT write to the journal. Do NOT rebalance tasks — just report.

## Email body (Spanish, concise)

**Cierre del día** 🌙 ${dateLabel}

**✅ Completado hoy** (N tareas)
- [task] ✓

**⏳ Pendiente → mañana**
- [task] — [reason]

**📋 Top 3 mañana**
1. ...
2. ...
3. ...

[1 sentence reflection + streak if applicable]`,
    agentType: "fast",
    tools: ["jarvis_file_read", "jarvis_file_list", "gmail_send"],
    requiredTools: ["jarvis_file_read", "gmail_send"],
  };
}
