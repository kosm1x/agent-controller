/**
 * Briefing renderer — V8.1 Phase 8 (spec §12 Phase 8 item 1).
 *
 * Renders a typed `Briefing` (constructed as data in Phase 6) into
 * operator-readable Spanish markdown for delivery. This is the ONLY place a
 * briefing becomes prose — the judgment pipeline never emits text.
 *
 * Channel-agnostic: the same string is delivered to Telegram, WhatsApp and
 * email. Per-channel formatting (HTML conversion, chunking) is the channel
 * adapter's job.
 */

import type { Briefing, Judgment } from "./schema.js";

const SURFACE_LABEL: Record<Briefing["surface"], string> = {
  morning: "Resumen matutino",
  idle_alert: "Aviso de inactividad",
  pattern_alert: "Aviso de patrón",
  weekly: "Resumen semanal",
};

const POSTURE: Record<Judgment["posture"], { emoji: string; label: string }> = {
  highest_leverage: { emoji: "⭐", label: "Máxima palanca" },
  at_risk: { emoji: "🔴", label: "En riesgo" },
  has_momentum: { emoji: "🟢", label: "Con impulso" },
  noted: { emoji: "🔹", label: "Para tu radar" },
};

/** Confidence shown as a coloured dot prefix on each bullet. */
const CONFIDENCE_DOT: Record<Judgment["confidence"], string> = {
  green: "🟢",
  yellow: "🟡",
  red: "🔴",
};

/** The non-highest-leverage postures, in display order. */
const GROUPED_POSTURES = ["at_risk", "has_momentum", "noted"] as const;

/** Render `generated_at` as a Mexico-City long date (no UTC-offset trap). */
function dateLabel(iso: string): string {
  return new Date(iso).toLocaleDateString("es-MX", {
    timeZone: "America/Mexico_City",
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

/** One judgment as a markdown bullet: confidence dot, subject anchor, reasoning. */
function renderJudgment(j: Judgment): string {
  return `- ${CONFIDENCE_DOT[j.confidence]} *${j.subject}* — ${j.why}`;
}

/**
 * Render a briefing into Spanish markdown. The highest-leverage judgment (if
 * any) is featured first; the rest are grouped by posture. A non-`pass` S2
 * verdict is surfaced honestly. The footer tells the operator how their reply
 * promotes or discards the brief (spec §10 promote/discard).
 *
 * `extraSection` (optional) is pre-rendered markdown spliced in just BEFORE the
 * footer — the seam the V8.2 delivery layer uses to append its strategic-
 * judgment section (`renderStrategicSection`) without this renderer knowing
 * anything about V8.2. Absent/blank → byte-identical V8.1 output (the param is
 * additive; the existing callers and tests pass no second argument).
 */
export function renderBriefing(
  briefing: Briefing,
  extraSection?: string,
): string {
  const lines: string[] = [];
  lines.push(
    `*${SURFACE_LABEL[briefing.surface]}* — ${dateLabel(briefing.generated_at)}`,
  );
  lines.push("");

  // The single highest-leverage judgment, featured. `highest_leverage_pick`
  // (when set) is authoritative; otherwise fall back to the lone judgment
  // whose posture is 'highest_leverage' (invariant 3 caps it at one).
  const hl = briefing.highest_leverage_pick
    ? briefing.judgments.find(
        (j) => j.signal_id === briefing.highest_leverage_pick,
      )
    : briefing.judgments.find((j) => j.posture === "highest_leverage");
  if (hl) {
    lines.push(
      `${POSTURE.highest_leverage.emoji} *${POSTURE.highest_leverage.label} hoy*`,
    );
    lines.push(hl.why);
    lines.push("");
  }

  // Remaining judgments, grouped by posture (highest_leverage handled above).
  for (const posture of GROUPED_POSTURES) {
    const group = briefing.judgments.filter((j) => j.posture === posture);
    if (group.length === 0) continue;
    lines.push(`${POSTURE[posture].emoji} *${POSTURE[posture].label}*`);
    for (const j of group) lines.push(renderJudgment(j));
    lines.push("");
  }

  // S2 transparency — never hide a non-pass verdict from the operator.
  if (briefing.critic_verdict !== "pass") {
    lines.push(
      `_Nota: la autoauditoría marcó este resumen como \`${briefing.critic_verdict}\`._`,
    );
    lines.push("");
  }

  // V8.2 delivery seam — append the strategic-judgment section (if any) before
  // the footer, so the promote/discard line stays last.
  const extra = extraSection?.trim();
  if (extra) {
    lines.push(extra);
    lines.push("");
  }

  // The footer IS the affordance — it must state the exact verdict vocabulary
  // `classifyOperatorVerdict` accepts. It previously read "responde lo que sea
  // para conservar este resumen", which made acceptance mean "the operator sent
  // a message", not "the operator endorsed this brief" — destroying §17's 6a
  // calibration check. Any edit here must stay in sync with ACCEPT_RE/DISCARD_RE
  // in `promote.ts`.
  lines.push("—");
  lines.push(
    "_¿Te sirvió para enfocar el día? Responde *sirve* o *descarta*. " +
      "Cualquier otra respuesta lo deja pendiente._",
  );
  return lines.join("\n").trim();
}
