/**
 * Self-defining cohort — Conway Pattern 2 substrate (v7.7 Spine 5).
 *
 * Conway's empirical claim (reference_conway_2005_sms.md §Pattern 2): a small
 * set of "self-defining" memories stays highly accessible because it grounds
 * the system's self-image and long-term goals. V8.1 briefings and V8.2
 * proposals read as generic LLM output without it.
 *
 * This module derives the cohort — the ranked subset of projects and
 * NorthStar objectives that constitute the operator's identity cohort — via a
 * DETERMINISTIC roll-up. No LLM, no inference: salience is a weighted score
 * over activity counts and recency. The roll-up is also the SOLE writer of
 * the `operator_profile` skeleton (the Q3 carve-out — schema only; V8.2 owns
 * the semantic layer).
 *
 * Spec authority: V7.7-GUIDE §"Spine 5" + V7.7-PREPLAN Q3.
 */

import { getDatabase, writeWithRetry } from "../db/index.js";

/** Cohort member kinds. `thread` is schema headroom — not populated in v7.7. */
export type CohortMemberKind = "project" | "objective" | "thread";

/** Conway's ≤30-entry ceiling — the active cohort is capped here. */
export const COHORT_MAX = 30;

/** Recency horizon (days) past which an objective's recency score hits 0. */
const RECENCY_HORIZON_DAYS = 90;
/** Activity window (days) for counting project_log entries. */
const ACTIVITY_WINDOW_DAYS = 30;

export interface CohortMember {
  id: number;
  member_id: string;
  member_kind: CohortMemberKind;
  label: string;
  source_ref: string;
  salience: number;
  signals: Record<string, unknown>;
  first_seen_at: string;
  last_rolled_at: string;
  active: boolean;
}

export interface OperatorProfileAttribute {
  cohort_member_id: string;
  attribute_key: string;
  attribute_value: string;
  written_at: string;
  written_by: string;
}

export interface RollUpResult {
  /** Total candidates scored this run. */
  candidates: number;
  /** Active members after the roll-up (≤ COHORT_MAX). */
  cohort_size: number;
  /** Rows left inactive after the roll-up. */
  inactive: number;
  /** Active-member counts bucketed by kind. */
  by_kind: Record<string, number>;
}

interface Candidate {
  member_id: string;
  member_kind: CohortMemberKind;
  label: string;
  source_ref: string;
  salience: number;
  signals: Record<string, unknown>;
}

interface CohortRow {
  id: number;
  member_id: string;
  member_kind: CohortMemberKind;
  label: string;
  source_ref: string;
  salience: number;
  signal_json: string;
  first_seen_at: string;
  last_rolled_at: string;
  active: number;
}

function rowToMember(row: CohortRow): CohortMember {
  let signals: Record<string, unknown>;
  try {
    const parsed = JSON.parse(row.signal_json) as unknown;
    signals =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
  } catch {
    signals = {};
  }
  return {
    id: row.id,
    member_id: row.member_id,
    member_kind: row.member_kind,
    label: row.label,
    source_ref: row.source_ref,
    salience: row.salience,
    signals,
    first_seen_at: row.first_seen_at,
    last_rolled_at: row.last_rolled_at,
    active: row.active === 1,
  };
}

/**
 * Score projects. Candidates are `active`/`paused` projects (archived and
 * completed projects are not part of the operator's *current* identity).
 * Salience = 0.3 base for being a live project + 0.7 × the project's share
 * of recent `project_log` activity, normalized against the busiest project.
 */
