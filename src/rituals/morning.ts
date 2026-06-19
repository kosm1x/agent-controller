/**
 * Morning briefing task template.
 *
 * Submitted to the dispatcher as a fast runner task.
 * The LLM reads NorthStar/ files via jarvis_file_read to build a structured
 * daily briefing, then emails it to the user.
 */

import { randomUUID } from "node:crypto";
import type { TaskSubmission } from "../dispatch/dispatcher.js";

/**
 * `alertSection`: optional pre-rendered S3 drift-alerts markdown (Spine 2
 * Bundle 2). Computed by the scheduler via `loadActiveAlertsForBrief` +
 * `formatAlertSection` BEFORE this template runs. Empty string ("") or
 * undefined → no S3 section is injected and no LLM instruction is added.
 * Non-empty → the section is embedded in the description and an instruction
 * tells the LLM to copy it verbatim into the email body.
 *
 * Pre-rendering at the scheduler layer (not exposing a tool the LLM calls)
 * matches the Spine 1 P2a R1-C2 lesson: tools that put discipline on the
 * LLM's must-call list risk dispatcher retry → duplicate gmail_send. The
 * S3 alerts are operator-facing strings; the LLM's job is delivery
 * fidelity, not authorship.
 */
export function createMorningBriefing(
  dateLabel: string,
  alertSection?: string,
): TaskSubmission {
  // Stable per-ritual-run identifier the LLM passes to submit_report so the
  // per-task call cap (3 audit attempts per task_id) can fire. The dispatcher's
  // task_id is allocated after submission and never reaches the LLM's prompt
  // (per qa-auditor R1 C1, 2026-05-19 audit log v7.7-spine-1-phase-2a.md).
  // Generated at template-create time so every prompt embeds a concrete value
  // instead of a placeholder the LLM would have to invent.
  const morningBriefTaskId = `morning-brief-${dateLabel}-${randomUUID().slice(0, 8)}`;

  // Pre-compute yesterday's label so the LLM can read the prior-day narrative.
  const [y, m, d] = dateLabel.split("-").map(Number);
  const yd = new Date(Date.UTC(y, m - 1, d - 1));
  const yesterdayLabel = `${yd.getUTCFullYear()}-${String(yd.getUTCMonth() + 1).padStart(2, "0")}-${String(yd.getUTCDate()).padStart(2, "0")}`;

  // S3 drift-alerts block (Spine 2 Bundle 2). Two parts injected only when
  // alertSection is non-empty: the section itself (in description body) and
  // a verbatim-copy instruction the LLM must follow.
  const hasAlerts =
    typeof alertSection === "string" && alertSection.trim().length > 0;
  // R1-W1 fold: single unambiguous placement directive. Section is appended
  // at the VERY BOTTOM of the email, after "Racha actual" — matches its
  // physical position in this description template. No "move from here to
  // there" instruction (LLMs are unreliable at that under long context).
  const s3SectionForPrompt = hasAlerts
    ? `\n\n## Sección de alertas S3 — COPIA VERBATIM al final del email\n\nAl final del email, DESPUÉS de la línea "Racha actual", incluye exactamente la siguiente sección. Cópiala tal cual: no la parafrasees, no traduzcas los nombres de señal, mantén los emojis y la jerarquía exacta de Markdown.\n\n---\n\n${alertSection}\n\n---`
    : "";
  return {
    title: `Morning briefing — ${dateLabel}`,
    description: `You are Jarvis, Fede's personal strategic assistant. Execute the morning briefing ritual.

## Instructions

NorthStar is the **compass** (intent: visions, goals, objectives, recurring rhythms).
Project KB tree is the **execution surface** (in-flight project work). Read both;
NorthStar tells you *where Fede is heading*, projects tell you *what's moving today*.

0. Call jarvis_file_read on path="logs/day-narratives/${yesterdayLabel}.md" to read yesterday's session narrative. This gives you ground truth on what actually happened yesterday — completed analyses, KB updates, code shipped, conversations. If the file doesn't exist (first day), skip this step. Use it to resolve any uncertainty the user or the brief flagged about prior work.
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
12. **Audit before sending (V8 S2)**: call submit_report with surface="morning_brief" and task_id="${morningBriefTaskId}" (this exact string — required for the per-task call cap to function). Assemble verified_against citations as you went through steps 1-11:
    - For jarvis_file_read citations: {type:"file", path, queried_at:<ISO timestamp>}. sha256 is optional; omit if not available (Phase 2a — jarvis_file_read does not currently expose content hash).
    - For tool outputs (intel_query, intel_alert_history, memory_search, project_list, learner_model_status): {type:"tool_output", tool_name, call_id, output_sha256:<64-hex>, queried_at}. If you don't have a hash, use the first 64 hex chars of a SHA256 you compute over the JSON output, or omit the call_id and use the surface-level snapshot.
    Every aggregate-shaped claim ("3 critical tasks", "2 overdue goals", "X concepts due") must reference at least one verified_against entry by zero-based index. If sample_n < 30 for any aggregate, list a small_sample concern. The tool returns one of:
   - ok:true, critic_verdict:"pass" — proceed to step 13
   - ok:true, critic_verdict:"fail_returned_anyway" — read the critic_critique, but PROCEED to step 13 regardless. Do NOT drop the daily brief. The failure is recorded in the reports table.
   - ok:false, kind:"schema"|"invariants" — fix the cited issues and call submit_report AGAIN with a fresh report_id (max 3 audit attempts per task_id; the tool enforces this).
   - ok:false, kind:"cap_exceeded" — proceed to step 13 with the latest draft. The audit trail is already persisted.
13. Send the briefing via gmail_send to fede@eurekamd.net with subject "Buenos días — ${dateLabel}".

IMPORTANT: submit_report is observability, NOT a delivery gate. gmail_send must run even when the audit fails. Dropping a morning brief because the critic disagreed is a worse failure mode than shipping a brief with an audit_failed flag.

IMPORTANT: Do NOT write to the journal. The journal is exclusively for the user's personal input.

## Email body format (Spanish, Mexican)

**Buenos días, Fede.** 🗓️ ${dateLabel}

**Tu visión**: [one-line reminder]

**📋 Ayer**: [1-2 líneas de lo más relevante de ayer: qué se completó, qué quedó pendiente, basado en la narrativa del día anterior. Si no hay narrativa, omitir esta línea.]

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

Racha actual: X días consecutivos.${s3SectionForPrompt}`,
    agentType: "fast",
    tools: [
      "jarvis_file_read",
      "memory_search",
      "gmail_send",
      "project_list",
      "intel_query",
      "intel_alert_history",
      "learner_model_status",
      "submit_report",
    ],
    // requiredTools is the dispatcher's hard-fail-and-retry contract
    // (dispatcher.ts:430-481 — missing required tool fails the task AND
    // re-submits the whole brief). If submit_report were here and the LLM
    // skipped it, the dispatcher would re-run morning_brief AFTER gmail_send
    // already shipped — producing two morning briefs in the user's inbox.
    // The S2 audit is observability, not delivery; gmail_send stays required,
    // submit_report stays in `tools` and is enforced only by the prose
    // instruction in the description.
    requiredTools: ["jarvis_file_read", "gmail_send"],
  };
}
