/**
 * Morning briefing task template.
 *
 * Submitted to the dispatcher as a fast runner task.
 * The LLM grounds the brief in yesterday's day-log narrative + the active-project
 * list (the day-log is the only record of work done; NorthStar is NOT read for
 * advancement — operator ruling 2026-06-23), then emails it to the user.
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

## Source of truth (READ THIS FIRST)

The Telegram **day-log is the ONLY record of work done.** NorthStar is a stale
compass of visions/goals — do NOT read it or use it to judge advancement,
deadlines, or what is "stalled." Ground this brief in exactly two sources:
1. **yesterday's day-log narrative** (what actually happened), and
2. **the active-project list** (what is in flight).

NEVER state a task count, a deadline, or "N overdue" unless it appears verbatim
in yesterday's narrative or a project README. There is no deadline/due_date data
in this system. Do NOT fabricate quantities — this brief previously hallucinated
"70+ overdue tasks" from a source that held no such data. If you don't see it in
the day-log or a project README, it does not go in the brief.

## Instructions

0. Call jarvis_file_read on path="logs/day-narratives/${yesterdayLabel}.md" — yesterday's session narrative. This is your PRIMARY input: the ground truth on what actually happened (work completed, KB updates, code shipped, conversations, open threads). If it doesn't exist (first day), skip.
1. Call project_list to see active projects. For projects that yesterday's narrative shows active work on, call jarvis_file_read on projects/<slug>/README.md (cap at 3) for execution-level priorities.
2. From yesterday's narrative + the active projects, determine: what's moving, what's blocked, and which active projects went quiet (no mention in the recent day-log). State only what the narrative/projects actually show.
3. Classify today's candidate actions with the Eisenhower matrix — CRITICAL (urgent+important) / URGENT / IMPORTANT (deep-work blocks) / DELEGABLE — pulling ONLY from active project deliverables and the open threads yesterday's narrative flagged. Signals: blocking relationships, what Fede was actively working on, explicit priority in a README.
4. Identify the top 3 actions that would make today a win — from active projects + yesterday's open threads.
5. Call memory_search with query "evolution" in bank "operational" for skill-evolution insights from last night. If found, include a brief "Evolución del agente" section.
6. Call intel_query with hours=12 and intel_alert_history with hours=12 for overnight depot signals. Include a "📡 Señales del Depot" section with top deltas and any active alerts.
7. Call learner_model_status with filter="due" for spaced-repetition concepts due today. If count > 0, include a "📚 Repaso de hoy" section (up to 5) with the nudge: "Responde 'quiz me on X' o 'explícame X de vuelta' para repasar." If count is 0, OMIT the section.
8. **Audit before sending (V8 S2)**: call submit_report with surface="morning_brief" and task_id="${morningBriefTaskId}" (this exact string — required for the per-task call cap). Assemble verified_against citations from steps 0-7:
    - For jarvis_file_read citations: {type:"file", path, queried_at:<ISO timestamp>}. sha256 optional.
    - For tool outputs (intel_query, intel_alert_history, memory_search, project_list, learner_model_status): {type:"tool_output", tool_name, call_id, output_sha256:<64-hex>, queried_at}. If no hash, use the first 64 hex chars of a SHA256 over the JSON output, or omit call_id.
    Every aggregate-shaped claim ("3 critical actions", "2 quiet projects", "X concepts due") must reference at least one verified_against entry by zero-based index. If sample_n < 30 for any aggregate, list a small_sample concern. The tool returns one of:
   - ok:true, critic_verdict:"pass" — proceed to step 9
   - ok:true, critic_verdict:"fail_returned_anyway" — read the critic_critique, but PROCEED to step 9 regardless. Do NOT drop the daily brief.
   - ok:false, kind:"schema"|"invariants" — fix the cited issues and call submit_report AGAIN with a fresh report_id (max 3 audit attempts per task_id).
   - ok:false, kind:"cap_exceeded" — proceed to step 9 with the latest draft.
9. Send the briefing via gmail_send to fede@eurekamd.net with subject "Buenos días — ${dateLabel}".

IMPORTANT: submit_report is observability, NOT a delivery gate. gmail_send must run even when the audit fails. Dropping a morning brief because the critic disagreed is a worse failure mode than shipping a brief with an audit_failed flag.

IMPORTANT: Do NOT write to the journal. The journal is exclusively for the user's personal input.

## Email body format (Spanish, Mexican)

**Buenos días, Fede.** 🗓️ ${dateLabel}

**📋 Ayer**: [1-2 líneas de lo más relevante de ayer, basado en la narrativa del día. Si no hay narrativa, omitir esta línea.]

**🔴 Crítico** (hacer primero)
- [ ] Acción 1 — [por qué importa, atado a un proyecto o hilo de ayer]
- [ ] Acción 2

**🟠 Urgente**
- [ ] Acción 3

**🟡 Importante** (bloques de deep work)
- [ ] Acción 4

**📂 Proyectos activos**
- [estado de 1 línea por proyecto en movimiento; marca los que llevan días sin aparecer en el day-log]

**⚠️ Alertas**
- [bloqueos reales y proyectos que se quedaron callados. NADA inventado — solo lo que el day-log o un README muestran.]

**🏆 Si logras estas 3 cosas, hoy fue un buen día:**
1. ...
2. ...
3. ...${s3SectionForPrompt}`,
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
