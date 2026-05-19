/**
 * v7.7 Spine 3 Phase 4 Bundle 2 — `skill_run` builtin tool.
 *
 * Thin wrapper over `runSkill` from `src/skills/dispatcher.ts`. Validates
 * the args envelope (name + args), forwards to the dispatcher, and
 * renders a uniform JSON envelope back to the LLM.
 *
 * Per spec §11 Mode 2, this tool is `deferred: true` — the
 * (name, args, output_type) signature stays out of the LLM context
 * until the model decides to invoke it. The L1 description of each
 * specific skill surfaces via the existing enrichment context block;
 * the model uses that catalog to choose, then this single dispatcher
 * tool actually executes.
 *
 * Annotations:
 *  - destructiveHint=true + openWorldHint=true: skills CAN call any
 *    tool (including destructive ones — email, post, etc.). The
 *    operator-facing risk is dynamic per skill, but at the tool layer
 *    we mark it conservatively per ACI defaults.
 *  - readOnlyHint=false: skills mutate skills row + skill_failures +
 *    cost_ledger at minimum.
 */

import type { Tool } from "../types.js";
import { runSkill } from "../../skills/dispatcher.js";

interface SkillRunArgs {
  name?: string;
  args?: Record<string, unknown>;
  options?: {
    dryRun?: boolean;
    /**
     * Operator-only path: bypass cycle check (not exposed in tool
     * description because Phase 4 doesn't ship body-side recursion).
     * Reserved.
     */
    _callStack?: string[];
  };
}

export const skillRunTool: Tool = {
  name: "skill_run",
  deferred: true,
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
  riskTier: "medium",
  definition: {
    type: "function",
    function: {
      name: "skill_run",
      description: `Invoke a saved skill by name. Validates args against the skill's inputs declaration, runs the skill body via the mini-runner harness, and updates anti-list + cost ledger accounting.

USE WHEN:
- You want to execute a procedure that's been distilled into a skill — saves you from re-deriving the steps
- The skill is active, and your args match its inputs declaration EXACTLY (see below)
- You've checked the skill with skill_describe to inspect its inputs[] declaration

DO NOT USE WHEN:
- You only need to read the skill's instructions — use skill_load
- The skill is anti-listed (consecutive_failures ≥ 3) — fix the underlying issue first
- You're unsure what args the skill needs — call skill_describe first

ARGS DISCIPLINE (load-bearing):
- The dispatcher validates args STRICTLY against the skill's inputs declaration — unknown keys are rejected
- For a skill with inputs: [] (no declared inputs), pass args: {} — anything else returns input_validation
- Always call skill_describe first to see the exact inputs[] shape before invoking

WHAT IT RETURNS:
JSON envelope { ok, output | errorClass, errorDetail, durationMs }. On success: { ok: true, output: <skill's structured response> }. On failure: { ok: false, errorClass: <one of skill_not_found | skill_inactive | no_active_version | skill_corrupt | input_validation | cycle_detected | wrong_output | timeout | other>, errorDetail: <short reason> }.

SAFETY:
- Calling this tool counts toward the skill's anti-list (consecutive_failures). 3 strikes hides the skill from retrieval; the dispatcher still allows direct calls.
- A skill body can return { error: "<class>", detail: "<reason>" } to gracefully reject input — this is still classified wrong_output and counts against the skill.`,
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              "Skill name (case-sensitive) as declared in the skill's frontmatter.",
          },
          args: {
            type: "object",
            description:
              "JSON object matching the skill's inputs declaration. Use skill_describe first if unsure.",
            additionalProperties: true,
          },
          options: {
            type: "object",
            description:
              "Optional execution overrides. dryRun=true runs the LLM but does NOT mutate skills_row / skill_failures (cost_ledger still records). Use sparingly.",
            properties: {
              dryRun: {
                type: "boolean",
                description:
                  "If true, suppress all skills_row / skill_failures mutations. Cost ledger STILL records (the LLM ran).",
              },
            },
          },
        },
        required: ["name", "args"],
      },
    },
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const { name, args: skillArgs, options } = args as SkillRunArgs;
    if (typeof name !== "string" || name.length === 0) {
      return JSON.stringify({
        ok: false,
        errorClass: "input_validation",
        errorDetail: "name argument is required",
      });
    }
    if (
      skillArgs === undefined ||
      skillArgs === null ||
      typeof skillArgs !== "object" ||
      Array.isArray(skillArgs)
    ) {
      return JSON.stringify({
        ok: false,
        errorClass: "input_validation",
        errorDetail: "args must be a JSON object",
      });
    }

    const result = await runSkill(name, skillArgs, {
      dryRun: options?.dryRun,
    });

    if (result.ok) {
      return JSON.stringify({
        ok: true,
        skillName: result.skillName,
        versionId: result.versionId,
        output: result.output,
        durationMs: result.durationMs,
      });
    }
    return JSON.stringify({
      ok: false,
      skillName: result.skillName,
      errorClass: result.errorClass,
      errorDetail: result.errorDetail,
      durationMs: result.durationMs,
    });
  },
};
