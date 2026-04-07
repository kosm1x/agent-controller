/**
 * Evolution tools — read outcome aggregations + deactivate underperforming skills.
 *
 * Used exclusively by the nightly evolution ritual. Not exposed to regular tasks.
 */

import type { Tool } from "../types.js";
import {
  aggregateToolEffectiveness,
  aggregateRunnerPerformance,
} from "../../db/task-outcomes.js";
import { deactivateSkill, getUnderperformingSkills } from "../../db/skills.js";

// ---------------------------------------------------------------------------
// evolution_get_data
// ---------------------------------------------------------------------------

export const evolutionGetDataTool: Tool = {
  name: "evolution_get_data",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "evolution_get_data",
      description: `Get aggregated outcome data for skill evolution analysis.

Returns three datasets:
1. tool_effectiveness: Per-tool success rates grouped by task classification (last 7 days)
2. runner_performance: Daily success rate and avg latency (last 7 days)
3. underperforming_skills: Active skills with success rate below 40% on 5+ uses

USE WHEN: Running the nightly evolution ritual to analyze patterns.
DO NOT USE: During regular task execution.`,
      parameters: {
        type: "object",
        properties: {
          days: {
            type: "number",
            description: "Lookback window in days (default: 7)",
          },
        },
      },
    },
  },
  async execute(args) {
    const days = (args.days as number) ?? 7;
    const toolEffectiveness = aggregateToolEffectiveness(days);
    const runnerPerformance = aggregateRunnerPerformance(days);
    const underperformingSkills = getUnderperformingSkills(5, 0.4);

    return JSON.stringify({
      tool_effectiveness: toolEffectiveness,
      runner_performance: runnerPerformance,
      underperforming_skills: underperformingSkills.map((s) => ({
        skill_id: s.skill_id,
        name: s.name,
        use_count: s.use_count,
        success_count: s.success_count,
        success_rate:
          s.use_count > 0
            ? Math.round((s.success_count / s.use_count) * 100)
            : 0,
        description: s.description,
      })),
      meta: {
        lookback_days: days,
        total_outcomes: toolEffectiveness.reduce(
          (sum, t) => sum + t.total_uses,
          0,
        ),
      },
    });
  },
};

// ---------------------------------------------------------------------------
// evolution_deactivate_skill
// ---------------------------------------------------------------------------

export const evolutionDeactivateSkillTool: Tool = {
  name: "evolution_deactivate_skill",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "evolution_deactivate_skill",
      description: `Deactivate an underperforming skill so it is no longer injected into prompts.

The skill remains in the database (can be reactivated via skill_save) but will not
match in findSkillsByKeywords queries. Use only during evolution analysis for skills
with consistently low success rates (<30%) on 5+ uses.`,
      parameters: {
        type: "object",
        properties: {
          skill_id: {
            type: "string",
            description: "The skill_id UUID to deactivate",
          },
        },
        required: ["skill_id"],
      },
    },
  },
  async execute(args) {
    const skillId = args.skill_id as string;
    deactivateSkill(skillId);
    return JSON.stringify({ deactivated: true, skill_id: skillId });
  },
};
