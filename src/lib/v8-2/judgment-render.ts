/**
 * V8.2 strategic-section renderer — the delivery-time surface of the shadow
 * judgments (spec §4 Flow A "deliver", §9 drop-vs-surface).
 *
 * The producer (`produce.ts`) persists EVERY assembled judgment so the §17
 * gate can measure the unfixable rate from `critic_trail_json`. So the §9
 * drop-vs-surface decision is a DELIVERY-time filter — applied HERE, not at
 * write time. Only a VETTED green/yellow judgment (critic not `unfixable`)
 * surfaces with its A/B/C options; a red, un-finalized (null-confidence), OR
 * critic-`unfixable` judgment surfaces only through the §9 carve-out
 * (`posture==='at_risk'` or `kind==='recurring_blocker'`) as an optionless
 * heads-up — everything else is dropped from the operator payload. (A
 * null-confidence row is a half-written producer pass — un-vetted, so it never
 * gets the options tier; it survives only as a carve-out heads-up.)
 *
 * Returns null when nothing is deliverable, so `deliverBriefing` falls back to
 * the V8.1-only brief. This section is APPENDED (before the promote/discard
 * footer), never replacing the V8.1 prose — collapsing the two surfaces is a
 * later §16 operator call, not this layer's job (additive discipline).
 *
 * Pure: no I/O, no DB. The caller fetches the rows (`getJudgmentsForBriefing`).
 */

import type { Judgment } from "../../briefing/schema.js";
import type { JudgmentRow } from "./judgments-store.js";
import { criticVerdict, renderOptions } from "./judgment-format.js";
import { shouldSurfaceUnfixable } from "./should-surface.js";

const SECTION_HEADER = "*Lectura estratégica*";

/** Confidence dot prefix; null (un-finalized producer pass) → neutral dot. */
const CONFIDENCE_DOT: Record<"green" | "yellow" | "red", string> = {
  green: "🟢",
  yellow: "🟡",
  red: "🔴",
};
function confidenceDot(c: JudgmentRow["confidence"]): string {
  return c ? CONFIDENCE_DOT[c] : "⚪";
}

/** Spanish posture label — V8.2 persisted vocab ('momentum', not the V8.1
 *  'has_momentum'); see [[feedback_stale_spec_reconciliation]]. */
const POSTURE_LABEL: Record<JudgmentRow["posture"], string> = {
  highest_leverage: "Máxima palanca",
  at_risk: "En riesgo",
  momentum: "Con impulso",
  noted: "Para tu radar",
};

/** Display priority — lead with the highest-leverage call, mirror the V8.1
 *  brief's posture order (`render.ts` GROUPED_POSTURES) for the rest. */
const POSTURE_ORDER: JudgmentRow["posture"][] = [
  "highest_leverage",
  "at_risk",
  "momentum",
  "noted",
];

interface Deliverable {
  row: JudgmentRow;
  /** True when surfaced through the §9 red/unfixable carve-out → optionless
   *  heads-up with explicit thin-evidence framing. */
  headsUp: boolean;
}

/**
 * Apply the §9 drop-vs-surface filter to one row. A VETTED green/yellow judgment
 * whose critic verdict is not `unfixable` surfaces with options; a red,
 * null-confidence (un-finalized), or critic-`unfixable` judgment surfaces only
 * via the at_risk/recurring_blocker carve-out (optionless heads-up); else drop.
 */
function classify(row: JudgmentRow): Deliverable | null {
  // The options tier is reserved for vetted, fixable judgments. null confidence
  // (a half-written producer pass) is treated as un-vetted alongside red.
  const vetted = row.confidence === "green" || row.confidence === "yellow";
  const dropTriggered =
    !vetted || criticVerdict(row.criticTrailJson) === "unfixable";
  if (!dropTriggered) return { row, headsUp: false };

  // §9 carve-out — the canonical rule is `shouldSurfaceUnfixable` (one source of
  // truth, unit-tested in should-surface.test.ts). Cross the row→Judgment vocab
  // boundary here, the single sanctioned crossing point: de-normalize
  // 'momentum'→'has_momentum'; `signalKind` is a persisted SignalKind value.
  const decision = shouldSurfaceUnfixable({
    posture: row.posture === "momentum" ? "has_momentum" : row.posture,
    kind: (row.signalKind ?? "") as Judgment["kind"],
  });
  return decision.surface ? { row, headsUp: true } : null;
}

/** One deliverable judgment as a markdown block. */
function renderOne(d: Deliverable): string {
  const { row, headsUp } = d;
  const lines: string[] = [];
  lines.push(
    `${confidenceDot(row.confidence)} *${row.subject}* · _${POSTURE_LABEL[row.posture]}_`,
  );
  if (headsUp) {
    // §9: an at_risk/recurring_blocker red judgment is an optionless heads-up,
    // framed so the operator reads it as a thin-evidence early signal.
    lines.push("_Señal temprana — la evidencia aún es delgada._");
  }
  lines.push(row.prose);
  if (!headsUp) {
    const opts = renderOptions(row.proposedOptionsJson);
    if (opts.length > 0) {
      lines.push("");
      lines.push("Opciones:");
      for (const o of opts) lines.push(o);
    }
  }
  return lines.join("\n");
}

/**
 * Render the deliverable V8.2 judgments of a brief as a Spanish-markdown
 * section, or null when none survive the §9 filter. Ordered by posture
 * (highest-leverage first); the sort is stable, so within a posture the rows
 * keep their `getJudgmentsForBriefing` (id-ascending) order.
 */
export function renderStrategicSection(rows: JudgmentRow[]): string | null {
  const deliverable = rows
    .map(classify)
    .filter((d): d is Deliverable => d !== null);
  if (deliverable.length === 0) return null;

  deliverable.sort(
    (a, b) =>
      POSTURE_ORDER.indexOf(a.row.posture) -
      POSTURE_ORDER.indexOf(b.row.posture),
  );

  return [SECTION_HEADER, "", deliverable.map(renderOne).join("\n\n")].join(
    "\n",
  );
}
