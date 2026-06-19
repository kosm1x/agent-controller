/**
 * V8.2 `judgments` row access — readers + the §13 concession writers.
 *
 * Kept OUT of the V8.1 `src/briefing/storage.ts` (which owns
 * `proposed_briefings`) so V8.2's data model stays in the `v8-2` namespace.
 * The `judgments` table is the normalized child of `proposed_briefings`
 * (Phase 0 DDL); the concession handler (`concession.ts`) reads a judgment to
 * restate or re-run it and writes back `concession_kind` /
 * `triggering_evidence_text` / an appended `operator_message` evidence ref.
 *
 * Additive + dormant: no producer writes `judgments` rows yet, so every reader
 * returns empty in production today. The concession path is gated on
 * `countJudgmentsForBriefing > 0`, so these run only once the judgment-assembly
 * producer (a later phase) starts emitting rows.
 */

import type Database from "better-sqlite3";
import { getDatabase, writeWithRetry } from "../../db/index.js";
import { createLogger } from "../logger.js";
import type { Judgment } from "../../briefing/schema.js";
import { EvidenceRefSchema, type EvidenceRef } from "./types.js";

const log = createLogger("v8-2:judgments-store");

/** Persisted `judgments` row (camelCase view of the Phase-0 DDL columns).
 *  NOTE `posture` here is the V8.2 persisted vocab ('momentum'), NOT the V8.1
 *  Zod base ('has_momentum') — the judgment pass normalizes on the way in. */
export interface JudgmentRow {
  id: number;
  briefingId: string;
  subject: string;
  posture: "at_risk" | "momentum" | "highest_leverage" | "noted";
  prose: string;
  confidence: "green" | "yellow" | "red" | null;
  signalKind: string | null;
  signalLastSeenAt: string | null;
  createdAt: string;
  evidenceRefsJson: string | null;
  proposedOptionsJson: string | null;
  strategicVoicePrincipleId: string | null;
  concessionKind:
    | "held_position"
    | "updated_with_evidence"
    | "conceded_without_evidence"
    | null;
  triggeringEvidenceText: string | null;
  confidenceBasisJson: string | null;
  criticTrailJson: string | null;
}

interface RawJudgmentRow {
  id: number;
  briefing_id: string;
  subject: string;
  posture: JudgmentRow["posture"];
  prose: string;
  confidence: JudgmentRow["confidence"];
  signal_kind: string | null;
  signal_last_seen_at: string | null;
  created_at: string;
  evidence_refs_json: string | null;
  proposed_options_json: string | null;
  strategic_voice_principle_id: string | null;
  concession_kind: JudgmentRow["concessionKind"];
  triggering_evidence_text: string | null;
  confidence_basis_json: string | null;
  critic_trail_json: string | null;
}

function rowToJudgment(r: RawJudgmentRow): JudgmentRow {
  return {
    id: r.id,
    briefingId: r.briefing_id,
    subject: r.subject,
    posture: r.posture,
    prose: r.prose,
    confidence: r.confidence,
    signalKind: r.signal_kind,
    signalLastSeenAt: r.signal_last_seen_at,
    createdAt: r.created_at,
    evidenceRefsJson: r.evidence_refs_json,
    proposedOptionsJson: r.proposed_options_json,
    strategicVoicePrincipleId: r.strategic_voice_principle_id,
    concessionKind: r.concession_kind,
    triggeringEvidenceText: r.triggering_evidence_text,
    confidenceBasisJson: r.confidence_basis_json,
    criticTrailJson: r.critic_trail_json,
  };
}

const SELECT_COLS = `id, briefing_id, subject, posture, prose, confidence,
  signal_kind, signal_last_seen_at, created_at, evidence_refs_json,
  proposed_options_json, strategic_voice_principle_id, concession_kind,
  triggering_evidence_text, confidence_basis_json, critic_trail_json`;

