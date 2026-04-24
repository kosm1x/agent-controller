/**
 * Teaching module persistence — CRUD over learning_plans, learning_plan_units,
 * learner_model, learning_sessions. All writes use getDatabase() singleton.
 */

import { randomUUID } from "node:crypto";
import { getDatabase } from "../db/index.js";
import { nextReview, masteryFromSm2 } from "./sm2.js";
import { normalizeConcept } from "./parse.js";
import {
  DEFAULT_EF,
  EF_FLOOR,
  type LearnerConceptRow,
  type LearningPlanRow,
  type LearningPlanUnitRow,
  type LearningSessionRow,
  type PlanStatus,
  type SessionKind,
  type UnitStatus,
} from "./schema-types.js";

// ---------------------------------------------------------------------------
// Plans + units
// ---------------------------------------------------------------------------

export interface CreatePlanInput {
  topic: string;
  notes?: string | null;
  units: Array<{
    title: string;
    summary: string;
    predicted_difficulties: string[];
    prerequisites: number[];
  }>;
}

/** Create plan + insert all units in one transaction. Returns plan_id. */
export function createPlanWithUnits(input: CreatePlanInput): string {
  const db = getDatabase();
  const plan_id = randomUUID();
  const insertPlan = db.prepare(`
    INSERT INTO learning_plans (plan_id, topic, notes, status, current_unit)
    VALUES (?, ?, ?, 'active', 0)
  `);
  const insertUnit = db.prepare(`
    INSERT INTO learning_plan_units
      (plan_id, unit_index, title, summary, predicted_difficulties,
       prerequisites, status, mastery_score)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0)
  `);
  const tx = db.transaction(() => {
    insertPlan.run(plan_id, input.topic.normalize("NFC"), input.notes ?? null);
    input.units.forEach((u, i) => {
      insertUnit.run(
        plan_id,
        i,
        u.title,
        u.summary,
        JSON.stringify(u.predicted_difficulties),
        JSON.stringify(u.prerequisites),
        i === 0 ? "ready" : "locked",
      );
    });
  });
  tx();
  return plan_id;
}

/**
 * Return the most-recently-updated active learning plan, or null if none
 * exists. Used as a fallback when the agent doesn't have an explicit plan_id
 * in context (e.g. "continúa mis lecciones" after a session restart).
 */
export function getActivePlan(): LearningPlanRow | null {
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT * FROM learning_plans WHERE status = 'active'
       ORDER BY updated_at DESC, rowid DESC LIMIT 1`,
    )
    .get() as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    plan_id: row.plan_id as string,
    topic: row.topic as string,
    created_at: row.created_at as number,
    updated_at: row.updated_at as number,
    status: row.status as PlanStatus,
    current_unit: row.current_unit as number,
    notes: (row.notes as string | null) ?? null,
  };
}

export function getPlan(plan_id: string): LearningPlanRow | null {
  const db = getDatabase();
  const row = db
    .prepare(`SELECT * FROM learning_plans WHERE plan_id = ?`)
    .get(plan_id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    plan_id: row.plan_id as string,
    topic: row.topic as string,
    created_at: row.created_at as number,
    updated_at: row.updated_at as number,
    status: row.status as PlanStatus,
    current_unit: row.current_unit as number,
    notes: (row.notes as string | null) ?? null,
  };
}

export function getUnit(
  plan_id: string,
  unit_index: number,
): LearningPlanUnitRow | null {
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT * FROM learning_plan_units WHERE plan_id = ? AND unit_index = ?`,
    )
    .get(plan_id, unit_index) as Record<string, unknown> | undefined;
  if (!row) return null;
  return rowToUnit(row);
}

export function listUnits(plan_id: string): LearningPlanUnitRow[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      `SELECT * FROM learning_plan_units WHERE plan_id = ? ORDER BY unit_index ASC`,
    )
    .all(plan_id) as Array<Record<string, unknown>>;
  return rows.map(rowToUnit);
}

function rowToUnit(row: Record<string, unknown>): LearningPlanUnitRow {
  return {
    plan_id: row.plan_id as string,
    unit_index: row.unit_index as number,
    title: row.title as string,
    summary: row.summary as string,
    predicted_difficulties: safeJsonArray<string>(row.predicted_difficulties),
    prerequisites: safeJsonArray<number>(row.prerequisites),
    status: row.status as UnitStatus,
    mastery_score: row.mastery_score as number,
  };
}

function safeJsonArray<T>(raw: unknown): T[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export function updateUnitStatus(
  plan_id: string,
  unit_index: number,
  status: UnitStatus,
  mastery_score?: number,
): void {
  const db = getDatabase();
  if (typeof mastery_score === "number") {
    db.prepare(
      `UPDATE learning_plan_units SET status = ?, mastery_score = ?
         WHERE plan_id = ? AND unit_index = ?`,
    ).run(status, Math.max(0, Math.min(1, mastery_score)), plan_id, unit_index);
  } else {
    db.prepare(
      `UPDATE learning_plan_units SET status = ?
         WHERE plan_id = ? AND unit_index = ?`,
    ).run(status, plan_id, unit_index);
  }
}

export function setPlanCurrentUnit(plan_id: string, unit_index: number): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE learning_plans SET current_unit = ?, updated_at = unixepoch()
       WHERE plan_id = ?`,
  ).run(unit_index, plan_id);
}

export function setPlanStatus(plan_id: string, status: PlanStatus): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE learning_plans SET status = ?, updated_at = unixepoch()
       WHERE plan_id = ?`,
  ).run(status, plan_id);
}

