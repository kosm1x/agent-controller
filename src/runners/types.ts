/**
 * Shared types for all runner implementations.
 */

import type { RunnerStatus } from "./status.js";

/** Agent/runner type identifiers. */
export type AgentType = "fast" | "nanoclaw" | "heavy" | "swarm" | "a2a";

/** A prior conversation exchange for thread continuity. */
export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
  imageUrl?: string; // Base64 data URL for vision (user turns only)
}

/** Input passed to a runner when executing a task. */
export interface RunnerInput {
  /** Unique task identifier. */
  taskId: string;
  /** Unique run identifier. */
  runId: string;
  /** Task title. */
  title: string;
  /** Task description / instructions. */
  description: string;
  /** Tool names the task requested. */
  tools?: string[];
  /** Extra input data (JSON). */
  input?: unknown;
  /** Parent task ID (for swarm sub-tasks). */
  parentTaskId?: string;
  /** Recommended model tier from classifier. */
  modelTier?: string;
  /** Prior conversation turns for thread continuity. */
  conversationHistory?: ConversationTurn[];
  /** Streaming callback — receives text chunks as the LLM generates them. */
  onTextChunk?: (text: string) => void;
  /** Abort signal for task cancellation (v6.2 S2). */
  signal?: AbortSignal;
  /** Whether the task has an interactive user for confirmation prompts.
   *  Defaults to true. Scheduled tasks / rituals set false. */
  interactive?: boolean;
}

/**
 * Canonical structured result shape (V8.5 Phase 4.2). Field semantics are a
 * CONTRACT with the delivery layer (src/lib/deliverable.ts):
 *
 * - `finalAnswer` — the agent's actual report; THE deliverable. Runners
 *   whose loop separates work from reflection (heavy/nanoclaw/swarm) MUST
 *   set it (null when no goal produced text).
 * - `text`       — fast-runner / fast-path deliverable.
 * - `content`    — reflector meta-summary ABOUT the work. Never user-facing
 *   while a deliverable field exists; last-resort fallback only.
 *
 * History: three delivery incidents (07-11 heavy, 07-12 nanoclaw ×2) came
 * from producers omitting `finalAnswer` or consumers walking these fields
 * in ad-hoc orders. New runners: populate `finalAnswer` or `text`, never
 * only `content`.
 */
export interface RunnerStructuredOutput {
  text?: string;
  content?: string;
  finalAnswer?: string | null;
  score?: number;
  learnings?: string[];
  [extra: string]: unknown;
}

/** Output returned by a runner after execution. */
export interface RunnerOutput {
  /** Whether the task succeeded. */
  success: boolean;
  /** Structured status providing nuance beyond success/failure. */
  status?: RunnerStatus;
  /** Concerns when status is DONE_WITH_CONCERNS. */
  concerns?: string[];
  /** Result content — a string deliverable or the canonical structured shape. */
  output?: RunnerStructuredOutput | string;
  /** Error message if failed. */
  error?: string;
  /**
   * Token usage for this run.
   *
   * `promptTokens` is the TOTAL input count (raw input + cache-creation +
   * cache-read under the claude-sdk path). `cacheReadTokens` and
   * `cacheCreationTokens` break out the cache portions so cache hit ratio
   * can be derived downstream. The openai-path leaves cache fields at 0.
   *
   * `actualModel` is the exact model ID the inference layer actually
   * invoked (e.g. "claude-sonnet-4-6"). When set, the dispatcher prefers
   * it over the config-derived label so cost_ledger attribution is correct
   * even when `cfg.inferencePrimaryModel` is stale from a prior provider.
   *
   * `actualCostUsd` is the cost reported directly by the provider (e.g.
   * Anthropic SDK's `total_cost_usd`). Preferred over `calculateCost()`
   * when present since Max-auth subscriptions report $0 faithfully while
   * local pricing tables would overstate.
   */
  tokenUsage?: {
    promptTokens: number;
    completionTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    actualModel?: string;
    actualCostUsd?: number;
  };
  /** Execution duration in milliseconds. */
  durationMs: number;
  /** Goal graph JSON (heavy/swarm runners). */
  goalGraph?: unknown;
  /** Execution trace entries. */
  trace?: unknown[];
  /** Tool names called during execution (for requiredTools validation). */
  toolCalls?: string[];
}

/** Interface that all runners implement. */
export interface Runner {
  readonly type: AgentType;
  execute(input: RunnerInput): Promise<RunnerOutput>;
}