function scoreProjects(db: ReturnType<typeof getDatabase>): Candidate[] {
  const projects = db
    .prepare(
      `SELECT id, name, status FROM projects WHERE status IN ('active','paused')`,
    )
    .all() as Array<{ id: string; name: string; status: string }>;
  if (projects.length === 0) return [];

  const activityStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM project_log
       WHERE project_id = ?
         AND created_at >= datetime('now', ?)`,
  );
  const window = `-${ACTIVITY_WINDOW_DAYS} days`;
  const scored = projects.map((p) => {
    const { n } = activityStmt.get(p.id, window) as { n: number };
    return { project: p, activity: n };
  });
  const maxActivity = Math.max(1, ...scored.map((s) => s.activity));

  return scored.map(({ project, activity }) => ({
    member_id: `project:${project.id}`,
    member_kind: "project" as const,
    label: project.name,
    source_ref: project.id,
    salience: 0.3 + 0.7 * (activity / maxActivity),
    signals: { status: project.status, log_count_30d: activity },
  }));
}

/**
 * Score NorthStar objectives (`jarvis_files` under the `NorthStar/` prefix).
 * Salience = 0.5 × normalized `priority` + 0.5 × recency, where recency
 * decays linearly from 1 (updated today) to 0 (updated RECENCY_HORIZON_DAYS+
 * ago).
 */
function scoreObjectives(db: ReturnType<typeof getDatabase>): Candidate[] {
  const rows = db
    .prepare(
      `SELECT path, title, priority,
              CAST(julianday('now') - julianday(updated_at) AS REAL) AS age_days
         FROM jarvis_files
        WHERE path LIKE 'NorthStar/%'`,
    )
    .all() as Array<{
    path: string;
    title: string;
    priority: number | null;
    age_days: number | null;
  }>;

  return rows.map((r) => {
    const priority = Math.min(100, Math.max(0, r.priority ?? 50));
    const ageDays = r.age_days ?? RECENCY_HORIZON_DAYS;
    const recency = Math.min(
      1,
      Math.max(0, 1 - ageDays / RECENCY_HORIZON_DAYS),
    );
    return {
      member_id: `objective:${r.path}`,
      member_kind: "objective" as const,
      label: r.title,
      source_ref: r.path,
      salience: 0.5 * (priority / 100) + 0.5 * recency,
      signals: {
        priority,
        age_days: Math.round(ageDays),
      },
    };
  });
}

/**
 * Re-derive the self-defining cohort from current data, in one transaction:
 *
 *  1. Score all project + objective candidates (deterministic — no LLM).
 *  2. Rank by salience; the top `COHORT_MAX` become the active cohort.
 *  3. Upsert every candidate into `self_defining_cohort` (`first_seen_at`
 *     preserved across runs); mark any pre-existing row absent from the
 *     candidate set inactive.
 *  4. Upsert the factual `operator_profile` attributes for every candidate
 *     (`salience`, `member_kind`, `source_ref`) — written_by `cohort-rollup`.
 *
 * Idempotent: re-running with unchanged source data updates salience/
 * timestamps and is otherwise a no-op.
 */
export function rollUpCohort(): RollUpResult {
  const db = getDatabase();
  const candidates = [...scoreProjects(db), ...scoreObjectives(db)];
  // Sort by salience desc, with member_id as a stable tiebreaker so the
  // COHORT_MAX boundary cut is deterministic when two candidates tie
  // (R1-W3 fold — otherwise a tied member's in/out status depends on DB
  // row-return order).
  candidates.sort(
    (a, b) => b.salience - a.salience || a.member_id.localeCompare(b.member_id),
  );

  const activeIds = new Set(
    candidates.slice(0, COHORT_MAX).map((c) => c.member_id),
  );
  const allIds = candidates.map((c) => c.member_id);

  writeWithRetry(() => {
    const tx = db.transaction(() => {
      const upsertCohort = db.prepare(
        `INSERT INTO self_defining_cohort
           (member_id, member_kind, label, source_ref, salience, signal_json, active)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(member_id) DO UPDATE SET
           label          = excluded.label,
           source_ref     = excluded.source_ref,
           salience       = excluded.salience,
           signal_json    = excluded.signal_json,
           last_rolled_at = datetime('now'),
           active         = excluded.active`,
      );
      const upsertAttr = db.prepare(
        `INSERT INTO operator_profile
           (cohort_member_id, attribute_key, attribute_value, written_by)
         VALUES (?, ?, ?, 'cohort-rollup')
         ON CONFLICT(cohort_member_id, attribute_key) DO UPDATE SET
           attribute_value = excluded.attribute_value,
           written_at      = datetime('now')`,
      );

      for (const c of candidates) {
        upsertCohort.run(
          c.member_id,
          c.member_kind,
          c.label,
          c.source_ref,
          c.salience,
          JSON.stringify(c.signals),
          activeIds.has(c.member_id) ? 1 : 0,
        );
        // Factual attributes only — pure projections of the cohort row.
        // V8.2 adds semantic keys; the Q3 skeleton ships these to prove the
        // write path and nothing more.
        upsertAttr.run(c.member_id, "salience", c.salience.toFixed(4));
        upsertAttr.run(c.member_id, "member_kind", c.member_kind);
        upsertAttr.run(c.member_id, "source_ref", c.source_ref);
      }

      // Any cohort row not seen in this run's candidate set goes inactive
      // (e.g. a project that was archived since the last roll-up). Its
      // operator_profile attributes are deleted outright — otherwise a
      // dropped-out member's skeleton rows leak monotonically with no
      // cleanup path (R1-W2 fold). The self_defining_cohort row is kept
      // (active=0) so the member stays addressable.
      if (allIds.length > 0) {
        const placeholders = allIds.map(() => "?").join(",");
        db.prepare(
          `UPDATE self_defining_cohort SET active = 0, last_rolled_at = datetime('now')
             WHERE member_id NOT IN (${placeholders})`,
        ).run(...allIds);
        db.prepare(
          `DELETE FROM operator_profile
             WHERE cohort_member_id NOT IN (${placeholders})`,
        ).run(...allIds);
      } else {
        db.prepare(
          `UPDATE self_defining_cohort SET active = 0, last_rolled_at = datetime('now')`,
        ).run();
        db.prepare(`DELETE FROM operator_profile`).run();
      }
    });
    tx();
  });

  const byKind: Record<string, number> = {};
  for (const c of candidates) {
    if (activeIds.has(c.member_id)) {
      byKind[c.member_kind] = (byKind[c.member_kind] ?? 0) + 1;
    }
  }
  const inactive = Math.max(0, candidates.length - activeIds.size);
  return {
    candidates: candidates.length,
    cohort_size: activeIds.size,
    inactive,
    by_kind: byKind,
  };
}

export interface GetCohortOptions {
  kind?: CohortMemberKind;
  /** Include rows with `active = 0`. Default false. */
  includeInactive?: boolean;
}

/** List cohort members, most salient first. */
export function getCohort(options: GetCohortOptions = {}): CohortMember[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (!options.includeInactive) clauses.push("active = 1");
  if (options.kind) {
    clauses.push("member_kind = ?");
    params.push(options.kind);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = getDatabase()
    .prepare(
      `SELECT * FROM self_defining_cohort ${where} ORDER BY salience DESC`,
    )
    .all(...params) as CohortRow[];
  return rows.map(rowToMember);
}

/** Fetch one cohort member by its globally-unique `member_id`, or null. */
export function getCohortMember(memberId: string): CohortMember | null {
  const row = getDatabase()
    .prepare("SELECT * FROM self_defining_cohort WHERE member_id = ?")
    .get(memberId) as CohortRow | undefined;
  return row ? rowToMember(row) : null;
}

/** All `operator_profile` attributes for one cohort member. */
export function getOperatorProfile(
  cohortMemberId: string,
): OperatorProfileAttribute[] {
  return getDatabase()
    .prepare(
      `SELECT cohort_member_id, attribute_key, attribute_value, written_at, written_by
         FROM operator_profile WHERE cohort_member_id = ?
        ORDER BY attribute_key`,
    )
    .all(cohortMemberId) as OperatorProfileAttribute[];
}