/** How many V8.2 judgments are attached to a briefing. The concession path is
 *  gated on this being > 0 — keeps the reply hot-path a pure regex until the
 *  producer ships (additive + dormant). */
export function countJudgmentsForBriefing(
  briefingId: string,
  db: Database.Database = getDatabase(),
): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM judgments WHERE briefing_id = ?`)
    .get(briefingId) as { n: number } | undefined;
  return row?.n ?? 0;
}

export function getJudgmentsForBriefing(
  briefingId: string,
  db: Database.Database = getDatabase(),
): JudgmentRow[] {
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLS} FROM judgments WHERE briefing_id = ? ORDER BY id`,
    )
    .all(briefingId) as RawJudgmentRow[];
  return rows.map(rowToJudgment);
}

export function getJudgmentById(
  id: number,
  db: Database.Database = getDatabase(),
): JudgmentRow | null {
  const row = db
    .prepare(`SELECT ${SELECT_COLS} FROM judgments WHERE id = ?`)
    .get(id) as RawJudgmentRow | undefined;
  return row ? rowToJudgment(row) : null;
}

/**
 * Normalize the V8.1 `Judgment` posture vocabulary ('has_momentum') to the
 * persisted `judgments.posture` CHECK vocabulary ('momentum'). The two diverge
 * deliberately (the in-memory base is the V8.1 schema; the table is the V8.2
 * vocab) — this is the single sanctioned crossing point. Every other posture is
 * identical across the two enums.
 */
export function normalizePosture(
  p: Judgment["posture"],
): JudgmentRow["posture"] {
  return p === "has_momentum" ? "momentum" : p;
}

/** A new `judgments` row to insert. `posture` is the V8.1 vocabulary; it is
 *  normalized to the persisted 'momentum' form here so a caller can never trip
 *  the CHECK constraint. Optional `*Json` columns default to null. */
export interface NewJudgment {
  briefingId: string;
  subject: string;
  posture: Judgment["posture"];
  prose: string;
  createdAt: string;
  confidence?: "green" | "yellow" | "red" | null;
  signalKind?: string | null;
  signalLastSeenAt?: string | null;
  evidenceRefsJson?: string | null;
  proposedOptionsJson?: string | null;
  strategicVoicePrincipleId?: string | null;
  confidenceBasisJson?: string | null;
  criticTrailJson?: string | null;
}

/**
 * INSERT one `judgments` row and return its auto-increment id. This is the
 * judgment-assembly producer's write — the row the whole V8.2 layer was dormant
 * for (no production INSERT existed before; only `setConcessionKind` /
 * `appendEvidenceRef` UPDATE an existing row). Posture is normalized here, so
 * the CHECK can't be violated. The `attributed_claims` children are written
 * separately (`persistAttributedClaims`) AFTER this returns the id (FK order).
 */