// ---------------------------------------------------------------------------
// Learner model
// ---------------------------------------------------------------------------

export interface UpsertConceptInput {
  concept: string;
  mastery_estimate: number;
  evidence_quote: string;
  session_id: string;
  now?: number;
}

export interface UpsertConceptResult {
  concept: string;
  mastery_score: number;
  review_due_date: number;
  is_new: boolean;
}

/** Upsert a concept: apply SM-2 update, append evidence, recompute mastery. */
export function upsertConcept(input: UpsertConceptInput): UpsertConceptResult {
  const db = getDatabase();
  const key = normalizeConcept(input.concept);
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const existing = db
    .prepare(`SELECT * FROM learner_model WHERE concept = ?`)
    .get(key) as Record<string, unknown> | undefined;

  const prior = existing
    ? {
        ef: (existing.ef as number) ?? DEFAULT_EF,
        interval_days: (existing.interval_days as number) ?? 0,
        repetitions: (existing.repetitions as number) ?? 0,
      }
    : { ef: DEFAULT_EF, interval_days: 0, repetitions: 0 };

  const quality = Math.round(
    Math.max(0, Math.min(1, input.mastery_estimate)) * 5,
  );
  const sm2 = nextReview({
    ef: prior.ef,
    interval_days: prior.interval_days,
    repetitions: prior.repetitions,
    quality,
    now,
  });

  const evidenceJson = buildEvidence(
    existing?.evidence_quotes,
    input.evidence_quote,
    input.session_id,
    now,
  );
  const newMastery = masteryFromSm2(sm2.ef, sm2.repetitions, sm2.interval_days);

  if (existing) {
    db.prepare(
      `UPDATE learner_model
         SET last_seen = ?, confidence = ?, mastery_score = ?,
             evidence_quotes = ?, ef = ?, interval_days = ?,
             repetitions = ?, review_due_date = ?
         WHERE concept = ?`,
    ).run(
      now,
      Math.max(0, Math.min(1, input.mastery_estimate)),
      newMastery,
      evidenceJson,
      Math.max(EF_FLOOR, sm2.ef),
      sm2.interval_days,
      sm2.repetitions,
      sm2.review_due_date,
      key,
    );
    return {
      concept: key,
      mastery_score: newMastery,
      review_due_date: sm2.review_due_date,
      is_new: false,
    };
  }

  db.prepare(
    `INSERT INTO learner_model
       (concept, first_seen, last_seen, confidence, mastery_score,
        evidence_quotes, ef, interval_days, repetitions, review_due_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    key,
    now,
    now,
    Math.max(0, Math.min(1, input.mastery_estimate)),
    newMastery,
    evidenceJson,
    Math.max(EF_FLOOR, sm2.ef),
    sm2.interval_days,
    sm2.repetitions,
    sm2.review_due_date,
  );
  return {
    concept: key,
    mastery_score: newMastery,
    review_due_date: sm2.review_due_date,
    is_new: true,
  };
}

function buildEvidence(
  prev: unknown,
  quote: string,
  session_id: string,
  ts: number,
): string {
  const trimmed = quote.trim();
  if (!trimmed) return typeof prev === "string" ? prev : "[]";
  let arr: Array<{ quote: string; session_id: string; ts: number }> = [];
  if (typeof prev === "string" && prev.length > 0) {
    try {
      const parsed = JSON.parse(prev);
      if (Array.isArray(parsed)) arr = parsed.slice(-9);
    } catch {
      // ignore malformed prior evidence
    }
  }
  arr.push({ quote: trimmed.slice(0, 240), session_id, ts });
  return JSON.stringify(arr);
}

export function getConcept(concept: string): LearnerConceptRow | null {
  const db = getDatabase();
  const key = normalizeConcept(concept);
  const row = db
    .prepare(`SELECT * FROM learner_model WHERE concept = ?`)
    .get(key) as Record<string, unknown> | undefined;
  return row ? rowToConcept(row) : null;
}

export function listConcepts(opts: {
  filter: "due" | "mastered" | "shaky" | "all";
  limit: number;
  now?: number;
}): LearnerConceptRow[] {
  const db = getDatabase();
  const limit = Math.max(1, Math.min(50, Math.trunc(opts.limit)));
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  let sql: string;
  let params: unknown[];
  switch (opts.filter) {
    case "due":
      sql = `SELECT * FROM learner_model
             WHERE review_due_date IS NOT NULL AND review_due_date <= ?
             ORDER BY review_due_date ASC LIMIT ?`;
      params = [now, limit];
      break;
    case "mastered":
      sql = `SELECT * FROM learner_model
             WHERE mastery_score >= 0.8
             ORDER BY mastery_score DESC, last_seen DESC LIMIT ?`;
      params = [limit];
      break;
    case "shaky":
      sql = `SELECT * FROM learner_model
             WHERE mastery_score > 0 AND mastery_score < 0.5
             ORDER BY mastery_score ASC, last_seen DESC LIMIT ?`;
      params = [limit];
      break;
    case "all":
    default:
      sql = `SELECT * FROM learner_model
             ORDER BY last_seen DESC LIMIT ?`;
      params = [limit];
      break;
  }
  const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  return rows.map(rowToConcept);
}

function rowToConcept(row: Record<string, unknown>): LearnerConceptRow {
  return {
    concept: row.concept as string,
    first_seen: row.first_seen as number,
    last_seen: row.last_seen as number,
    confidence: row.confidence as number,
    mastery_score: row.mastery_score as number,
    evidence_quotes: safeJsonArray<{
      quote: string;
      session_id: string;
      ts: number;
    }>(row.evidence_quotes),
    ef: row.ef as number,
    interval_days: row.interval_days as number,
    repetitions: row.repetitions as number,
    review_due_date: (row.review_due_date as number | null) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export function startSession(input: {
  plan_id: string;
  unit_index: number;
  kind: SessionKind;
}): string {
  const db = getDatabase();
  const session_id = randomUUID();
  db.prepare(
    `INSERT INTO learning_sessions (session_id, plan_id, unit_index, kind)
     VALUES (?, ?, ?, ?)`,
  ).run(session_id, input.plan_id, input.unit_index, input.kind);
  return session_id;
}

export function endSession(input: {
  session_id: string;
  mastery_delta: number | null;
  summary: string | null;
}): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE learning_sessions
       SET ended_at = unixepoch(), mastery_delta = ?, summary = ?
       WHERE session_id = ?`,
  ).run(input.mastery_delta, input.summary, input.session_id);
}

