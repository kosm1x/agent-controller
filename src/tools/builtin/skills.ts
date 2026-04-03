/**
 * Skill tools — agent-accessible skill management (save + list).
 *
 * Skills are reusable multi-step procedures composed of existing tools.
 * They're stored in SQLite and injected as prompt context by the enrichment
 * service — the LLM reads them as guidance, not as callable functions.
 *
 * These two tools let the LLM CREATE and BROWSE skills.
 */

import type { Tool } from "../types.js";
import { saveSkill, listSkills, type SkillRow } from "../../db/skills.js";
import { getMemoryService } from "../../memory/index.js";

// ---------------------------------------------------------------------------
// skill_save
// ---------------------------------------------------------------------------

export const skillSaveTool: Tool = {
  name: "skill_save",
  definition: {
    type: "function",
    function: {
      name: "skill_save",
      description: `Save a reusable multi-step procedure as a named skill.

USE WHEN:
- The user says "save this as a skill" or "remember how to do this"
- You just completed a complex multi-step sequence (3+ tools) worth remembering
- You want to formalize a recurring workflow the user asks for repeatedly

DO NOT USE WHEN:
- The task was a one-off question or single-tool action
- The procedure is trivial (1-2 steps)
- A skill with the same name already exists and doesn't need updating

WHAT HAPPENS:
- The skill is saved to the database
- Next time a similar request comes in, the skill will be injected into your prompt as a "known procedure"
- You'll see it under "Procedimientos conocidos" in your context`,
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              "Short, descriptive name for the skill (e.g., 'weekly_review', 'project_status'). Use snake_case.",
          },
          description: {
            type: "string",
            description:
              "What this skill does in one sentence (e.g., 'Review all active goals and reprioritize tasks for the week').",
          },
          trigger: {
            type: "string",
            description:
              "When to use this skill — natural language description of the user request that should activate it (e.g., 'when the user asks for a weekly review or revisión semanal').",
          },
          steps: {
            type: "array",
            items: { type: "string" },
            description:
              "Ordered list of step descriptions (e.g., ['List all active goals with list_goals', 'Check overdue tasks with list_tasks', 'Write journal summary']).",
          },
          tools: {
            type: "array",
            items: { type: "string" },
            description:
              "Tool names used in this skill (e.g., ['jarvis_file_read', 'web_search', 'gmail_send']).",
          },
        },
        required: ["name", "description", "trigger", "steps", "tools"],
      },
    },
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const name = args.name as string;
    const description = args.description as string;
    const trigger = args.trigger as string;
    const steps = args.steps as string[];
    const tools = args.tools as string[];

    try {
      const skillId = saveSkill({
        name,
        description,
        trigger,
        steps,
        tools,
        source: "manual",
      });

      // Also retain in Hindsight for semantic matching
      try {
        const memory = getMemoryService();
        if (memory.backend === "hindsight") {
          await memory.retain(
            `Skill "${name}": ${description}. Trigger: ${trigger}. Steps: ${steps.join(", ")}. Tools: ${tools.join(", ")}.`,
            {
              bank: "mc-operational",
              tags: ["skill", name],
              async: true,
            },
          );
        }
      } catch {
        // Hindsight retain is best-effort
      }

      return JSON.stringify({
        saved: true,
        skill_id: skillId,
        name,
        description,
        steps_count: steps.length,
        tools_count: tools.length,
      });
    } catch (err) {
      return JSON.stringify({
        error: `Failed to save skill: ${err instanceof Error ? err.message : err}`,
      });
    }
  },
};

// ---------------------------------------------------------------------------
// skill_list
// ---------------------------------------------------------------------------

export const skillListTool: Tool = {
  name: "skill_list",
  definition: {
    type: "function",
    function: {
      name: "skill_list",
      description: `Browse saved skills (reusable procedures).

USE WHEN:
- The user asks "what can you do?" or "what skills do you have?"
- Before starting a complex task, to check if a matching skill exists
- When the user references a skill by name

Returns a list of saved skills with their names, descriptions, usage stats, and success rates.`,
      parameters: {
        type: "object",
        properties: {
          include_inactive: {
            type: "boolean",
            description: "Include retired/inactive skills (default: false).",
          },
        },
      },
    },
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    try {
      const includeInactive = args.include_inactive === true;
      const skills = includeInactive
        ? listSkills()
        : listSkills({ active: true });

      if (skills.length === 0) {
        return JSON.stringify({
          skills: [],
          message:
            "No skills saved yet. Use skill_save after completing a multi-step procedure to save it for reuse.",
        });
      }

      const formatted = skills.map((s: SkillRow) => {
        const successRate =
          s.use_count > 0
            ? Math.round((s.success_count / s.use_count) * 100)
            : 100;
        return {
          name: s.name,
          description: s.description,
          trigger: s.trigger_text,
          steps: JSON.parse(s.steps),
          tools: JSON.parse(s.tools),
          use_count: s.use_count,
          success_rate: `${successRate}%`,
          source: s.source,
          active: s.active === 1,
        };
      });

      return JSON.stringify({ skills: formatted, total: formatted.length });
    } catch (err) {
      return JSON.stringify({
        error: `Failed to list skills: ${err instanceof Error ? err.message : err}`,
      });
    }
  },
};
