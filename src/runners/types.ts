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
}

/** Output returned by a runner after execution. */
export interface RunnerOutput {
  /** Whether the task succeeded. */
  success: boolean;
  /** Structured status providing nuance beyond success/failure. */
  status?: RunnerStatus;
  /** Concerns when status is DONE_WITH_CONCERNS. */
  concerns?: string[];
  /** Result content (text, structured data). */
  output?: unknown;
  /** Error message if failed. */
  error?: string;
  /** Token usage for this run. */
  tokenUsage?: {
    promptTokens: number;
    completionTokens: number;
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
