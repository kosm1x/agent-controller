/**
 * Day-log narrative ritual — curated daily summary of interactions.
 *
 * Context: since 2026-04-04 (commit 724ed54), `appendDayLog()` writes a
 * mechanical verbatim log of every user↔Jarvis exchange to
 * `logs/day-logs/YYYY-MM-DD.md`. That raw log is the source of truth for
 * precision (no LLM can drop a message), but it lacks the narrative layer
 * Jarvis used to produce via hourly consolidation tasks.
 *
 * This ritual restores that narrative layer without sacrificing the raw
 * source. It runs once per day at 23:30 Mexico City — after skill-evolution
 * (23:00) and before evolution-log (23:59) — reads the raw day-log, and
 * writes a companion narrative file to `logs/day-narratives/YYYY-MM-DD.md`.
 *
 * The raw file is never modified; narrative is purely additive. If the
 * ritual fails for any reason, no interaction data is lost.
 */
import type { TaskSubmission } from "../dispatch/dispatcher.js";

export function createDayNarrative(dateLabel: string): TaskSubmission {
  const rawPath = `logs/day-logs/${dateLabel}.md`;
  const narrativePath = `logs/day-narratives/${dateLabel}.md`;

  return {
    title: `Day log narrative — ${dateLabel}`,
    description: `You are Jarvis, producing today's curated narrative day-log.

## Why this ritual exists

Since 2026-04-04, the raw day-log at \`logs/day-logs/${dateLabel}.md\` captures every user↔Jarvis exchange verbatim. That file is the source of truth for precision — never modify it. This ritual produces a *companion* narrative view that restores the structured event table the user had before the mechanical log replaced the old hourly consolidation.

## Steps

1. Call \`jarvis_file_read\` with path \`${rawPath}\`. This is the raw verbatim log for today. If the file doesn't exist or is empty, write a narrative noting "Día sin interacciones registradas" and stop.

2. Parse the raw entries (format: \`- [HH:MM:SS] **USER|JARVIS**: <message>\`) and mentally group adjacent USER→JARVIS exchanges into discrete events.

3. For each event, infer a short action label (e.g. "Solicitud de diagnóstico", "Consulta sobre territorio Ucrania", "Aprobación de plan X", "Ejecución de fix de surrogate", "Confirmación protocolo"). Use the user's original language (Spanish for most).

4. Call \`jarvis_file_write\` with:
   - path: \`${narrativePath}\`
   - title: \`Bitácora narrativa: ${dateLabel}\`
   - qualifier: \`reference\`
   - content: the narrative document in the EXACT format below.

## Output format

\`\`\`
# Bitácora narrativa — ${dateLabel}

**Zona horaria:** Ciudad de México (UTC-6)
**Fuente:** \`${rawPath}\` (verbatim, inmutable)

---

## Resumen del día

[2-4 sentences: tema dominante del día, número aproximado de intercambios, contexto de proyectos tocados, cualquier incidente o hito]

---

## Registro de eventos

| Hora | Evento / Acción | Detalles |
|------|-----------------|----------|
| HH:MM | [action label] | [1-2 sentences of what happened — what user asked, what Jarvis did, outcome] |
| ... | ... | ... |

---

## Temas tocados

- [Bullet list of distinct topics/projects — e.g. "v7 roadmap", "API 400 fix", "CRM Phase X", "pipesong"]

---

## Hitos / decisiones

- [Any lasting decisions, scope changes, commits, deploys, or protocol updates]
- [If nothing notable: "Sin hitos permanentes registrados."]

---

## Fricciones

- [Any repeated misunderstandings, failed tool calls, corrections the user had to make]
- [If none: "Ninguna detectada."]
\`\`\`

## Rules

- Write in Spanish by default (match the user's primary language of interaction today).
- Be specific. "Usuario pidió X, Jarvis hizo Y, resultado Z" beats "hubo una interacción sobre X".
- Timestamps in the table must come from the raw log, not invented.
- If multiple USER messages are clearly one continuous thought, group them as one event and use the timestamp of the first.
- Skip ritual-system messages (morning briefing deliveries, scheduled task confirmations) — those already live in run metadata. Only narrate human↔Jarvis exchanges.
- Do NOT modify \`${rawPath}\`. Do NOT call \`jarvis_file_delete\`. The raw log is immutable source-of-truth.

When you're done, report: narrative path, event count, dominant topics.`,
    agentType: "fast",
    tools: ["jarvis_file_read", "jarvis_file_write"],
  };
}
