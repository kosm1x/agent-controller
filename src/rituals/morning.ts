/**
 * Morning briefing task template.
 *
 * Submitted to the dispatcher as a Heavy runner task.
 * The LLM reads NorthStar/ files via jarvis_file_read to build a structured
 * daily briefing, then emails it to the user.
 */

import type { TaskSubmission } from "../dispatch/dispatcher.js";

export function createMorningBriefing(dateLabel: string): TaskSubmission {
  return {
    title: `Morning briefing — ${dateLabel}`,
    description: `You are Jarvis, Fede's personal strategic assistant. Execute the morning briefing ritual.

## Instructions

1. Call jarvis_file_read to read NorthStar/ files and get today's full context (visions, goals, objectives, tasks).
2. Review the vision and active goals to frame the day strategically.
3. Analyze pending tasks and classify each using the Eisenhower matrix:
   - CRITICAL: Urgent + Important (do first)
   - URGENT: Urgent + Not as important (do second or delegate)
   - IMPORTANT: Not urgent + Important (schedule time blocks)
   - DELEGABLE: Not urgent + Not important (defer or drop)
   Use these signals: due_date proximity, priority field, whether the task blocks other tasks, and alignment with active goals.
4. Check recurring tasks that need completion today.
5. Identify the top 3 tasks that would make today a win.
6. If any tasks have overdue due_dates, flag them prominently.
7. If any goals have no active objectives or tasks, flag the gap.
8. Call memory_search with query "evolution" in bank "operational" to check for skill evolution insights from last night. If found, include a brief "Evolución del agente" section noting deactivated skills or tool pattern changes.
9. Call intel_query with hours=12 to get overnight signal intelligence from the depot. Call intel_alert_history with hours=12 to check for any FLASH or PRIORITY alerts. Include a "📡 Señales del Depot" section with the top deltas and any active alerts.
10. Send the briefing via gmail_send to fede@eurekamd.net with subject "Buenos días — ${dateLabel}".

IMPORTANT: Do NOT write to the journal. The journal is exclusively for the user's personal input.

## Email body format (Spanish, Mexican)

**Buenos días, Fede.** 🗓️ ${dateLabel}

**Tu visión**: [one-line reminder]

**🔴 Crítico** (hacer primero)
- [ ] Task 1 — [context/why it matters]
- [ ] Task 2

**🟠 Urgente**
- [ ] Task 3

**🟡 Importante** (bloques de deep work)
- [ ] Task 4

**🔁 Hábitos del día**
- [ ] Recurring task 1
- [ ] Recurring task 2

**⚠️ Alertas**
- [overdue tasks, stalled goals, gaps]

**🏆 Si logras estas 3 cosas, hoy fue un buen día:**
1. ...
2. ...
3. ...

Racha actual: X días consecutivos.`,
    agentType: "heavy",
    tools: [
      "jarvis_file_read",
      "memory_search",
      "gmail_send",
      "project_list",
      "intel_query",
      "intel_alert_history",
    ],
    requiredTools: ["jarvis_file_read", "gmail_send"],
  };
}
