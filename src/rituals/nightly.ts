/**
 * Nightly close task template.
 *
 * Submitted to the dispatcher as a fast runner task. The LLM reviews the day
 * FROM THE DAY-LOG (the only record of work done; NorthStar is NOT read for
 * advancement — operator ruling 2026-06-23), prepares tomorrow, and emails the
 * report. Journal is user-only — the agent does NOT write there.
 */

import type { TaskSubmission } from "../dispatch/dispatcher.js";

export function createNightlyClose(dateLabel: string): TaskSubmission {
  return {
    title: `Nightly close — ${dateLabel}`,
    description: `You are Jarvis, Fede's personal strategic assistant. Execute the nightly close ritual.

## Source of truth (READ THIS FIRST)

The Telegram **day-log is the ONLY record of work done.** Do NOT read NorthStar —
it is a stale compass, not the record of today's work. Ground this close in
exactly two sources:
1. **today's day-log** (\`logs/day-logs/${dateLabel}.md\` — the verbatim record of
   today's Telegram activity), and
2. the **active-project list**.

NEVER state a task count ("N tareas completadas") or a deadline unless it appears
verbatim in today's day-log. There is no due_date/deadline data in this system —
do NOT invent "pending"/"overdue" tasks. Report only what the day-log shows.

## Instructions (BUDGET: max 8 tool calls)

1. Call jarvis_file_read on path="logs/day-logs/${dateLabel}.md" — today's verbatim Telegram log, what actually happened today. If it doesn't exist, the day was quiet on Telegram — say so briefly and keep the close short.
2. Call project_list for active projects; note which ones today's log shows real movement on.
3. From the day-log, summarize: what moved today, what was left open (a thread the operator was mid-way through), and the top 3 for tomorrow. Tie each line to something the log actually shows.
4. Send the report via gmail_send to fede@eurekamd.net with subject "Cierre del día — ${dateLabel}".

Do NOT write to the journal. Do NOT rebalance tasks — just report. Do NOT invent counts or deadlines.

## Email body (Spanish, concise)

**Cierre del día** 🌙 ${dateLabel}

**✅ Lo que se movió hoy**
- [de lo que muestra el day-log de hoy]

**⏳ Quedó abierto → mañana**
- [hilos que quedaron a medias en el day-log]

**📋 Top 3 mañana**
1. ...
2. ...
3. ...

[1 frase de reflexión]`,
    agentType: "fast",
    tools: ["jarvis_file_read", "project_list", "gmail_send"],
    requiredTools: ["jarvis_file_read", "gmail_send"],
  };
}
