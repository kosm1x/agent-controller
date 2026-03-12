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
import { GoalStatus, ErrorStrategy } from "./types.js";
import type { Goal, GoalResult, ExecutionResult } from "./types.js";

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

function buildGoalPrompt(goal: Goal, context: string): string {
  const criteria =
    goal.completionCriteria.length > 0
      ? goal.completionCriteria.map((c, i) => `  ${i + 1}. ${c}`).join("\n")
      : "  (no specific criteria — use best judgment)";

  return (
    `You are executing a single goal as part of a larger plan. Use the available tools to achieve the goal.\n\n` +
    `## Goal\n${goal.description}\n\n` +
    `## Completion Criteria\n${criteria}\n\n` +
    (context ? `## Context from completed goals\n${context}\n\n` : "") +
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
): Promise<GoalResult> {
  const start = Date.now();

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const systemPrompt = buildGoalPrompt(goal, context);
      const messages: ChatMessage[] = [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Execute this goal: ${goal.description}` },
      ];

      const definitions = toolRegistry.getDefinitions(toolNames);
      const result = await inferWithTools(
        messages,
        definitions,
        (name, args) => toolRegistry.execute(name, args),
        MAX_ROUNDS_PER_GOAL,
      );

      // Count tool calls from the conversation
      const tcCount = result.messages.filter((m) => m.role === "tool").length;

      return {
        goalId: goal.id,
        ok: true,
        result: result.content,
        durationMs: Date.now() - start,
        toolCalls: tcCount,
        toolFailures: 0,
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
        toolFailures: 1,
      };
    }
  }

  return {
    goalId: goal.id,
    ok: false,
    error: "Max retries exceeded",
    durationMs: Date.now() - start,
    toolCalls: 0,
    toolFailures: 1,
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
): Promise<ExecutionResult> {
  const results: Record<string, GoalResult> = {};
  let totalToolCalls = 0;
  let totalToolFailures = 0;
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

    // Execute concurrently
    const settled = await Promise.allSettled(
      ready.map((goal) => executeGoal(goal, contextStr, toolNames)),
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
              toolFailures: 1,
            };

      results[goal.id] = goalResult;
      totalToolCalls += goalResult.toolCalls;
      totalToolFailures += goalResult.toolFailures;

      if (goalResult.ok) {
        graph.updateStatus(goal.id, GoalStatus.COMPLETED);
      } else {
        graph.updateStatus(goal.id, GoalStatus.FAILED);
        totalToolFailures++;
      }
    }
  }

  return {
    goalResults: results,
    summary: graph.summary(),
    totalToolCalls,
    totalToolFailures,
  };
}
