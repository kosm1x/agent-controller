/**
 * Skills CRUD — SQLite storage for reusable multi-step procedures.
 *
 * Skills are saved recipes that guide the LLM when it encounters
 * a familiar request. They're injected as prompt context by the
 * enrichment service, not as callable tools.
 */

import { randomUUID } from "crypto";
import { getDatabase } from "./index.js";

export interface SkillInput {
  name: string;
  description: string;
  trigger: string;
  steps: string[];
  tools: string[];
  source?: "manual" | "discovered" | "refined";
}

export interface SkillRow {
  id: number;
  skill_id: string;
  name: string;
  description: string;
  trigger_text: string;
  steps: string;
  tools: string;
  use_count: number;
  success_count: number;
  source: string;
  active: number;
  created_at: string;
  updated_at: string;
}

/** Save or update a skill. Returns the skill_id. */
export function saveSkill(input: SkillInput): string {
  const db = getDatabase();
  const skillId = randomUUID();

  db.prepare(
    `INSERT INTO skills (skill_id, name, description, trigger_text, steps, tools, source)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       description = excluded.description,
       trigger_text = excluded.trigger_text,
       steps = excluded.steps,
       tools = excluded.tools,
       source = excluded.source,
       updated_at = datetime('now')`,
  ).run(
    skillId,
    input.name,
    input.description,
    input.trigger,
    JSON.stringify(input.steps),
    JSON.stringify(input.tools),
    input.source ?? "manual",
  );

  // Return the actual skill_id (may be the existing one on conflict)
  const row = db
    .prepare("SELECT skill_id FROM skills WHERE name = ?")
    .get(input.name) as { skill_id: string } | undefined;
  return row?.skill_id ?? skillId;
}

/** Get a skill by name or skill_id. */
export function getSkill(nameOrId: string): SkillRow | null {
  const db = getDatabase();
  return (
    (db
      .prepare("SELECT * FROM skills WHERE name = ? OR skill_id = ?")
      .get(nameOrId, nameOrId) as SkillRow) ?? null
  );
}

/** List skills with optional filters. */
export function listSkills(filter?: { active?: boolean }): SkillRow[] {
  const db = getDatabase();
  if (filter?.active !== undefined) {
    return db
      .prepare("SELECT * FROM skills WHERE active = ? ORDER BY use_count DESC")
      .all(filter.active ? 1 : 0) as SkillRow[];
  }
  return db
    .prepare("SELECT * FROM skills ORDER BY use_count DESC")
    .all() as SkillRow[];
}

/** Increment use_count and optionally success_count. */
export function incrementSkillUsage(skillId: string, success: boolean): void {
  const db = getDatabase();
  if (success) {
    db.prepare(
      "UPDATE skills SET use_count = use_count + 1, success_count = success_count + 1, last_used = datetime('now'), updated_at = datetime('now') WHERE skill_id = ?",
    ).run(skillId);
  } else {
    db.prepare(
      "UPDATE skills SET use_count = use_count + 1, updated_at = datetime('now') WHERE skill_id = ?",
    ).run(skillId);
  }
}

/** Find skills whose trigger_text or name match keywords in the input text. */
export function findSkillsByKeywords(text: string): SkillRow[] {
  const db = getDatabase();
  const words = text
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 3);

  if (words.length === 0) return [];

  // Match skills where any keyword appears in trigger_text or name
  const conditions = words.map(
    () => "(LOWER(trigger_text) LIKE ? OR LOWER(name) LIKE ?)",
  );
  const params = words.flatMap((w) => [`%${w}%`, `%${w}%`]);

  return db
    .prepare(
      `SELECT * FROM skills WHERE active = 1 AND (${conditions.join(" OR ")}) ORDER BY use_count DESC LIMIT 3`,
    )
    .all(...params) as SkillRow[];
}
