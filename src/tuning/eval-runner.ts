/**
 * Eval runner — executes test cases against a sandbox config.
 *
 * Supports three evaluation modes:
 * - tool_selection: calls inferWithTools to see which tools the LLM chooses (costs API tokens)
 * - scope_accuracy: runs pure scopeTools function (free, deterministic)
 * - classification: runs pure classify function (free, deterministic)
 */

import type {
  TestCase,
  SandboxConfig,
  EvalResult,
  EvalFilter,
  CaseScore,
} from "./types.js";
import { EST_COST_PER_INFERENCE_USD } from "./types.js";
import { getActiveTestCases } from "./schema.js";
import {
  scoreToolSelection,
  scoreScopeAccuracy,
  scoreClassification,
  computeCompositeScore,
} from "./scorer.js";
import {
  detectActiveGroups,
  DEFAULT_SCOPE_PATTERNS,
} from "../messaging/scope.js";
import { classify, type ClassificationInput } from "../dispatch/classifier.js";
import type { ChatMessage, ToolDefinition } from "../inference/adapter.js";
import { toolRegistry } from "../tools/registry.js";

// ---------------------------------------------------------------------------
// Sandbox tool registry
// ---------------------------------------------------------------------------

/**
 * Build tool definitions with optional description overrides.
 * Does NOT modify the global toolRegistry — creates a new definitions array.
 */
