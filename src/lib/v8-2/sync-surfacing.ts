/**
 * V8.2 sync-surfacing — the Morning Sync as the operator-facing strategic surface.
 *
 * Operator ruling 2026-08-03: the 06:00/07:00 briefs (promote/discard contract)
 * were blocking rather than steering and were retired; the operator's own 08:00
 * "Morning Sync" scheduled task is the surface that works. This module feeds
 * at most ONE vetted judgment per day into that Sync:
 *
 *   - `pickSyncJudgment` selects the best judgment of the last producer pass
 *     (24h window): critic-approved, confidence green/yellow, never surfaced.
 *   - `renderSyncPromptContext` is spliced into the Sync task's PROMPT so the
 *     narrative can weave the reading in naturally.
 *   - `renderSyncStrategicLine` is the compact line the schedule executor
 *     APPENDS to the outbound message DETERMINISTICALLY — the judgment reaching
 *     the operator never depends on the LLM honoring a prompt instruction.
 *   - `markJudgmentSurfaced` stamps `judgments.surfaced_at` (migration v4) only
 *     AFTER the broadcast reports ≥1 channel delivered. V8.3 §12 consent
 *     linkage (judgment-linkage.ts) accepts the stamp as "surfaced to the
 *     operator in a prior cycle" — the successor to the retired delivered-brief
 *     path, so the stamp is a CONSENT record: never write it on intent, only on
 *     verified delivery. An unmarked judgment simply stays eligible tomorrow.
 */

import type Database from "better-sqlite3";
import { getDatabase } from "../../db/index.js";
import { criticVerdict } from "./judgment-format.js";

export interface SyncJudgmentRow {
  id: number;
  subject: string;
  prose: string;
  confidence: "green" | "yellow";
  posture: string;
  critic_trail_json: string | null;
}

/** Carried from prompt-injection to broadcast time by the dynamic scheduler. */
export interface StrategicInjection {
  judgmentId: number;
  /** Deterministic outbound line appended to the Sync's Telegram message. */
  line: string;
  /** Context block spliced into the Sync task's prompt. */
  promptBlock: string;
}

/** Posture order for picking the day's single reading — mirrors the delivery
 *  layer's operator-attention ranking (the headline first, risk before flow). */
const POSTURE_PRIORITY = ["highest_leverage", "at_risk", "momentum", "noted"];

/**
 * Pick the one judgment worth surfacing today: from the last 24h (one producer
 * pass), critic-approved, green/yellow (a red judgment never reaches the
 * operator as guidance — §9), not yet surfaced. Ties break to the newest row.
 * Returns null when nothing qualifies — the Sync goes out unchanged.
 */
export function pickSyncJudgment(
  db: Database.Database = getDatabase(),
): SyncJudgmentRow | null {
  // `datetime(created_at)` — the producer writes ISO-T timestamps
  // (`2026-08-03T12:00:59.190Z`) while `datetime('now',…)` yields space-format;
  // a raw lexical `>=` would over-include every ISO row sharing the threshold's
  // calendar date ('T' 0x54 > ' ' 0x20), stretching the window toward 48h.
  const rows = db
    .prepare(
      `SELECT id, subject, prose, confidence, posture, critic_trail_json
         FROM judgments
        WHERE datetime(created_at) >= datetime('now','-24 hours')
          AND confidence IN ('green','yellow')
          AND surfaced_at IS NULL
        ORDER BY id DESC`,
    )
    .all() as SyncJudgmentRow[];

  const approved = rows.filter(
    (r) => criticVerdict(r.critic_trail_json) === "approved",
  );
  if (approved.length === 0) return null;

  approved.sort((a, b) => {
    const pa = POSTURE_PRIORITY.indexOf(a.posture);
    const pb = POSTURE_PRIORITY.indexOf(b.posture);
    if (pa !== pb) return (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb);
    return b.id - a.id;
  });
  return approved[0];
}

/** Below this, a "sentence" is a fragmentary lead ("Sí.") — prefer the
 *  ellipsis cut over surfacing it alone. */
const MIN_SENTENCE_CUT = 20;

/** First sentences of `text` up to ~`maxLen` chars, cut at a sentence boundary
 *  when a non-fragmentary one exists, with an ellipsis when truncated
 *  mid-thought. */
export function firstSentences(text: string, maxLen: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLen) return collapsed;
  const slice = collapsed.slice(0, maxLen);
  const lastStop = slice.lastIndexOf(". ");
  if (lastStop >= MIN_SENTENCE_CUT) return slice.slice(0, lastStop + 1);
  return `${slice.trimEnd()}…`;
}

/** The compact deterministic line appended to the outbound Sync message. */
export function renderSyncStrategicLine(j: SyncJudgmentRow): string {
  const icon = j.confidence === "green" ? "🟢" : "🟡";
  return `🧭 Lectura estratégica ${icon} ${j.subject} — ${firstSentences(j.prose, 220)}`;
}

/** The prompt block spliced into the Sync task's description so the narrative
 *  can weave the reading naturally. The deterministic outbound line (above) is
 *  the delivery guarantee; this block is flavor, not the contract. */
export function renderSyncPromptContext(j: SyncJudgmentRow): string {
  return [
    "",
    "LECTURA ESTRATÉGICA DE HOY (contexto interno, ya verificado):",
    `- Proyecto: ${j.subject} (confianza: ${j.confidence})`,
    `- Juicio: ${j.prose}`,
    'Si toca algo de lo que está caliente, téjelo en la narrativa con tus palabras — no lo repitas como sección aparte ni menciones "juicio" o "sistema". El sistema añadirá una línea de referencia compacta al final del mensaje automáticamente.',
  ].join("\n");
}

/**
 * Stamp `surfaced_at` on a judgment the operator verifiably received. The
 * `surfaced_at IS NULL` guard makes a double-stamp a no-op (first delivery
 * wins — the consent clock starts at the FIRST time the operator saw it).
 * Returns true when this call wrote the stamp.
 */
export function markJudgmentSurfaced(
  judgmentId: number,
  db: Database.Database = getDatabase(),
): boolean {
  const res = db
    .prepare(
      "UPDATE judgments SET surfaced_at = datetime('now') WHERE id = ? AND surfaced_at IS NULL",
    )
    .run(judgmentId);
  return res.changes > 0;
}