export function insertJudgment(
  j: NewJudgment,
  db: Database.Database = getDatabase(),
): number {
  return writeWithRetry(() => {
    const info = db
      .prepare(
        `INSERT INTO judgments
           (briefing_id, subject, posture, prose, confidence, signal_kind,
            signal_last_seen_at, created_at, evidence_refs_json,
            proposed_options_json, strategic_voice_principle_id,
            confidence_basis_json, critic_trail_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        j.briefingId,
        j.subject,
        normalizePosture(j.posture),
        j.prose,
        j.confidence ?? null,
        j.signalKind ?? null,
        j.signalLastSeenAt ?? null,
        j.createdAt,
        j.evidenceRefsJson ?? null,
        j.proposedOptionsJson ?? null,
        j.strategicVoicePrincipleId ?? null,
        j.confidenceBasisJson ?? null,
        j.criticTrailJson ?? null,
      );
    return Number(info.lastInsertRowid);
  });
}

/** Overwrite a judgment's prose (the critic-loop re-author / concession re-run
 *  writes the revised text back onto the row). */
export function updateJudgmentProse(
  id: number,
  prose: string,
  db: Database.Database = getDatabase(),
): void {
  writeWithRetry(() => {
    db.prepare(`UPDATE judgments SET prose = ? WHERE id = ?`).run(prose, id);
  });
}

/** Post-critic finalize: write the computed `confidence`, its basis, and the
 *  critic trail onto the judgment row. Null args leave that column unchanged is
 *  NOT the semantics — they SET the column (the producer always has all three
 *  after the critic loop). */
export function updateJudgmentVerdict(
  id: number,
  fields: {
    confidence: "green" | "yellow" | "red" | null;
    confidenceBasisJson: string | null;
    criticTrailJson: string | null;
  },
  db: Database.Database = getDatabase(),
): void {
  writeWithRetry(() => {
    db.prepare(
      `UPDATE judgments
          SET confidence = ?, confidence_basis_json = ?, critic_trail_json = ?
        WHERE id = ?`,
    ).run(
      fields.confidence,
      fields.confidenceBasisJson,
      fields.criticTrailJson,
      id,
    );
  });
}

/**
 * Set `concession_kind` (§13). `triggering_evidence_text` is written ONLY for
 * `updated_with_evidence` (the CHECK allows it for any kind, but the spec ties
 * it to the update path) and cleared otherwise to avoid a stale carry-over.
 *
 * `conceded_without_evidence` is intentionally accepted by the column CHECK but
 * is NEVER passed here by the live handler — it is produced only by the §14
 * nightly probe as a measured failure (see `concession.ts`). Passing it here is
 * a caller bug, not a guard this function enforces.
 */
export function setConcessionKind(
  id: number,
  kind: "held_position" | "updated_with_evidence",
  triggeringEvidenceText: string | null = null,
  db: Database.Database = getDatabase(),
): void {
  const text = kind === "updated_with_evidence" ? triggeringEvidenceText : null;
  writeWithRetry(() => {
    db.prepare(
      `UPDATE judgments
         SET concession_kind = ?, triggering_evidence_text = ?
       WHERE id = ?`,
    ).run(kind, text, id);
  });
}

/** Parse `evidence_refs_json` defensively — a malformed/absent blob yields []. */
function parseEvidenceRefs(json: string | null): EvidenceRef[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    const out: EvidenceRef[] = [];
    for (const item of parsed) {
      const r = EvidenceRefSchema.safeParse(item);
      if (r.success) out.push(r.data);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Append one evidence ref to a judgment's `evidence_refs_json` ledger and
 * persist it. Returns the FULL new ledger. Used by the §13 update path to add
 * the operator's message as `evidence_kind='operator_message'`
 * (`retrieved_at=now`, never stale — §18 Q5). Validates the incoming ref so a
 * malformed append can't corrupt the ledger.
 */
export function appendEvidenceRef(
  id: number,
  ref: EvidenceRef,
  db: Database.Database = getDatabase(),
): EvidenceRef[] {
  const validated = EvidenceRefSchema.parse(ref);
  const current = getJudgmentById(id, db);
  if (!current) {
    log.warn({ judgmentId: id }, "appendEvidenceRef: judgment not found");
    throw new Error(`judgment ${id} not found`);
  }
  const existing = parseEvidenceRefs(current.evidenceRefsJson);
  // Idempotent (qa-W2): a re-run failure leaves the appended ref but no
  // concession; on the operator's retry the same (kind, excerpt) must NOT be
  // double-appended (which would inflate `distinct_sources` with phantom
  // duplicates). Identity = (kind, excerpt) — the operator message text.
  if (
    existing.some(
      (r) => r.kind === validated.kind && r.excerpt === validated.excerpt,
    )
  ) {
    return existing;
  }
  const next = [...existing, validated];
  writeWithRetry(() => {
    db.prepare(`UPDATE judgments SET evidence_refs_json = ? WHERE id = ?`).run(
      JSON.stringify(next),
      id,
    );
  });
  return next;
}
