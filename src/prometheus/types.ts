/**
 * Prometheus Core — Shared types, enums, and utilities.
 */

// ---------------------------------------------------------------------------
// Enums (as const objects — idiomatic modern TS)
// ---------------------------------------------------------------------------

export const GoalStatus = {
  PENDING: "pending",
  IN_PROGRESS: "in_progress",
  COMPLETED: "completed",
  BLOCKED: "blocked",
  FAILED: "failed",
} as const;
export type GoalStatus = (typeof GoalStatus)[keyof typeof GoalStatus];

export const Phase = {
  PLAN: "plan",
  EXECUTE: "execute",
  REFLECT: "reflect",
} as const;
export type Phase = (typeof Phase)[keyof typeof Phase];

export const ErrorStrategy = {
  RETRY: "retry",
  ESCALATE: "escalate",
} as const;
export type ErrorStrategy = (typeof ErrorStrategy)[keyof typeof ErrorStrategy];

// ---------------------------------------------------------------------------
// Goal graph types
// ---------------------------------------------------------------------------

export interface Goal {
  id: string;
  description: string;
  status: GoalStatus;
  completionCriteria: string[];
  parentId: string | null;
  dependsOn: string[];
  children: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Execution types
// ---------------------------------------------------------------------------

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface GoalResult {
  goalId: string;
  ok: boolean;
  result?: string;
  error?: string;
  durationMs: number;
  toolCalls: number;
  toolFailures: number;
  tokenUsage: TokenUsage;
}

export interface ExecutionResult {
  goalResults: Record<string, GoalResult>;
  summary: Record<string, number>;
  totalToolCalls: number;
  totalToolFailures: number;
  tokenUsage: TokenUsage;
}

// ---------------------------------------------------------------------------
// Reflection types
// ---------------------------------------------------------------------------

export interface ReflectionResult {
  success: boolean;
  score: number;
  learnings: string[];
  summary: string;
}

// ---------------------------------------------------------------------------
// Orchestrator types
// ---------------------------------------------------------------------------

export interface OrchestratorConfig {
  maxTurns: number;
  maxReplans: number;
  maxIterations: number;
  timeoutMs: number;
  goalTimeoutMs: number;
  replanThresholds: {
    toolFailureRate: number;
    goalBlocked: boolean;
  };
}

export interface TraceEvent {
  type: string;
  timestamp: number;
  [key: string]: unknown;
}

export interface RunTrace {
  traceId: string;
  events: TraceEvent[];
  startTime: number;
  endTime: number | null;
  totalToolCalls: number;
  totalToolFailures: number;
}

export interface OrchestratorResult {
  success: boolean;
  goalGraph: { goals: Record<string, Goal> };
  executionResults: ExecutionResult;
  reflection: ReflectionResult;
  trace: TraceEvent[];
  traceId: string;
  durationMs: number;
  tokenUsage: TokenUsage;
  iterationsUsed: number;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Default orchestrator config with optional overrides. */
export function defaultConfig(
  overrides?: Partial<OrchestratorConfig>,
): OrchestratorConfig {
  return {
    maxTurns: 50,
    maxReplans: 3,
    maxIterations: 90,
    timeoutMs: 600_000,
    goalTimeoutMs: 120_000,
    replanThresholds: {
      toolFailureRate: 0.5,
      goalBlocked: true,
    },
    ...overrides,
  };
}

/**
 * Strip markdown code fences and parse JSON from LLM output.
 * Throws with a descriptive error on failure.
 */
export function parseLLMJson<T = unknown>(raw: string): T {
  let text = raw.trim();

  // Strip opening fence: ```json or ```
  if (text.startsWith("```")) {
    const nl = text.indexOf("\n");
    if (nl !== -1) text = text.slice(nl + 1);
  }
  // Strip closing fence
  if (text.endsWith("```")) {
    text = text.slice(0, text.lastIndexOf("```"));
  }
  text = text.trim();

  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new Error(
      `LLM returned invalid JSON: ${err instanceof Error ? err.message : err}\n` +
        `Raw (first 500 chars): ${text.slice(0, 500)}`,
    );
  }
}
