/**
 * Executor — Dependency-ordered goal execution using inferWithTools.
 *
 * Each goal gets its own LLM + tool loop. The LLM autonomously selects tools,
 * interprets results, and iterates until the goal is achieved or fails.
 * Ready goals execute concurrently via Promise.allSettled.
 */

import { infer, inferWithTools } from "../inference/adapter.js";
import type { ChatMessage } from "../inference/adapter.js";
import {
  queryClaudeSdkAsInfer,
  queryClaudeSdkAsInferWithTools,
} from "../inference/claude-sdk.js";
import { CB_COOLDOWN_MS } from "../config/constants.js";
import { getConfig } from "../config.js";
import { toolRegistry } from "../tools/registry.js";
import { GoalGraph } from "./goal-graph.js";
import { IterationBudget } from "./budget.js";
import { GoalStatus, ErrorStrategy, parseLLMJson } from "./types.js";
import type { Goal, GoalResult, ExecutionResult } from "./types.js";
import { getMemoryService } from "../memory/index.js";
import {
  extractProvenance,
  classifySources,
  condenseSearchResults,
} from "./provenance.js";

// v7.9 Prometheus Sonnet port — see planner.ts for the rationale.
function useSdkPath(): boolean {
  return getConfig().inferencePrimaryProvider === "claude-sdk";
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_RETRIES = 3;
const MAX_ROUNDS_PER_GOAL = 10;
const MAX_SELF_ASSESS = 2;
// CCP8: Increased context for synthesis mandate — prior goals carry
// more detail (file paths, function names) to inform dependent goals.
const CONTEXT_MAX_GOALS = 8;
const CONTEXT_MAX_CHARS = 2000;

const TRANSIENT_PATTERNS = [
  "timeout",
  "timed out",
  "rate limit",
  "429",
  "503",
  "connection reset",
  "connection refused",
  "eagain",
  // Dim-4 round-2 C-RES-4 fix: when the claude-sdk breaker is HALF_OPEN,
  // exactly one concurrent caller wins the probe slot and the others throw
  // "Circuit breaker OPEN". Prometheus fan-out (executeGraph Promise.allSettled)
  // hits this pattern on every post-outage recovery. Treat it as transient so
  // the losing goals retry instead of escalating to permanent failure.
  "circuit breaker",
];

/** Error fragment marking a breaker OPEN rejection — matched for backoff sizing. */
const BREAKER_OPEN_TOKEN = "circuit breaker open";

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
// Self-assessment — checks if goal output satisfies completion criteria
// ---------------------------------------------------------------------------

const SELF_ASSESS_SYSTEM = `You evaluate whether a goal's output satisfies its completion criteria.

Think step by step before deciding. For each criterion, write one short sentence answering:
1. What concrete evidence in the output addresses this specific criterion?
2. Is the evidence direct and verifiable, or is the criterion only partially or vaguely addressed?
3. Would a strict reviewer accept this as "met" or flag it as incomplete?

After the reasoning, emit EXACTLY ONE JSON object as the FINAL content of your response:
{
  "met": true,
  "unmetCriteria": [],
  "reasoning": "brief explanation"
}

Rules:
- met = true only if ALL criteria are satisfied by the output.
- unmetCriteria = list of criteria strings that were NOT satisfied.
- Be strict: vague or partial satisfaction counts as not met.
- The reasoning above can be any prose. Only the final JSON object is consumed.
- Do NOT wrap the JSON in markdown fences. Emit it bare at the end of your response.`;

interface SelfAssessment {
  met: boolean;
  unmetCriteria: string[];
  reasoning: string;
}

interface SelfAssessResult {
  assessment: SelfAssessment | null;
  usage: { promptTokens: number; completionTokens: number };
}

/**
 * Lightweight LLM check: does the goal result satisfy its completion criteria?
 * Returns null assessment if the goal has no criteria (skip assessment).
 * Always returns token usage for cost tracking.
 */
export async function selfAssess(
  goal: Goal,
  resultText: string,
): Promise<SelfAssessResult> {
  if (goal.completionCriteria.length === 0) {
    return {
      assessment: null,
      usage: { promptTokens: 0, completionTokens: 0 },
    };
  }

  const userContent =
    `## Goal\n${goal.description}\n\n` +
    `## Completion Criteria\n${goal.completionCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}\n\n` +
    `## Goal Output\n${resultText.length > 2000 ? resultText.slice(0, 2000) + "..." : resultText}`;

  try {
    const selfAssessMessages: ChatMessage[] = [
      { role: "system", content: SELF_ASSESS_SYSTEM },
      { role: "user", content: userContent },
    ];
    const response = useSdkPath()
      ? await queryClaudeSdkAsInfer(selfAssessMessages)
      : await infer({ messages: selfAssessMessages, temperature: 0.1 });
    const usage = {
      promptTokens: response.usage.prompt_tokens,
      completionTokens: response.usage.completion_tokens,
    };
    const raw = parseLLMJson<Partial<SelfAssessment>>(response.content ?? "");
    // Shape guard: ensure required fields have safe defaults
    const assessment: SelfAssessment = {
      met: typeof raw.met === "boolean" ? raw.met : true,
      unmetCriteria: Array.isArray(raw.unmetCriteria) ? raw.unmetCriteria : [],
      reasoning: typeof raw.reasoning === "string" ? raw.reasoning : "",
    };
    return { assessment, usage };
  } catch (err) {
    console.warn(
      `[executor] Self-assessment failed for ${goal.id}: ${err instanceof Error ? err.message : err}; assuming met`,
    );
    return {
      assessment: {
        met: true,
        unmetCriteria: [],
        reasoning: "Assessment failed — assuming met",
      },
      usage: { promptTokens: 0, completionTokens: 0 },
    };
  }
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

      const TOKEN_BUDGET_HEAVY = 80_000;
      const compressionContext = [
        `Current goal: ${goal.description}`,
        `Criteria: ${goal.completionCriteria.join("; ")}`,
      ].join("\n");
      const inferPromise = useSdkPath()
        ? queryClaudeSdkAsInferWithTools(
            messages,
            definitions,
            (name, args) => toolRegistry.execute(name, args),
            {
              maxRounds: MAX_ROUNDS_PER_GOAL,
              signal,
              tokenBudget: TOKEN_BUDGET_HEAVY,
              compressionContext,
            },
          )
        : inferWithTools(
            messages,
            definitions,
            (name, args) => toolRegistry.execute(name, args),
            {
              maxRounds: MAX_ROUNDS_PER_GOAL,
              signal,
              tokenBudget: TOKEN_BUDGET_HEAVY,
              compressionContext,
            },
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

      // Collect tool repairs from inference
      const allRepairs = [...result.toolRepairs];

      // Extract tool call names and count from the conversation
      const tcNames: string[] = [];
      for (const m of result.messages) {
        if (m.role === "assistant" && m.tool_calls) {
          for (const tc of m.tool_calls) {
            tcNames.push(tc.function.name);
          }
        }
      }

      // --- Self-assessment loop (ACE-inspired) ---
      // Check if the result satisfies completion criteria. If not,
      // inject reflection and re-run with the existing conversation.
      let finalContent = result.content;
      let currentMessages = result.messages;
      let selfAssessRounds = 0;
      let totalPrompt = result.totalUsage.prompt_tokens;
      let totalCompletion = result.totalUsage.completion_tokens;

      for (let round = 0; round < MAX_SELF_ASSESS; round++) {
        const { assessment, usage: assessUsage } = await selfAssess(
          goal,
          finalContent,
        );
        totalPrompt += assessUsage.promptTokens;
        totalCompletion += assessUsage.completionTokens;
        // null = no criteria to check, met = passed
        if (!assessment || assessment.met) break;

        selfAssessRounds++;
        console.log(
          `[executor] Goal ${goal.id} self-assessment round ${selfAssessRounds}: ` +
            `criteria not met — ${assessment.unmetCriteria.join("; ")}`,
        );

        // Inject reflection as a user message and re-run with tools
        const reflectionMsg: ChatMessage = {
          role: "user",
          content:
            `Your output did not satisfy these completion criteria:\n` +
            assessment.unmetCriteria
              .map((c: string, i: number) => `${i + 1}. ${c}`)
              .join("\n") +
            `\n\nAssessment: ${assessment.reasoning}\n\n` +
            `Reflect on what went wrong and try again. Use tools if needed.`,
        };

        const retryResult = useSdkPath()
          ? await queryClaudeSdkAsInferWithTools(
              [...currentMessages, reflectionMsg],
              definitions,
              (name, args) => toolRegistry.execute(name, args),
              {
                maxRounds: MAX_ROUNDS_PER_GOAL,
                signal,
                tokenBudget: TOKEN_BUDGET_HEAVY,
                compressionContext,
              },
            )
          : await inferWithTools(
              [...currentMessages, reflectionMsg],
              definitions,
              (name, args) => toolRegistry.execute(name, args),
              {
                maxRounds: MAX_ROUNDS_PER_GOAL,
                signal,
                tokenBudget: TOKEN_BUDGET_HEAVY,
                compressionContext,
              },
            );

        finalContent = retryResult.content;
        currentMessages = retryResult.messages;
        totalPrompt += retryResult.totalUsage.prompt_tokens;
        totalCompletion += retryResult.totalUsage.completion_tokens;
        allRepairs.push(...retryResult.toolRepairs);

        // Collect additional tool calls from retry
        for (const m of retryResult.messages) {
          if (m.role === "assistant" && m.tool_calls) {
            for (const tc of m.tool_calls) {
              tcNames.push(tc.function.name);
            }
          }
        }
      }

      if (selfAssessRounds > 0) {
        console.log(
          `[executor] Goal ${goal.id} completed after ${selfAssessRounds} self-assessment round(s)`,
        );
      }

      // --- Provenance extraction (S5c) ---
      let provenanceRecords: GoalResult["provenanceRecords"];
      let provenanceSummary: string | undefined;
      try {
        const extraction = extractProvenance(currentMessages);
        if (extraction.records.length > 0) {
          const classified = classifySources(extraction, finalContent);
          provenanceRecords = classified.map((r) => ({
            tool_name: r.tool_name,
            url: r.url,
            query: r.query,
            status: r.status,
            snippet: r.snippet,
          }));

          const condensed = await condenseSearchResults(
            extraction,
            currentMessages,
          );
          if (condensed) {
            provenanceSummary = condensed.summary;
            totalPrompt += condensed.usage.promptTokens;
            totalCompletion += condensed.usage.completionTokens;
          }
        }
      } catch (err) {
        console.warn(
          `[executor] Provenance extraction failed for ${goal.id}: ${err instanceof Error ? err.message : err}`,
        );
      }

      return {
        goalId: goal.id,
        ok: true,
        result: finalContent,
        durationMs: Date.now() - start,
        toolCalls: tcNames.length,
        toolNames: tcNames,
        toolFailures: 0,
        selfAssessRounds,
        toolRepairs: allRepairs,
        provenanceRecords,
        provenanceSummary,
        tokenUsage: {
          promptTokens: totalPrompt,
          completionTokens: totalCompletion,
        },
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const strategy = classifyError(errorMsg, attempt, MAX_RETRIES);

      if (strategy === ErrorStrategy.RETRY) {
        // Dim-4 round-2 C-RES-4 fix: when the breaker is OPEN and this throw
        // is from allowRequest()===false, the provider literally can't be
        // reached for another CB_COOLDOWN_MS. Exponential backoff tops out at
        // ~8s, so three retries inside the cooldown window just re-hit OPEN.
        // Jitter the cooldown by 0-5s to stagger fan-out probes after recovery.
        const isBreakerOpen = errorMsg
          .toLowerCase()
          .includes(BREAKER_OPEN_TOKEN);
        const delay = isBreakerOpen
          ? CB_COOLDOWN_MS + Math.floor(Math.random() * 5000)
          : Math.min(2 ** (attempt + 1) * 1000, 30_000);
        console.warn(
          `[executor] Goal ${goal.id} retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms: ${errorMsg}`,
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
  const allToolRepairs: Array<{ original: string; repaired: string }> = [];
  const allProvenanceRecords: NonNullable<
    ExecutionResult["provenanceRecords"]
  > = [];
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
      if (goalResult.toolRepairs)
        allToolRepairs.push(...goalResult.toolRepairs);
      if (goalResult.provenanceRecords) {
        allProvenanceRecords.push(
          ...goalResult.provenanceRecords.map((r) => ({
            goalId: goal.id,
            ...r,
          })),
        );
      }

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
    toolRepairs: allToolRepairs,
    provenanceRecords:
      allProvenanceRecords.length > 0 ? allProvenanceRecords : undefined,
  };
}
