/**
 * Enrichment service — queries Hindsight mental models, task outcomes,
 * and saved skills to build adaptive, context-rich prompts before task creation.
 *
 * Injects: user behavior profile, active project state, tool effectiveness hints,
 * matching skills as known procedures, and confidence assessment.
 *
 * All queries have 3s timeout and degrade gracefully to empty strings.
 * Mental model content is cached for 5 minutes to avoid re-querying on rapid messages.
 */

import { getMemoryService } from "../memory/index.js";
import { queryOutcomes } from "../db/task-outcomes.js";
import { findSkillsByKeywords, type SkillRow } from "../db/skills.js";

export interface EnrichmentResult {
  contextBlock: string;
  toolHints: string[];
  matchedSkillIds: string[];
  confidence: "high" | "medium" | "low";
}

/**
 * Enrich the task context with adaptive intelligence.
 * Returns a context block to inject into the prompt, tool usage hints,
 * matched skill IDs for tracking, and a confidence level.
 * Never throws — returns empty result on any failure.
 */
export async function enrichContext(
  messageText: string,
  _channel: string,
): Promise<EnrichmentResult> {
  const sections: string[] = [];
  const toolHints: string[] = [];
  const matchedSkillIds: string[] = [];
  let confidence: "high" | "medium" | "low" = "low";

  // Skill matching works on SQLite — no Hindsight required
  try {
    const skillResult = getMatchingSkills(messageText);
    if (skillResult.block) {
      sections.push(skillResult.block);
      matchedSkillIds.push(...skillResult.skillIds);
      confidence = skillResult.confidence;
    }
  } catch {
    // Non-fatal
  }

  // Recall relevant context from Hindsight (or SQLite fallback)
  const memory = getMemoryService();
  try {
    // Recall user context relevant to this message (semantic search)
    const userContext = await memory.recall(messageText, {
      bank: "mc-jarvis",
      tags: ["conversation"],
      maxResults: 5,
    });
    if (userContext.length > 0) {
      const contextLines = userContext.map((m) => `- ${m.content}`).join("\n");
      sections.push(`## Contexto relevante del usuario\n${contextLines}`);
    }

    // Recall operational learnings relevant to this message
    if (memory.backend === "hindsight") {
      const opContext = await memory.recall(messageText, {
        bank: "mc-operational",
        maxResults: 3,
      });
      if (opContext.length > 0) {
        const opLines = opContext.map((m) => `- ${m.content}`).join("\n");
        sections.push(`## Aprendizajes previos\n${opLines}`);
      }
    }
  } catch {
    // Non-fatal
  }

  // Tool effectiveness hints from SQLite outcomes (instant, no Hindsight needed)
  try {
    const hints = getToolHints();
    if (hints) {
      sections.push(`## Herramientas más efectivas\n${hints}`);
    }

    const topTools = getTopTools();
    if (topTools.length > 0) {
      toolHints.push(...topTools);
    }
  } catch {
    // Non-fatal
  }

  return {
    contextBlock: sections.length > 0 ? "\n\n" + sections.join("\n\n") : "",
    toolHints,
    matchedSkillIds,
    confidence,
  };
}

// ---------------------------------------------------------------------------
// Skill matching (SQLite-based, no Hindsight required)
// ---------------------------------------------------------------------------

interface SkillMatchResult {
  block: string | null;
  skillIds: string[];
  confidence: "high" | "medium" | "low";
}

function getMatchingSkills(messageText: string): SkillMatchResult {
  try {
    const matches = findSkillsByKeywords(messageText);
    if (matches.length === 0) {
      return { block: null, skillIds: [], confidence: "low" };
    }

    const lines = matches.map((s: SkillRow) => {
      const steps = JSON.parse(s.steps) as string[];
      const tools = JSON.parse(s.tools) as string[];
      const successRate =
        s.use_count > 0
          ? Math.round((s.success_count / s.use_count) * 100)
          : 100;

      return (
        `### ${s.name} (usado ${s.use_count} veces, ${successRate}% éxito)\n` +
        `Trigger: ${s.trigger_text}\n` +
        `Pasos:\n${steps.map((st, i) => `${i + 1}. ${st}`).join("\n")}\n` +
        `Herramientas: ${tools.map((t) => t.replace("commit__", "")).join(", ")}`
      );
    });

    const block =
      "## Procedimientos conocidos\n" +
      "Tienes experiencia con estos procedimientos. Úsalos como guía:\n\n" +
      lines.join("\n\n");

    const skillIds = matches.map((s: SkillRow) => s.skill_id);

    // Compute confidence from best match
    const best = matches[0];
    let confidence: "high" | "medium" | "low" = "medium";
    if (
      best.use_count >= 3 &&
      best.success_count / Math.max(best.use_count, 1) >= 0.7
    ) {
      confidence = "high";
    } else if (best.use_count === 0) {
      confidence = "medium";
    }

    return { block, skillIds, confidence };
  } catch {
    return { block: null, skillIds: [], confidence: "low" };
  }
}

// ---------------------------------------------------------------------------
// Tool hints from outcomes
// ---------------------------------------------------------------------------

/** Build tool effectiveness hints from recent outcomes. */
function getToolHints(): string | null {
  try {
    const outcomes = queryOutcomes({ days: 14, limit: 50 });
    if (outcomes.length < 5) return null;

    const successCount = outcomes.filter((o) => o.success).length;
    const rate = Math.round((successCount / outcomes.length) * 100);

    const toolFreq = new Map<string, number>();
    for (const o of outcomes) {
      try {
        const tools = JSON.parse(o.tools_used) as string[];
        for (const t of tools) {
          toolFreq.set(t, (toolFreq.get(t) ?? 0) + 1);
        }
      } catch {
        continue;
      }
    }

    const sorted = [...toolFreq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    if (sorted.length === 0) return null;

    const lines = sorted.map(
      ([tool, count]) =>
        `- ${tool.replace("commit__", "")}: usado ${count} veces`,
    );

    return `Tasa de éxito reciente: ${rate}%. Herramientas más usadas:\n${lines.join("\n")}`;
  } catch {
    return null;
  }
}

/** Get the top 5 most-used tools from recent outcomes for prioritization. */
function getTopTools(): string[] {
  try {
    const outcomes = queryOutcomes({
      days: 7,
      limit: 30,
      success: true,
    });

    const toolFreq = new Map<string, number>();
    for (const o of outcomes) {
      try {
        const tools = JSON.parse(o.tools_used) as string[];
        for (const t of tools) {
          toolFreq.set(t, (toolFreq.get(t) ?? 0) + 1);
        }
      } catch {
        continue;
      }
    }

    return [...toolFreq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([tool]) => tool);
  } catch {
    return [];
  }
}

/** Clear enrichment state (for testing). */
export function clearEnrichmentCache(): void {
  // No cache to clear after switching from mental models to direct recall
}
