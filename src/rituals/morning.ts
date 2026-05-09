/**
 * Morning briefing task template.
 *
 * Submitted to the dispatcher as a fast runner task.
 * The LLM reads NorthStar/ files via jarvis_file_read to build a structured
 * daily briefing, then emails it to the user.
 */

import type { TaskSubmission } from "../dispatch/dispatcher.js";

export function createMorningBriefing(dateLabel: string): TaskSubmission {
  return {
    title: `Morning briefing — ${dateLabel}`,
    description: `You are Jarvis, Fede's personal strategic assistant. Execute the morning briefing ritual.

## Instructions

NorthStar is the **compass** (intent: visions, goals, objectives, recurring rhythms).
Project KB tree is the **execution surface** (in-flight project work). Read both;
NorthStar tells you *where Fede is heading*, projects tell you *what's moving today*.

1. Read NorthStar/INDEX.md (compass narrative — already in your context) for today's intent framing: active visions, goals, objectives, and recurring tasks.
2. Call project_list to see active projects. For projects with imminent milestones or active sprints, call jarvis_file_read on projects/<slug>/README.md to surface execution-level priorities. Cap project drill-downs at 3 to keep budget tight.
3. Review the vision and active goals to frame the day strategically.
4. Analyze pending NorthStar tasks (recurring rhythms) AND project-level deliverables; classify each using the Eisenhower matrix:
   - CRITICAL: Urgent + Important (do first)
   - URGENT: Urgent + Not as important (do second or delegate)
   - IMPORTANT: Not urgent + Important (schedule time blocks)
   - DELEGABLE: Not urgent + Not important (defer or drop)
   Use these signals: due_date proximity, priority field, whether the task blocks other tasks, and alignment with active goals.
5. Check NorthStar recurring tasks that need completion today (the daily/weekly rhythms — pisos, pantalla en avión, etc.).
6. Identify the top 3 actions that would make today a win — pull from BOTH NorthStar tasks AND active project deliverables.
7. If any tasks have overdue due_dates, flag them prominently.
8. If any goals have no active objectives or tasks, flag the gap. If any active project shows no recent progress (last commit / KB update >7d), flag it.
9. Call memory_search with query "evolution" in bank "operational" to check for skill evolution insights from last night. If found, include a brief "Evolución del agente" section noting deactivated skills or tool pattern changes.
10. Call intel_query with hours=12 to get overnight signal intelligence from the depot. Call intel_alert_history with hours=12 to check for any FLASH or PRIORITY alerts. Include a "📡 Señales del Depot" section with the top deltas and any active alerts.
11. Call learner_model_status with filter="due" to check concepts that are due for spaced-repetition review today. If the count is > 0, include a "📚 Repaso de hoy" section listing up to 5 concepts with a one-line nudge: "Responde 'quiz me on X' o 'explícame X de vuelta' para repasar." If count is 0, OMIT the section entirely (do not write "nothing due").
12. Send the briefing via gmail_send to fede@eurekamd.net with subject "Buenos días — ${dateLabel}".

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
    agentType: "fast",
    tools: [
      "jarvis_file_read",
      "memory_search",
      "gmail_send",
      "project_list",
      "intel_query",
      "intel_alert_history",
      "learner_model_status",
    ],
    requiredTools: ["jarvis_file_read", "gmail_send"],
  };
}
