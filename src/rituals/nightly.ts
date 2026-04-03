/**
 * Nightly close task template.
 *
 * Submitted to the dispatcher as a Heavy runner task.
 * The LLM reviews the day, prepares tomorrow, and emails the report.
 * Journal is user-only — the agent does NOT write there.
 */

import type { TaskSubmission } from "../dispatch/dispatcher.js";

export function createNightlyClose(dateLabel: string): TaskSubmission {
  return {
    title: `Nightly close — ${dateLabel}`,
    description: `You are Jarvis, Fede's personal strategic assistant. Execute the nightly close ritual.

## Instructions

1. Call jarvis_file_read to read NorthStar/ files and see today's final state (visions, goals, objectives, tasks).
2. Compare with what was planned (the morning briefing context): what got done, what didn't, what was added mid-day.
3. For each incomplete critical/urgent task, assess: should it carry over to tomorrow, be reprioritized, or be dropped?
4. If any tasks need rebalancing for tomorrow, use jarvis_file_write to update the NorthStar/ files.
5. Prepare tomorrow's preliminary priority list.
6. Send the report via gmail_send to fede@eurekamd.net with subject "Cierre del día — ${dateLabel}".

IMPORTANT: Do NOT write to the journal. The journal is exclusively for the user's personal input.

## Email body format (Spanish, Mexican)

**Cierre del día** 🌙 ${dateLabel}

**✅ Completado hoy** (X de Y tareas)
- Task 1 ✓
- Task 2 ✓

**⏳ Pendiente (movido a mañana)**
- Task 3 — [reason/new priority]

**📝 Reflexión**
[2-3 sentences about what worked, what didn't, and one learning]

**📋 Preview de mañana**
Top 3 prioridades preliminares:
1. ...
2. ...
3. ...

Racha: X días. [motivational note if streak is growing]`,
    agentType: "heavy",
    tools: [
      "jarvis_file_read",
      "jarvis_file_write",
      "gmail_send",
      "project_list",
    ],
    requiredTools: ["jarvis_file_read", "gmail_send"],
  };
}
