/**
 * Shared types for all runner implementations.
 */

/** Agent/runner type identifiers. */
export type AgentType = "fast" | "nanoclaw" | "heavy" | "swarm";

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
}

/** Output returned by a runner after execution. */
export interface RunnerOutput {
  /** Whether the task succeeded. */
  success: boolean;
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
}

/** Interface that all runners implement. */
export interface Runner {
  readonly type: AgentType;
  execute(input: RunnerInput): Promise<RunnerOutput>;
}
