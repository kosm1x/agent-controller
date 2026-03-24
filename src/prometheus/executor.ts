/**
 * Executor — Dependency-ordered goal execution using inferWithTools.
 *
 * Each goal gets its own LLM + tool loop. The LLM autonomously selects tools,
 * interprets results, and iterates until the goal is achieved or fails.
 * Ready goals execute concurrently via Promise.allSettled.
 */

import { inferWithTools } from "../inference/adapter.js";
import type { ChatMessage } from "../inference/adapter.js";
import { toolRegistry } from "../tools/registry.js";
import { GoalGraph } from "./goal-graph.js";
import { IterationBudget } from "./budget.js";
import { GoalStatus, ErrorStrategy } from "./types.js";
import type { Goal, GoalResult, ExecutionResult } from "./types.js";
import { getMemoryService } from "../memory/index.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_RETRIES = 3;
const MAX_ROUNDS_PER_GOAL = 10;
const CONTEXT_MAX_GOALS = 5;
const CONTEXT_MAX_CHARS = 500;

const TRANSIENT_PATTERNS = [
  "timeout",
  "timed out",
  "rate limit",
  "429",
  "503",
  "connection reset",
  "connection refused",
  "eagain",
];

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

function classifyError(
  error: string,
  attempt: number,
  maxAttempts: number,
): ErrorStrategy {
  const lower = error.toLowerCase();
  const isTransient = TRANSIENT_PATTERNS.some((p) => lower.includes(p));
  if (isTransient && attempt < maxAttempts - 1) return ErrorStrategy.RETRY;
  if (attempt < maxAttempts - 1) return ErrorStrategy.RETRY;
  return ErrorStrategy.ESCALATE;
}

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

async function recallLearnings(
  goalDescription: string,
  limit: number,
): Promise<string[]> {
  try {
    const memories = await getMemoryService().recall(goalDescription, {
      bank: "mc-operational",
      tags: ["execution"],
      maxResults: limit,
    });
    return memories.map((m) => m.content);
  } catch {
    return [];
  }
}

async function buildGoalPrompt(goal: Goal, context: string): Promise<string> {
  const criteria =
    goal.completionCriteria.length > 0
      ? goal.completionCriteria.map((c, i) => `  ${i + 1}. ${c}`).join("\n")
      : "  (no specific criteria — use best judgment)";

  // Inject prior learnings if available
  const learnings = await recallLearnings(goal.description, 10);
  const learningsSection =
    learnings.length > 0
      ? `## Prior learnings\n${learnings.map((l, i) => `  ${i + 1}. ${l}`).join("\n")}\n\n`
      : "";

  return (
    `You are executing a single goal as part of a larger plan. Use the available tools to achieve the goal.\n\n` +
    `## Goal\n${goal.description}\n\n` +
    `## Completion Criteria\n${criteria}\n\n` +
    (context ? `## Context from completed goals\n${context}\n\n` : "") +
    learningsSection +
    `## Instructions\n` +
    `- Use tools to accomplish the goal.\n` +
    `- When all completion criteria are met, respond with a summary of what you achieved.\n` +
    `- If you cannot complete the goal, explain what went wrong.`
  );
}