function buildSandboxDefinitions(
  toolNames: string[],
  overrides?: Map<string, string>,
): ToolDefinition[] {
  const defs = toolRegistry.getDefinitions(toolNames);

  if (!overrides || overrides.size === 0) return defs;

  return defs.map((def) => {
    const override = overrides.get(def.function.name);
    if (!override) return def;

    return {
      ...def,
      function: {
        ...def.function,
        description: override,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Individual case evaluators
// ---------------------------------------------------------------------------

/**
 * Evaluate a tool_selection case by calling the LLM.
 *
 * Makes a single inference call with the test message and available tools,
 * then checks which tools the LLM decided to call.
 */
async function evalToolSelection(
  tc: TestCase,
  sandbox: SandboxConfig,
  inferFn: InferFunction,
): Promise<CaseScore> {
  const message = tc.input.message;

  // Build scoped tools (use override patterns if provided, else defaults)
  const patterns = sandbox.scopePatternOverrides ?? DEFAULT_SCOPE_PATTERNS;
  const recentMessages = (tc.input.conversationHistory ?? [])
    .filter((t) => t.role === "user")
    .map((t) => t.content);

  // For eval, assume all optional features are available
  const { scopeToolsForMessage } = await import("../messaging/scope.js");
  const scopedToolNames = scopeToolsForMessage(
    message,
    recentMessages,
    patterns,
    {
      hasGoogle: true,
      hasWordpress: true,
      hasMemory: false,
      hasCrm: true,
    },
  );

  const definitions = buildSandboxDefinitions(
    scopedToolNames,
    sandbox.toolDescriptionOverrides,
  );

  // Build messages for LLM
  const messages: ChatMessage[] = [];
  if (tc.input.conversationHistory) {
    for (const turn of tc.input.conversationHistory) {
      messages.push({ role: turn.role, content: turn.content });
    }
  }
  messages.push({ role: "user", content: message });

  // Call inference — we only care about which tools are called, not execution
  const result = await inferFn(messages, definitions);

  const { score, details } = scoreToolSelection(
    tc.expected,
    result.toolsCalled,
  );

  return {
    caseId: tc.case_id,
    category: "tool_selection",
    score,
    weight: tc.weight,
    details: {
      ...details,
      tokensUsed: result.tokensUsed,
    },
  };
}

/**
 * Evaluate a scope_accuracy case (deterministic, no LLM call).
 */
function evalScopeAccuracy(tc: TestCase, sandbox: SandboxConfig): CaseScore {
  const patterns = sandbox.scopePatternOverrides ?? DEFAULT_SCOPE_PATTERNS;
  const recentMessages = (tc.input.conversationHistory ?? [])
    .filter((t) => t.role === "user")
    .map((t) => t.content);

  const activeGroups = detectActiveGroups(
    tc.input.message,
    recentMessages,
    patterns,
  );

  const { score, details } = scoreScopeAccuracy(tc.expected, activeGroups);

  return {
    caseId: tc.case_id,
    category: "scope_accuracy",
    score,
    weight: tc.weight,
    details,
  };
}

/**
 * Evaluate a classification case (deterministic, no LLM call).
 */
function evalClassification(tc: TestCase): CaseScore {
  const input: ClassificationInput = {
    title: tc.input.message,
    description: tc.input.message,
  };

  const result = classify(input);
  const { score, details } = scoreClassification(tc.expected, result.agentType);

  return {
    caseId: tc.case_id,
    category: "classification",
    score,
    weight: tc.weight,
    details: {
      ...details,
      classifierScore: result.score,
      classifierReason: result.reason,
    },
  };
}

// ---------------------------------------------------------------------------
// Inference abstraction (for testing / mocking)
// ---------------------------------------------------------------------------

export interface InferResult {
  toolsCalled: string[];
  tokensUsed: number;
}

/**
 * Function signature for LLM inference in eval context.
 * Returns just the tools called and token usage — we don't execute tools.
 */
export type InferFunction = (
  messages: ChatMessage[],
  tools: ToolDefinition[],
) => Promise<InferResult>;

/**
 * Default inference function using the real adapter.
 * Calls infer() once (not inferWithTools) to see which tools the LLM wants to call.
 */
export async function defaultInferFunction(
  messages: ChatMessage[],
  tools: ToolDefinition[],
): Promise<InferResult> {
  // Dynamic import to avoid circular deps at module load time
  const { infer } = await import("../inference/adapter.js");

  const result = await infer({ messages, tools });

  const toolsCalled = (result.tool_calls ?? []).map((tc) => tc.function.name);

  return {
    toolsCalled,
    tokensUsed:
      (result.usage?.prompt_tokens ?? 0) +
      (result.usage?.completion_tokens ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Main eval runner
// ---------------------------------------------------------------------------

/**
 * Run evaluation suite against a sandbox config.
 *
 * @param sandbox - Configuration overrides (tool descriptions, scope patterns)
 * @param filter - Optional filter to run only specific cases/categories
 * @param inferFn - Injectable inference function (defaults to real LLM call)
 */
export async function runEvaluation(
  sandbox: SandboxConfig = {},
  filter?: EvalFilter,
  inferFn: InferFunction = defaultInferFunction,
): Promise<EvalResult> {
  const startMs = Date.now();
  let totalTokens = 0;

  // Load test cases
  let cases = getActiveTestCases(filter?.category);
  if (filter?.caseIds && filter.caseIds.length > 0) {
    const idSet = new Set(filter.caseIds);
    cases = cases.filter((c) => idSet.has(c.case_id));
  }

  if (cases.length === 0) {
    return {
      compositeScore: 0,
      subscores: { toolSelection: 0, scopeAccuracy: 0, classification: 0 },
      perCase: [],
      totalTokens: 0,
      estimatedCostUsd: 0,
      durationMs: Date.now() - startMs,
    };
  }

  const results: CaseScore[] = [];

  // Evaluate each case by category
  for (const tc of cases) {
    try {
      let caseResult: CaseScore;

      switch (tc.category) {
        case "tool_selection":
          caseResult = await evalToolSelection(tc, sandbox, inferFn);
          totalTokens += (caseResult.details.tokensUsed as number) ?? 0;
          break;

        case "scope_accuracy":
          caseResult = evalScopeAccuracy(tc, sandbox);
          break;

        case "classification":
          caseResult = evalClassification(tc);
          break;

        default:
          continue;
      }

      results.push(caseResult);
    } catch (err) {
      // Record error as 0 score
      results.push({
        caseId: tc.case_id,
        category: tc.category,
        score: 0,
        weight: tc.weight,
        details: { error: String(err) },
      });
    }
  }

  const { compositeScore, subscores } = computeCompositeScore(results);
  const toolSelectionCount = results.filter(
    (r) => r.category === "tool_selection",
  ).length;

  return {
    compositeScore,
    subscores,
    perCase: results,
    totalTokens,
    estimatedCostUsd: toolSelectionCount * EST_COST_PER_INFERENCE_USD,
    durationMs: Date.now() - startMs,
  };
}
