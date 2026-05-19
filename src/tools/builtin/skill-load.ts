/**
 * v7.7 Spine 3 Phase 4 Bundle 2 — `skill_load` (L2 disclosure).
 *
 * Spec §7: returns the L2 view of a skill — L1 metadata PLUS the body
 * (instructions / steps), tools_used, and trigger_examples. Does NOT
 * execute the skill (that's `skill_run`).
 *
 * Useful when the LLM is deciding HOW to invoke a skill, or when it
 * wants to inspect the steps for ad-hoc planning instead of calling
 * `skill_run` directly.
 *
 * Deferred per spec §11.
 */

import type { Tool } from "../types.js";
import { getDatabase } from "../../db/index.js";
import { getSkill } from "../../db/skills.js";

interface SkillLoadArgs {
  name?: string;
  version?: string;
}

interface SkillLoadPayload {
  name: string;
  description: string;
  version: string;
  inputs: unknown;
  output_type: string;
  trigger_examples: unknown;
  tools_used: unknown;
  body: string;
  /**
   * is_certified ALWAYS reflects the parent skills row (the latest /
   * pointed-at version), NOT the loaded version. When an explicit
   * version is requested AND that version is NOT the current one,
   * version_is_current=false signals that the cert flag's scope
   * doesn't apply to the loaded body.
   * (C2 audit fold)
   */
  is_certified: boolean;
  version_is_current: boolean;
}

export const skillLoadTool: Tool = {
  name: "skill_load",
  deferred: true,
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
  definition: {
    type: "function",
    function: {
      name: "skill_load",
      description: `Return the full L2 view of a skill — metadata + body + tools_used + trigger_examples.

USE WHEN:
- You want to read a skill's instructions before deciding whether to invoke it
- You need to see what tools a skill depends on
- You're authoring a similar skill and want to study an existing pattern

DO NOT USE WHEN:
- You only need name/description/inputs — use skill_describe (smaller payload)
- You want to RUN the skill — use skill_run instead

WHAT IT RETURNS:
JSON envelope { ok, skill | reason }. On found: full L2 metadata + body markdown. On not found: { ok: false, reason: "skill_not_found" }. When the requested version doesn't exist, returns { ok: false, reason: "version_not_found" }.`,
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Skill name (case-sensitive).",
          },
          version: {
            type: "string",
            description:
              "Optional semver to load a specific version. Defaults to current_version_id pointer (the active version).",
          },
        },
        required: ["name"],
      },
    },
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const { name, version } = args as SkillLoadArgs;
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

    const db = getDatabase();

    // Pick the version row: explicit `version` argument OR
    // current_version_id pointer. If neither resolves, surface clearly.
    let versionRow:
      | {
          id: number;
          version: string;
          body: string;
          inputs_json: string;
          tests_json: string;
          tools_used_json: string;
          critic_verdict: string;
        }
      | undefined;

    if (version) {
      versionRow = db
        .prepare(
          `SELECT id, version, body, inputs_json, tests_json,
                  tools_used_json, critic_verdict
           FROM skill_versions
           WHERE skill_id = ? AND version = ?`,
        )
        .get(skill.skill_id, version) as typeof versionRow;
      if (!versionRow) {
        return JSON.stringify({
          ok: false,
          reason: "version_not_found",
          name,
          version,
        });
      }
    } else {
      const ptr = db
        .prepare(
          "SELECT current_version_id, version, output_type, trigger_examples_json FROM skills WHERE skill_id = ?",
        )
        .get(skill.skill_id) as
        | {
            current_version_id: number | null;
            version: string;
            output_type: string;
            trigger_examples_json: string;
          }
        | undefined;
      if (!ptr?.current_version_id) {
        return JSON.stringify({
          ok: false,
          reason: "no_active_version",
          name,
          hint: "skill exists but has no current_version_id; never went through skill_save",
        });
      }
      versionRow = db
        .prepare(
          `SELECT id, version, body, inputs_json, tests_json,
                  tools_used_json, critic_verdict
           FROM skill_versions
           WHERE id = ?`,
        )
        .get(ptr.current_version_id) as typeof versionRow;
      if (!versionRow) {
        return JSON.stringify({
          ok: false,
          reason: "version_pointer_dangling",
          name,
          currentVersionId: ptr.current_version_id,
        });
      }
    }

    const sk = db
      .prepare(
        `SELECT is_certified, output_type, trigger_examples_json, current_version_id
         FROM skills WHERE skill_id = ?`,
      )
      .get(skill.skill_id) as {
      is_certified: number;
      output_type: string | null;
      trigger_examples_json: string | null;
      current_version_id: number | null;
    };

    const payload: SkillLoadPayload = {
      name: skill.name,
      description: skill.description,
      version: versionRow.version,
      inputs: safeParse(versionRow.inputs_json, []),
      output_type: sk.output_type ?? "text",
      trigger_examples: safeParse(sk.trigger_examples_json ?? "[]", []),
      tools_used: safeParse(versionRow.tools_used_json ?? "[]", []),
      body: versionRow.body,
      is_certified: sk.is_certified === 1,
      // C2 audit fold: when an explicit version is loaded and that
      // version is NOT current_version_id, the is_certified flag's
      // scope (parent skills row) doesn't apply to this body.
      version_is_current: sk.current_version_id === versionRow.id,
    };
    return JSON.stringify({ ok: true, skill: payload });
  },
};

function safeParse<T>(s: string, fallback: T): T {
  // W3 audit fold: declared return is `T`, with the implicit contract
  // that callers tolerate any JSON shape that JSON.parse accepts. The
  // fallback is the type-safe escape; parsed values are typed `T` by
  // declaration because the call sites already accept `unknown` (JSON
  // arrays of mixed-shape objects).
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
