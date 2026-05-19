/**
 * v7.7 Spine 3 Phase 4 Bundle 2 — `skill_describe` (L1 disclosure).
 *
 * Spec §7: returns the L1 metadata for a skill — name, description,
 * version, inputs declaration, output_type, certification status. Does
 * NOT load the body (that's `skill_load`). Read-only.
 *
 * Deferred per spec §11 (`feedback_tool_deferral.md`): the full
 * parameter schema isn't loaded into the LLM context until the model
 * decides to call it.
 */

import type { Tool } from "../types.js";
import { getDatabase } from "../../db/index.js";
import { getSkill } from "../../db/skills.js";

interface SkillDescribeArgs {
  name?: string;
}

interface SkillDescribePayload {
  name: string;
  description: string;
  version: string;
  inputs: unknown;
  output_type: string;
  is_certified: boolean;
  active: boolean;
  use_count: number;
  success_count: number;
  consecutive_failures: number;
  last_test_run_at: string | null;
  last_used: string | null;
}

export const skillDescribeTool: Tool = {
  name: "skill_describe",
  deferred: true,
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
  definition: {
    type: "function",
    function: {
      name: "skill_describe",
      description: `Return the L1 metadata for a named skill — name, description, version, inputs declaration, output type, and certification status.

USE WHEN:
- You want to know what a specific skill does before invoking it
- You need to know what arguments a skill requires (its inputs declaration)
- You want to check whether a skill is certified + active

DO NOT USE WHEN:
- You want the skill body / instructions — use skill_load instead
- You want to LIST what skills exist — use skill_list instead
- You want to RUN a skill — use skill_run instead

WHAT IT RETURNS:
JSON envelope { ok, skill | reason }. On found: full L1 metadata. On not found: { ok: false, reason: "skill_not_found" }.`,
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              "Skill name as declared in frontmatter (e.g., 'send_follow_up'). Case-sensitive.",
          },
        },
        required: ["name"],
      },
    },
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const { name } = args as SkillDescribeArgs;
    if (typeof name !== "string" || name.length === 0) {
      return JSON.stringify({
        ok: false,
        reason: "name argument is required and must be a non-empty string",
      });
    }

    const skill = getSkill(name);
    if (!skill) {
      return JSON.stringify({ ok: false, reason: "skill_not_found", name });
    }

    // Phase 1 schema added these columns; older legacy rows may have
    // NULL/0 defaults. Surface them honestly so the LLM can decide.
    // W4 audit fold: folded inputs_json into the same SELECT as the
    // extras so describe issues 2 queries (getSkill + this) instead of 3.
    const db = getDatabase();
    const extras = db
      .prepare(
        `SELECT
           is_certified, active, version, output_type, inputs_json,
           consecutive_failures, last_failure_at, last_used,
           (SELECT MAX(ran_at) FROM skill_test_runs WHERE skill_id = ?) AS last_test_run_at
         FROM skills WHERE skill_id = ?`,
      )
      .get(skill.skill_id, skill.skill_id) as
      | {
          is_certified: number;
          active: number;
          version: string | null;
          output_type: string | null;
          inputs_json: string | null;
          consecutive_failures: number;
          last_failure_at: string | null;
          last_used: string | null;
          last_test_run_at: string | null;
        }
      | undefined;

    // Parse inputs_json — already validated at write time by Phase 1's
    // parser, so JSON.parse is safe. Fall back to [] on parse failure
    // (legacy rows / corrupt data).
    let inputs: unknown = [];
    try {
      inputs = JSON.parse(extras?.inputs_json || "[]");
    } catch {
      inputs = [];
    }

    const payload: SkillDescribePayload = {
      name: skill.name,
      description: skill.description,
      version: extras?.version ?? "1.0.0",
      inputs,
      output_type: extras?.output_type ?? "text",
      is_certified: (extras?.is_certified ?? 0) === 1,
      active: (extras?.active ?? skill.active) === 1,
      use_count: skill.use_count,
      success_count: skill.success_count,
      consecutive_failures: extras?.consecutive_failures ?? 0,
      last_test_run_at: extras?.last_test_run_at ?? null,
      last_used: extras?.last_used ?? null,
    };
    return JSON.stringify({ ok: true, skill: payload });
  },
};
