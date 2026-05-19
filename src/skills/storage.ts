/**
 * v7.7 Spine 3 — shared skill storage helpers.
 *
 * Both the boot loader (`src/skills/loader.ts`, Phase 1) and the
 * skill-save lifecycle (`src/skills/lifecycle.ts`, Phase 2) need:
 *   - `ensureSkillRow(fm, bodyPath)` — find-or-create the parent `skills`
 *     row by frontmatter `name`. Returns the skill_id.
 *   - `recordVersion(...)` — INSERT a row into `skill_versions` keyed
 *     UNIQUE on (skill_id, version), returning 'inserted'/'unchanged'/'drift'.
 *   - `pointSkillAtVersion(...)` — UPDATE the parent `skills` row to
 *     point at the new version + refresh metadata fields.
 *
 * Phase 1 had these inlined in loader.ts; Phase 2 extracts them so the
 * lifecycle doesn't duplicate. Behavior is bit-identical to the Phase 1
 * implementations.
 *
 * SELECT-then-INSERT race: single-process boot is the invariant. Two
 * concurrent writers hit the UNIQUE constraint on `skills.name` (or
 * `skill_versions.(skill_id, version)`); the second writer throws and
 * surfaces as the caller's `LoaderError`/`SaveError`.
 */

import { createHash, randomUUID } from "crypto";
import { getDatabase } from "../db/index.js";
import type { ParsedSkill } from "./frontmatter.js";

/**
 * `created_by` enum — must match the CHECK constraint on
 * `skill_versions.created_by` in src/db/index.ts. Operator-override is
 * NOT a distinct created_by value; per Phase 2 design, override rows
 * stay under the caller's createdBy (default 'operator') and the
 * override signal is carried via `critic_verdict='fail_returned_anyway'`
 * — the only way that verdict ever lands. Queue item S5-P2-I1 tracks
 * adding 'operator-override' to the CHECK at the v8.0 schema reset.
 */
export type CreatedBy =
  | "operator"
  | "discovery"
  | "refiner"
  | "critic-revised"
  | "boot-scan";

export type CriticVerdictColumn = "pass" | "fail_returned_anyway" | "skipped";

export interface RecordVersionInput {
  skillId: string;
  fm: ParsedSkill;
  body: string;
  createdBy: CreatedBy;
  criticVerdict: CriticVerdictColumn;
  criticCritique: string | null;
}

export type RecordVersionOutcome =
  | { kind: "inserted"; versionId: number }
  | { kind: "unchanged" }
  | { kind: "drift"; existingSha: string };

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * Find or create a `skills` row for the given frontmatter name. Returns
 * the skill_id (existing or freshly minted). Idempotent: re-running with
 * the same name returns the existing row's skill_id, no mutation.
 *
 * `bodyPath` is recorded only on initial insert. Subsequent calls with a
 * different bodyPath do NOT update — body_path is a one-time stamp.
 */
export function ensureSkillRow(
  fm: ParsedSkill,
  bodyPath: string | null,
): string {
  const db = getDatabase();
  const existing = db
    .prepare("SELECT skill_id FROM skills WHERE name = ?")
    .get(fm.name) as { skill_id: string } | undefined;

  if (existing) return existing.skill_id;

  const skillId = randomUUID();
  const firstTrigger = fm.trigger_examples[0] ?? "";
  db.prepare(
    `INSERT INTO skills (
       skill_id, name, description, trigger_text, steps, tools, source,
       version, inputs_json, output_type, trigger_examples_json,
       tests_json, body_path
     ) VALUES (?, ?, ?, ?, '[]', '[]', 'manual', ?, ?, ?, ?, ?, ?)`,
  ).run(
    skillId,
    fm.name,
    fm.description,
    firstTrigger,
    fm.version,
    fm.inputs_json,
    fm.output_type,
    JSON.stringify(fm.trigger_examples),
    fm.tests_json,
    bodyPath,
  );
  return skillId;
}

/**
 * Insert a row into skill_versions for this content.
 *
 *   - 'inserted' on a new (skill_id, version) pair
 *   - 'unchanged' when an existing row matches sha256 byte-for-byte
 *   - 'drift' when (skill_id, version) exists with a different body_sha256
 *
 * Drift is reported to the caller — Phase 1 loader logs warning and skips;
 * Phase 2 lifecycle returns rejection ("bump version to register new body").
 */
export function recordVersion(input: RecordVersionInput): RecordVersionOutcome {
  const db = getDatabase();
  const bodySha = sha256(input.body);

  const existing = db
    .prepare(
      "SELECT id, body_sha256 FROM skill_versions WHERE skill_id = ? AND version = ?",
    )
    .get(input.skillId, input.fm.version) as
    | { id: number; body_sha256: string }
    | undefined;

  if (existing) {
    if (existing.body_sha256 === bodySha) return { kind: "unchanged" };
    return { kind: "drift", existingSha: existing.body_sha256 };
  }

  const result = db
    .prepare(
      `INSERT INTO skill_versions (
         skill_id, version, body, body_sha256, inputs_json, tests_json,
         tools_used_json, created_by, critic_verdict, critic_critique
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.skillId,
      input.fm.version,
      input.body,
      bodySha,
      input.fm.inputs_json,
      input.fm.tests_json,
      JSON.stringify(input.fm.tools_used),
      input.createdBy,
      input.criticVerdict,
      input.criticCritique,
    );
  return { kind: "inserted", versionId: Number(result.lastInsertRowid) };
}

/**
 * Update the parent `skills` row to point at the new version_id and
 * refresh the metadata fields the loader/lifecycle source from
 * frontmatter. Only called when recordVersion() returns 'inserted'.
 *
 * NOT touched here: `is_certified`. The test harness (Phase 2 Bundle 2)
 * owns that flip after a green test run.
 */
export function pointSkillAtVersion(
  skillId: string,
  fm: ParsedSkill,
  versionId: number,
): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE skills SET
       description = ?,
       version = ?,
       inputs_json = ?,
       output_type = ?,
       trigger_examples_json = ?,
       tests_json = ?,
       current_version_id = ?,
       updated_at = datetime('now')
     WHERE skill_id = ?`,
  ).run(
    fm.description,
    fm.version,
    fm.inputs_json,
    fm.output_type,
    JSON.stringify(fm.trigger_examples),
    fm.tests_json,
    versionId,
    skillId,
  );
}