function buildContextFromResults(results: Record<string, GoalResult>): string {
  const completed = Object.values(results)
    .filter((r) => r.ok && r.result)
    .slice(-CONTEXT_MAX_GOALS);

  if (completed.length === 0) return "";

  return completed
    .map((r) => {
      const text = r.result ?? "";
      const truncated =
        text.length > CONTEXT_MAX_CHARS
          ? text.slice(0, CONTEXT_MAX_CHARS) + "..."
          : text;
      return `- Goal ${r.goalId}: ${truncated}`;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// Single goal execution
// ---------------------------------------------------------------------------

/**
 * Execute a single goal using LLM + tools with retry logic.
 */
export async function executeGoal(
  goal: Goal,
  context: string,
  toolNames?: string[],
  budget?: IterationBudget,
  goalTimeoutMs?: number,
  signal?: AbortSignal,
): Promise<GoalResult> {
  const start = Date.now();

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // Check abort signal
    if (signal?.aborted) {
      return {
        goalId: goal.id,
        ok: false,
        error: "Aborted",
        durationMs: Date.now() - start,
        toolCalls: 0,
        toolNames: [],
        toolFailures: 0,
        tokenUsage: { promptTokens: 0, completionTokens: 0 },
      };
    }

    // Check budget before each attempt
    if (budget && !budget.consume()) {
      return {
        goalId: goal.id,
        ok: false,
        error: "Iteration budget exhausted",
        durationMs: Date.now() - start,
        toolCalls: 0,
        toolNames: [],
        toolFailures: 0,
        tokenUsage: { promptTokens: 0, completionTokens: 0 },
      };
    }

    try {
      const systemPrompt = await buildGoalPrompt(goal, context);
      const messages: ChatMessage[] = [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Execute this goal: ${goal.description}` },
      ];

      const definitions = toolRegistry.getDefinitions(toolNames);

      const inferPromise = inferWithTools(
        messages,
        definitions,
        (name, args) => toolRegistry.execute(name, args),
        MAX_ROUNDS_PER_GOAL,
        undefined, // onTextChunk
        signal,
      );

      // Apply per-goal timeout if configured
      let result: Awaited<typeof inferPromise>;
      if (goalTimeoutMs && goalTimeoutMs > 0) {
        let timer: ReturnType<typeof setTimeout>;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(`Goal ${goal.id} timed out after ${goalTimeoutMs}ms`),
              ),
            goalTimeoutMs,
          );
        });
        try {
          result = await Promise.race([inferPromise, timeout]);
        } finally {
          clearTimeout(timer!);
        }
      } else {
        result = await inferPromise;
      }

      // Extract tool call names and count from the conversation
      const tcNames: string[] = [];
      for (const m of result.messages) {
        if (m.role === "assistant" && m.tool_calls) {
          for (const tc of m.tool_calls) {
            tcNames.push(tc.function.name);
          }
        }
      }

      return {
        goalId: goal.id,
        ok: true,
        result: result.content,
        durationMs: Date.now() - start,
        toolCalls: tcNames.length,
        toolNames: tcNames,
        toolFailures: 0,
        tokenUsage: {
          promptTokens: result.totalUsage.prompt_tokens,
          completionTokens: result.totalUsage.completion_tokens,
        },
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const strategy = classifyError(errorMsg, attempt, MAX_RETRIES);

      if (strategy === ErrorStrategy.RETRY) {
        const delay = Math.min(2 ** (attempt + 1) * 1000, 30_000);
        console.warn(
          `[executor] Goal ${goal.id} retry ${attempt + 1}/${MAX_RETRIES}: ${errorMsg}`,
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      return {
        goalId: goal.id,
        ok: false,
        error: errorMsg,
        durationMs: Date.now() - start,
        toolCalls: 0,
        toolNames: [],
        toolFailures: 1,
        tokenUsage: { promptTokens: 0, completionTokens: 0 },
      };
    }
  }

  return {
    goalId: goal.id,
    ok: false,
    error: "Max retries exceeded",
    durationMs: Date.now() - start,
    toolCalls: 0,
    toolNames: [],
    toolFailures: 1,
    tokenUsage: { promptTokens: 0, completionTokens: 0 },
  };
}

// ---------------------------------------------------------------------------
// Graph execution
// ---------------------------------------------------------------------------

/**
 * Execute all goals in dependency order.
 * Ready goals run concurrently via Promise.allSettled.
 */
export async function executeGraph(
  graph: GoalGraph,
  toolNames?: string[],
  budget?: IterationBudget,
  goalTimeoutMs?: number,
  signal?: AbortSignal,
): Promise<ExecutionResult> {
  const results: Record<string, GoalResult> = {};
  let totalToolCalls = 0;
  const allToolNames: string[] = [];
  let totalToolFailures = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  const maxIterations = graph.size * 4 + 1;

  for (let i = 0; i < maxIterations; i++) {
    // Update blocked goals
    graph.getBlocked();

    const ready = graph.getReady();
    if (ready.length === 0) break;

    // Mark ready goals as in_progress
    for (const goal of ready) {
      graph.updateStatus(goal.id, GoalStatus.IN_PROGRESS);
    }

    // Build context from completed goals
    const contextStr = buildContextFromResults(results);

    // Check budget or abort before executing batch
    if (budget && budget.remaining === 0) break;
    if (signal?.aborted) break;

    // Execute concurrently
    const settled = await Promise.allSettled(
      ready.map((goal) =>
        executeGoal(goal, contextStr, toolNames, budget, goalTimeoutMs, signal),
      ),
    );

    for (let j = 0; j < ready.length; j++) {
      const goal = ready[j];
      const outcome = settled[j];

      const goalResult: GoalResult =
        outcome.status === "fulfilled"
          ? outcome.value
          : {
              goalId: goal.id,
              ok: false,
              error: String(outcome.reason),
              durationMs: 0,
              toolCalls: 0,
              toolNames: [],
              toolFailures: 1,
              tokenUsage: { promptTokens: 0, completionTokens: 0 },
            };

      results[goal.id] = goalResult;
      totalToolCalls += goalResult.toolCalls;
      allToolNames.push(...goalResult.toolNames);
      totalToolFailures += goalResult.toolFailures;
      totalPromptTokens += goalResult.tokenUsage.promptTokens;
      totalCompletionTokens += goalResult.tokenUsage.completionTokens;

      if (goalResult.ok) {
        graph.updateStatus(goal.id, GoalStatus.COMPLETED);
      } else {
        graph.updateStatus(goal.id, GoalStatus.FAILED);
      }
    }
  }

  return {
    goalResults: results,
    summary: graph.summary(),
    totalToolCalls,
    totalToolNames: allToolNames,
    totalToolFailures,
    tokenUsage: {
      promptTokens: totalPromptTokens,
      completionTokens: totalCompletionTokens,
    },
  };
}
