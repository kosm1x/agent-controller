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

1. Call commit__get_daily_snapshot to see today's final state.
2. Compare with what was planned (the morning briefing context): what got done, what didn't, what was added mid-day.
3. For each incomplete critical/urgent task, assess: should it carry over to tomorrow, be reprioritized, or be dropped?
4. If any tasks need rebalancing for tomorrow, call commit__update_status to adjust.
5. Prepare tomorrow's preliminary priority list.
6. Send the report via gmail_send to fede@eureka.md with subject "Cierre del día — ${dateLabel}".

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
      "commit__get_daily_snapshot",
      "commit__list_tasks",
      "commit__get_hierarchy",
      "commit__update_status",
      "gmail_send",
    ],
  };
}
