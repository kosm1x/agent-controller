/**
 * v7.11 teaching module — TS types for learning_plans, learning_plan_units,
 * learner_model, learning_sessions. Plain interfaces (no zod) — validation
 * happens at tool argument boundaries.
 */

export type PlanStatus = "active" | "paused" | "completed" | "archived";
export type UnitStatus =
  | "locked"
  | "ready"
  | "in_progress"
  | "mastered"
  | "skipped";
export type SessionKind = "teach" | "quiz" | "explain_back" | "review";

export interface LearningPlanRow {
  plan_id: string;
  topic: string;
  created_at: number;
  updated_at: number;
  status: PlanStatus;
  current_unit: number;
  notes: string | null;
}

export interface LearningPlanUnitRow {
  plan_id: string;
  unit_index: number;
  title: string;
  summary: string;
  predicted_difficulties: string[];
  prerequisites: number[];
  status: UnitStatus;
  mastery_score: number;
}

export interface LearnerConceptRow {
  concept: string;
  first_seen: number;
  last_seen: number;
  confidence: number;
  mastery_score: number;
  evidence_quotes: Array<{ quote: string; session_id: string; ts: number }>;
  ef: number;
  interval_days: number;
  repetitions: number;
  review_due_date: number | null;
}

export interface LearningSessionRow {
  session_id: string;
  plan_id: string;
  unit_index: number;
  kind: SessionKind;
  started_at: number;
  ended_at: number | null;
  mastery_delta: number | null;
  transcript_ref: string | null;
  summary: string | null;
}

export interface DecompositionUnit {
  title: string;
  summary: string;
  predicted_difficulties: string[];
  prerequisites: number[];
}

export interface QuizQuestion {
  question: string;
  expected_answer: string;
  difficulty: "easy" | "medium" | "hard";
}

export interface ConceptMasteryUpdate {
  concept: string;
  evidence_quote: string;
  mastery_estimate: number;
}

/** SM-2 output. */
export interface Sm2State {
  ef: number;
  interval_days: number;
  repetitions: number;
  review_due_date: number;
}

export const MASTERY_ADVANCE_THRESHOLD = 0.7;
export const MASTERY_DISPLAY_CEIL = 1;
export const EF_FLOOR = 1.3;
export const DEFAULT_EF = 2.5;
