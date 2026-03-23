/**
 * COMMIT AI dispatcher — single entry point for all 12 COMMIT AI functions.
 *
 * Enriches the original prompt with COMMIT context (goals, tasks, memory),
 * calls the inference adapter, and returns JSON matching COMMIT's Zod schemas.
 */

import { infer } from "../inference/adapter.js";
import type { ChatMessage } from "../inference/adapter.js";
import { enrichCommitContext } from "./enrichment.js";
import { buildEnrichedPrompt } from "./prompts.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CommitAIRequest {
  function: string;
  input: Record<string, unknown>;
  context?: {
    user_id?: string;
    language?: string;
  };
}

export interface CommitAIResult {
  content: string | null;
  enriched: boolean;
  error?: string;
}

interface FunctionMeta {
  enrichment: string[];
  temperature: number;
  maxTokens: number;
}

// ---------------------------------------------------------------------------
// Function registry — maps COMMIT function name to enrichment config
// ---------------------------------------------------------------------------

const FUNCTION_REGISTRY: Record<string, FunctionMeta> = {
  analyzeJournalEntry: {
    enrichment: ["snapshot", "memory"],
    temperature: 0.7,
    maxTokens: 1024,
  },
  extractObjectivesFromJournal: {
    enrichment: ["goals"],
    temperature: 0.5,
    maxTokens: 512,
  },
  generateMindMap: {
    enrichment: ["snapshot"],
    temperature: 0.7,
    maxTokens: 2048,
  },
  completeIdea: {
    enrichment: ["memory"],
    temperature: 0.8,
    maxTokens: 2048,
  },
  findIdeaConnections: {
    enrichment: ["memory"],
    temperature: 0.5,
    maxTokens: 2048,
  },
  generateDivergentPaths: {
    enrichment: ["memory"],
    temperature: 0.9,
    maxTokens: 1536,
  },
  suggestNextSteps: {
    enrichment: ["snapshot", "goals"],
    temperature: 0.7,
    maxTokens: 1024,
  },
  generateCriticalAnalysis: {
    enrichment: ["memory"],
    temperature: 0.6,
    maxTokens: 1536,
  },
  generateRelatedConcepts: {
    enrichment: ["memory"],
    temperature: 0.7,
    maxTokens: 1536,
  },
  suggestObjectivesForGoal: {
    enrichment: ["goals", "snapshot"],
    temperature: 0.7,
    maxTokens: 1536,
  },
  suggestTasksForObjective: {
    enrichment: ["snapshot"],
    temperature: 0.7,
    maxTokens: 1536,
  },
  transformIdeaText: {
    enrichment: [],
    temperature: 0.5,
    maxTokens: 600,
  },
};

// ---------------------------------------------------------------------------
// JSON extraction — same patterns as COMMIT's aiService.ts
// ---------------------------------------------------------------------------

function extractJSON(text: string): string | null {
  // Try object first
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      JSON.parse(objMatch[0]);
      return objMatch[0];
    } catch {
      // not valid JSON
    }
  }

  // Try array
  const arrMatch = text.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try {
      JSON.parse(arrMatch[0]);
      return arrMatch[0];
    } catch {
      // not valid JSON
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main dispatcher
// ---------------------------------------------------------------------------

/**
 * Dispatch a COMMIT AI function through Jarvis's enriched inference.
 *
 * 1. Validate function name
 * 2. Load enriched context (goals, tasks, memory) in parallel
 * 3. Build prompt with context prefix
 * 4. Call inference adapter (single LLM call)
 * 5. Extract and return JSON
 */
export async function dispatchCommitAI(
  req: CommitAIRequest,
): Promise<CommitAIResult> {
  const meta = FUNCTION_REGISTRY[req.function];
  if (!meta) {
    return {
      content: null,
      enriched: false,
      error: `Unknown function: ${req.function}. Valid: ${Object.keys(FUNCTION_REGISTRY).join(", ")}`,
    };
  }

  const originalPrompt = (req.input.prompt as string) ?? "";
  if (!originalPrompt) {
    return {
      content: null,
      enriched: false,
      error: "Missing 'prompt' in input",
    };
  }

  const language = req.context?.language ?? "en";

  // Enrich context (parallel, 3s cap, failures ignored)
  let enriched = false;
  let finalPrompt = originalPrompt;

  if (meta.enrichment.length > 0) {
    try {
      const context = await enrichCommitContext(meta.enrichment, req.input);
      finalPrompt = buildEnrichedPrompt(
        req.function,
        originalPrompt,
        context,
        language,
      );
      enriched =
        !!context.snapshotSummary ||
        !!context.goalsSummary ||
        !!context.memorySummary;
    } catch (err) {
      console.warn(
        `[commit-ai] Enrichment failed for ${req.function}, proceeding without:`,
        err,
      );
    }
  } else {
    // No enrichment needed (e.g. transformIdeaText) — just add language instruction
    finalPrompt = buildEnrichedPrompt(
      req.function,
      originalPrompt,
      {},
      language,
    );
  }

  // Build messages for inference
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You are the AI engine for COMMIT, a personal growth and productivity app. " +
        "Respond ONLY with the requested JSON format. No explanations, no markdown fences.",
    },
    { role: "user", content: finalPrompt },
  ];

  // Call inference (single LLM call, no tools)
  try {
    const response = await infer({
      messages,
      temperature: meta.temperature,
      max_tokens: meta.maxTokens,
    });

    const text = response.content ?? "";

    // For transformIdeaText, return raw text (not JSON)
    if (req.function === "transformIdeaText") {
      return { content: text, enriched };
    }

    // Extract JSON from response
    const json = extractJSON(text);
    if (!json) {
      console.warn(
        `[commit-ai] Failed to extract JSON for ${req.function}. Response: ${text.slice(0, 200)}`,
      );
      return { content: null, enriched, error: "JSON extraction failed" };
    }

    console.log(
      `[commit-ai] ${req.function}: ${enriched ? "enriched" : "plain"}, ${response.latency_ms}ms, ${response.usage.prompt_tokens}p/${response.usage.completion_tokens}c`,
    );

    return { content: json, enriched };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[commit-ai] Inference failed for ${req.function}:`, message);
    return { content: null, enriched, error: message };
  }
}
