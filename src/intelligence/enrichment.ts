/**
 * Enrichment service — queries Hindsight mental models and task outcomes
 * to build adaptive, context-rich prompts before task creation.
 *
 * Injects: user behavior profile, active project state, tool effectiveness hints.
 * All queries have 3s timeout and degrade gracefully to empty strings.
 * Mental model content is cached for 5 minutes to avoid re-querying on rapid messages.
 */

import { HindsightClient } from "../memory/hindsight-client.js";
import { getMemoryService } from "../memory/index.js";
import { queryOutcomes } from "../db/task-outcomes.js";
import { MODEL_IDS } from "./mental-models.js";

const CACHE_TTL_MS = 300_000; // 5 minutes

interface CacheEntry {
  content: string;
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();

export interface EnrichmentResult {
  contextBlock: string;
  toolHints: string[];
}

/**
 * Enrich the task context with adaptive intelligence.
 * Returns a context block to inject into the prompt and tool usage hints.
 * Never throws — returns empty result on any failure.
 */
export async function enrichContext(
  _messageText: string,
  _channel: string,
): Promise<EnrichmentResult> {
  const memory = getMemoryService();
  if (memory.backend !== "hindsight") {
    return { contextBlock: "", toolHints: [] };
  }

  const sections: string[] = [];
  const toolHints: string[] = [];

  try {
    const baseUrl = process.env.HINDSIGHT_URL ?? "http://localhost:8888";
    const apiKey = process.env.HINDSIGHT_API_KEY;
    const client = new HindsightClient(baseUrl, apiKey);

    // Query mental models in parallel (3s timeout each via client)
    const [userBehavior, activeProjects] = await Promise.all([
      getCachedModel(client, "mc-jarvis", MODEL_IDS.userBehavior),
      getCachedModel(client, "mc-jarvis", MODEL_IDS.activeProjects),
    ]);

    if (userBehavior) {
      sections.push(`## Tu conocimiento del usuario\n${userBehavior}`);
    }

    if (activeProjects) {
      sections.push(`## Estado actual de proyectos\n${activeProjects}`);
    }

    // Query tool effectiveness from SQLite outcomes (instant)
    const hints = getToolHints();
    if (hints) {
      sections.push(`## Herramientas más efectivas\n${hints}`);
    }

    // Extract top tools from recent outcomes for prioritization
    const topTools = getTopTools();
    if (topTools.length > 0) {
      toolHints.push(...topTools);
    }
  } catch {
    // Non-fatal — return whatever we have
  }

  return {
    contextBlock: sections.length > 0 ? "\n\n" + sections.join("\n\n") : "",
    toolHints,
  };
}

/** Get a mental model's content, using 5-min cache. */
async function getCachedModel(
  client: HindsightClient,
  bankId: string,
  modelId: string,
): Promise<string | null> {
  const cacheKey = `${bankId}:${modelId}`;
  const cached = cache.get(cacheKey);

  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.content || null;
  }

  try {
    const model = await client.getMentalModel(bankId, modelId);
    const content = model.content?.trim() || "";
    cache.set(cacheKey, { content, fetchedAt: Date.now() });
    return content || null;
  } catch {
    return null;
  }
}

/** Build tool effectiveness hints from recent outcomes. */
function getToolHints(): string | null {
  try {
    const outcomes = queryOutcomes({ days: 14, limit: 50 });
    if (outcomes.length < 5) return null;

    const successCount = outcomes.filter((o) => o.success).length;
    const rate = Math.round((successCount / outcomes.length) * 100);

    // Count tool usage frequency
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

/** Clear the mental model cache (for testing). */
export function clearEnrichmentCache(): void {
  cache.clear();
}
