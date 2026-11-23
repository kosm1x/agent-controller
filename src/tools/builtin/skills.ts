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
import { unversionedSkillNote } from "../../skills/kb-file.js";

// ---------------------------------------------------------------------------
// skill_save
// ---------------------------------------------------------------------------

export const skillSaveTool: Tool = {
  name: "skill_save",
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
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
- When a later request matches it, the skill may be injected into your prompt as a "known procedure" (active skills only, at most three per request)
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
              "Ordered list of step descriptions (e.g., ['Read the project notes with jarvis_file_read', 'Search for recent news with web_search', 'Write journal summary']).",
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
        versioned: false,
        note: unversionedSkillNote(name),
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

/**
 * Size budget for skill_list's result text; only a list whose first row,
 * with the result's other fields, does not fit comes back longer. It sits
 * below the size at which the tool loop spills a result to a file and cuts
 * it (MAX_TOOL_RESULT_CHARS, 12,000 by default).
 */
const SKILL_LIST_MAX_CHARS = 8_000;

export const skillListTool: Tool = {
  name: "skill_list",
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
  definition: {
    type: "function",
    function: {
      name: "skill_list",
      description: `Browse saved skills (reusable procedures).

USE WHEN:
- The user asks "what can you do?" or "what skills do you have?"
- Before starting a complex task, to check if a matching skill exists
- When the user references a skill by name

DO NOT USE WHEN:
- You need a versioned skill's inputs declaration, version or certification status — use skill_describe
- You need the steps of a saved procedure or the instructions of a versioned skill — use skill_load (its result says which kind the skill is)
- You want to run a versioned skill — use skill_run when it is among your tools, otherwise follow the instructions skill_load returns (a saved procedure cannot be run: follow the steps skill_load returns)
- You want to save a procedure — use skill_save

WHAT IT RETURNS:
Saved skills, most used first, each with its name, description, use count, success rate, source and whether it is active. A long list shows only the first skills and says how many of how many are shown; the query parameter narrows the list.`,
      parameters: {
        type: "object",
        properties: {
          include_inactive: {
            type: "boolean",
            description: "Include retired/inactive skills (default: false).",
          },
          query: {
            type: "string",
            description:
              "Optional. Lists only skills whose name, description or trigger contains this text (case-insensitive, taken literally, blanks at both ends ignored). Empty or omitted: no filter.",
          },
        },
      },
    },
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    try {
      const includeInactive = args.include_inactive === true;
      const query = typeof args.query === "string" ? args.query.trim() : "";
      const stored = listSkills();

      if (stored.length === 0) {
        return JSON.stringify({
          skills: [],
          message:
            "No skills saved yet. Use skill_save after completing a multi-step procedure to save it for reuse.",
        });
      }

      const listed = includeInactive
        ? stored
        : stored.filter((s) => s.active === 1);
      if (listed.length === 0) {
        return JSON.stringify({
          skills: [],
          message: `No active skills. Stored inactive skills: ${stored.length}; set include_inactive to true to list them.`,
        });
      }

      const needle = query.toLowerCase();
      const matching = needle
        ? listed.filter((s) =>
            [s.name, s.description, s.trigger_text].some((text) =>
              text.toLowerCase().includes(needle),
            ),
          )
        : listed;
      if (matching.length === 0) {
        return JSON.stringify({
          skills: [],
          message: includeInactive
            ? "No skill matches this query."
            : "No active skill matches this query.",
        });
      }

      // Most used first, then by name, so a cut list is the same on every call.
      const formatted = [...matching]
        .sort(
          (a, b) =>
            b.use_count - a.use_count ||
            (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
        )
        .map((s: SkillRow) => {
          const successRate =
            s.use_count > 0
              ? Math.round((s.success_count / s.use_count) * 100)
              : 100;
          return {
            name: s.name,
            description: s.description,
            use_count: s.use_count,
            success_rate: `${successRate}%`,
            source: s.source,
            active: s.active === 1,
          };
        });

      const total = formatted.length;
      const whole = JSON.stringify({ skills: formatted, total });
      if (whole.length <= SKILL_LIST_MAX_CHARS || total === 1) return whole;

      // Too long: the most used rows that fit, the first one always, and a
      // note saying how many are shown.
      const cut = (shown: number): string =>
        JSON.stringify({
          skills: formatted.slice(0, shown),
          total,
          shown,
          note: query
            ? `${shown} of ${total} skills that contain "${query}" are shown, most used first; a narrower query lists fewer.`
            : `${shown} of ${total} skills are shown, most used first; the query parameter narrows the list to skills whose name, description or trigger contains it.`,
        });
      let result = cut(1);
      for (let shown = 2; shown < total; shown++) {
        const next = cut(shown);
        if (next.length > SKILL_LIST_MAX_CHARS) break;
        result = next;
      }
      return result;
    } catch (err) {
      return JSON.stringify({
        error: `Failed to list skills: ${err instanceof Error ? err.message : err}`,
      });
    }
  },
};
