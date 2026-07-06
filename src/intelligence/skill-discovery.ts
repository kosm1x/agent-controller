/**
 * Skill discovery — detects recurring tool patterns in task outcomes
 * and proposes new skills when a sequence appears 3+ times.
 *
 * Rate-limited: at most one proposal per 24 hours.
 * Proposals are logged and optionally broadcast via messaging.
 * Does NOT auto-save — the user or LLM must confirm via skill_save.
 */

import { queryOutcomes } from "../db/task-outcomes.js";
import { listSkills } from "../db/skills.js";
import { getMemoryService } from "../memory/index.js";

const MIN_OCCURRENCES = 3;
const MIN_TOOLS_IN_SEQUENCE = 2;
const RATE_LIMIT_MS = 86_400_000; // 24 hours

let lastProposalTime = 0;

/**
 * Detect recurring tool patterns in recent outcomes.
 * If a new pattern is found, propose it as a skill.
 */
export async function detectRecurringPatterns(): Promise<void> {
  // Rate limit
  if (Date.now() - lastProposalTime < RATE_LIMIT_MS) return;

  try {
    const outcomes = queryOutcomes({ days: 14, limit: 100, success: true });
    if (outcomes.length < MIN_OCCURRENCES) return;

    // Extract tool sequences and count occurrences
    const sequenceCounts = new Map<
      string,
      { count: number; titles: string[] }
    >();

    for (const o of outcomes) {
      try {
        const tools = JSON.parse(o.tools_used) as string[];
        if (tools.length < MIN_TOOLS_IN_SEQUENCE) continue;

        // Normalize: sort tool names to treat A→B same as B→A
        const key = [...tools].sort().join("|");
        const existing = sequenceCounts.get(key) ?? { count: 0, titles: [] };
        existing.count++;
        // Extract title from tags or task_id for naming
        try {
          const tags = JSON.parse(o.tags) as string[];
          const title = tags.find(
            (t) => !["messaging", "telegram", "whatsapp"].includes(t),
          );
          if (title && !existing.titles.includes(title)) {
            existing.titles.push(title);
          }
        } catch {
          // no tags
        }
        sequenceCounts.set(key, existing);
      } catch {
        continue;
      }
    }

    // Find sequences meeting threshold
    const existingSkills = listSkills({ active: true });
    const existingToolSets = new Set(
      existingSkills.map((s) => {
        try {
          return (JSON.parse(s.tools) as string[]).sort().join("|");
        } catch {
          return "";
        }
      }),
    );

    for (const [key, data] of sequenceCounts) {
      if (data.count < MIN_OCCURRENCES) continue;
      if (existingToolSets.has(key)) continue; // Already a skill

      const tools = key.split("|");
      const name = generateSkillName(tools);

      await proposeSkill(name, tools, data.count, data.titles);
      lastProposalTime = Date.now();
      return; // One proposal per invocation
    }
  } catch {
    // Non-fatal
  }
}

/** Generate a human-readable name from tool names. */
function generateSkillName(tools: string[]): string {
  const simplified = tools.map((t) => t.replace(/_/g, " ")).slice(0, 3);
  return simplified.join(" + ");
}

/** Propose a skill — log it, store in Hindsight, and submit a task to auto-save. */
async function proposeSkill(
  name: string,
  tools: string[],
  occurrences: number,
  titles: string[],
): Promise<void> {
  console.log(
    `[skill-discovery] Proposing skill "${name}" (${occurrences} occurrences, tools: ${tools.join(", ")})`,
  );

  try {
    const memory = getMemoryService();
    await memory.retain(
      `Skill proposal: "${name}". Tools: ${tools.join(", ")}. ` +
        `Detected ${occurrences} times in last 14 days. ` +
        `Consider saving with skill_save if this is a recurring workflow.`,
      {
        bank: "mc-operational",
        tags: ["skill-proposal"],
        async: true,
      },
    );
  } catch {
    // Best-effort
  }

  // Submit a task to evaluate and auto-save the skill
  try {
    const { submitTask } = await import("../dispatch/dispatcher.js");
    await submitTask({
      title: `Auto-skill: ${name}`,
      description: `A recurring tool pattern was detected (${occurrences}x in 14 days).
Tools: ${tools.join(", ")}
Related tasks: ${titles.join(", ") || "N/A"}

Instructions:
1. Use skill_list to check if a similar skill already exists
2. If no similar skill exists, use skill_save. ALL of these params are REQUIRED
   (each maps to a NOT NULL column — omitting one makes the save fail):
   - name: a short snake_case name for this workflow
   - description: ONE sentence describing what the skill does
   - trigger: natural-language description of the request that should activate it
   - steps: an ORDERED ARRAY of step descriptions (one string per step)
   - tools: ${JSON.stringify(tools)}
3. If a similar skill already exists, do nothing

Be conservative — only save genuinely reusable workflows.`,
      // MUST be "fast" (a HOST runner), NOT "auto". The task's ACTION is a host
      // DB write (skill_save/skill_list → getDatabase() = host mc.db), but its
      // DESCRIPTION names the detected coding tool-pattern (e.g. "file edit + git
      // commit + git push"), so "auto" lets the classifier match \bgit\b and route
      // it to the mission-control-only nanoclaw SANDBOX — where skill_save/skill_list
      // aren't registered and mc.db is a throwaway /tmp copy, so the skill can NEVER
      // persist (0 skills saved 2026-06-28..07-06, all runs failed/no-op). Explicit
      // "fast" pins it to the in-process host runner. See feedback_skill_discovery_host_tool_misroute.
      agentType: "fast",
      tools: ["skill_save", "skill_list"],
      tags: ["internal", "skill-suggestion"],
    });
  } catch {
    // Best-effort — skill proposal still logged to Hindsight above
  }
}

/** Reset rate limit (for testing). */
export function resetDiscoveryRateLimit(): void {
  lastProposalTime = 0;
}
