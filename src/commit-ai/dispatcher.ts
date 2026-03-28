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
import { createLogger } from "../lib/logger.js";

const log = createLogger("commit-ai");

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
  // Strip markdown fences
  const cleaned = text.replace(/```(?:json|javascript)?\s*\n?/g, "").trim();

  // Try parsing the entire cleaned text first
  try {
    JSON.parse(cleaned);
    return cleaned;
  } catch {
    // continue to bracket matching
  }

  // Find the first valid JSON by brace-depth counting
  for (let i = 0; i < cleaned.length; i++) {
    const open = cleaned[i];
    if (open !== "{" && open !== "[") continue;
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < cleaned.length; j++) {
      const c = cleaned[j];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (c === "\\") {
        escaped = true;
        continue;
      }
      if (c === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (c === open) depth++;
      if (c === close) depth--;
      if (depth === 0) {
        const candidate = cleaned.slice(i, j + 1);
        try {
          JSON.parse(candidate);
          return candidate;
        } catch {
          break;
        }
      }
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
      log.warn(
        { err, function: req.function },
        "enrichment failed, proceeding without",
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
      log.warn(
        { function: req.function, response: text.slice(0, 200) },
        "failed to extract JSON",
      );
      return { content: null, enriched, error: "JSON extraction failed" };
    }

    log.info(
      {
        function: req.function,
        enriched,
        latencyMs: response.latency_ms,
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
      },
      "inference complete",
    );

    return { content: json, enriched };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err: message, function: req.function }, "inference failed");
    return { content: null, enriched, error: message };
  }
}