export function getSession(session_id: string): LearningSessionRow | null {
  const db = getDatabase();
  const row = db
    .prepare(`SELECT * FROM learning_sessions WHERE session_id = ?`)
    .get(session_id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    session_id: row.session_id as string,
    plan_id: row.plan_id as string,
    unit_index: row.unit_index as number,
    kind: row.kind as SessionKind,
    started_at: row.started_at as number,
    ended_at: (row.ended_at as number | null) ?? null,
    mastery_delta: (row.mastery_delta as number | null) ?? null,
    transcript_ref: (row.transcript_ref as string | null) ?? null,
    summary: (row.summary as string | null) ?? null,
  };
}

/**
 * Find the most recent open (ended_at IS NULL) session for a given kind on a
 * (plan, unit). Used to pair a grade-mode explain_back to the prompt-mode
 * session it follows, instead of orphaning a session row per pair.
 */
export function findOpenSession(opts: {
  plan_id: string;
  unit_index: number;
  kind: SessionKind;
}): LearningSessionRow | null {
  const db = getDatabase();
  // unixepoch() has 1-second resolution, so ties are common in fast test
  // sequences. rowid DESC breaks ties deterministically — most-recently-
  // inserted wins even when started_at matches.
  const row = db
    .prepare(
      `SELECT * FROM learning_sessions
         WHERE plan_id = ? AND unit_index = ? AND kind = ? AND ended_at IS NULL
         ORDER BY started_at DESC, rowid DESC LIMIT 1`,
    )
    .get(opts.plan_id, opts.unit_index, opts.kind) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  return {
    session_id: row.session_id as string,
    plan_id: row.plan_id as string,
    unit_index: row.unit_index as number,
    kind: row.kind as SessionKind,
    started_at: row.started_at as number,
    ended_at: (row.ended_at as number | null) ?? null,
    mastery_delta: (row.mastery_delta as number | null) ?? null,
    transcript_ref: (row.transcript_ref as string | null) ?? null,
    summary: (row.summary as string | null) ?? null,
  };
}

/** Fetch recent quiz questions for a unit (for dedup on next quiz). */
export function recentQuizQuestions(
  plan_id: string,
  unit_index: number,
  limit = 10,
): string[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      `SELECT summary FROM learning_sessions
         WHERE plan_id = ? AND unit_index = ? AND kind = 'quiz'
           AND summary IS NOT NULL
         ORDER BY started_at DESC LIMIT ?`,
    )
    .all(plan_id, unit_index, Math.max(1, Math.trunc(limit))) as Array<{
    summary: string;
  }>;
  const out: string[] = [];
  for (const r of rows) {
    try {
      const parsed = JSON.parse(r.summary);
      if (Array.isArray(parsed)) {
        for (const q of parsed) {
          if (typeof q === "object" && q !== null) {
            const question = (q as Record<string, unknown>).question;
            if (typeof question === "string") out.push(question);
          }
        }
      }
    } catch {
      // ignore
    }
  }
  return out;
}
