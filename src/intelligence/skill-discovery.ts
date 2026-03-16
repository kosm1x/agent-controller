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

      await proposeSkill(name, tools, data.count);
      lastProposalTime = Date.now();
      return; // One proposal per invocation
    }
  } catch {
    // Non-fatal
  }
}

/** Generate a human-readable name from tool names. */
function generateSkillName(tools: string[]): string {
  const simplified = tools
    .map((t) => t.replace("commit__", "").replace(/_/g, " "))
    .slice(0, 3);
  return simplified.join(" + ");
}

/** Propose a skill — log it and store in Hindsight for later review. */
async function proposeSkill(
  name: string,
  tools: string[],
  occurrences: number,
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
}

/** Reset rate limit (for testing). */
export function resetDiscoveryRateLimit(): void {
  lastProposalTime = 0;
}
