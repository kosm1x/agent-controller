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
  /**
   * v8 S4 phase 2: Anthropic prompt-cache breakdown. Optional so existing
   * literal initializers (`{ promptTokens: 0, completionTokens: 0 }`)
   * remain valid; producers populate when the underlying SDK call returned
   * cache info. Sums use `?? 0` to propagate defensively.
   */
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export interface GoalResult {
  goalId: string;
  ok: boolean;
  result?: string;
  error?: string;
  durationMs: number;
  toolCalls: number;
  toolNames: string[];
  toolFailures: number;
  tokenUsage: TokenUsage;
  /** Number of self-assessment reflection rounds used (0 = passed first try). */
  selfAssessRounds?: number;
  toolRepairs?: Array<{ original: string; repaired: string }>;
  /** Provenance records extracted from this goal's research tool calls. */
  provenanceRecords?: Array<{
    tool_name: string;
    url: string | null;
    query: string | null;
    status: "verified" | "inferred" | "unverified";
    snippet: string | null;
  }>;
  /** Condensed search summary (when 3+ queries triggered condensation). */
  provenanceSummary?: string;
}

export interface ExecutionResult {
  goalResults: Record<string, GoalResult>;
  summary: Record<string, number>;
  totalToolCalls: number;
  totalToolNames: string[];
  totalToolFailures: number;
  tokenUsage: TokenUsage;
  toolRepairs: Array<{ original: string; repaired: string }>;
  /** Aggregated provenance records across all goals. */
  provenanceRecords?: Array<{
    goalId: string;
    tool_name: string;
    url: string | null;
    query: string | null;
    status: "verified" | "inferred" | "unverified";
    snippet: string | null;
  }>;
}

// ---------------------------------------------------------------------------
// Reflection types
// ---------------------------------------------------------------------------

export interface ReflectionResult {
  success: boolean;
  score: number;
  learnings: string[];
  summary: string;
  /** Source anchoring score (0-1): fraction of cited URLs that were verified/fetched. */
  anchoringScore?: number;
  /** Per-goal convergence data (Hermes H1). Populated when any goal triggered looping. */
  convergenceData?: Array<{
    goalId: string;
    score: number;
    looping: boolean;
  }>;
  /** Tool efficiency metrics from trace layer (Hermes H2). */
  traceEfficiency?: {
    efficiency: number;
    tokenBurnRate: number;
    avgConvergence: number;
  };
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
    /** Max tool calls / graph size ratio before triggering convergence replan. */
    toolCallsPerGoal: number;
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
      toolCallsPerGoal: 10.0,
    },
    ...overrides,
  };
}

/**
 * Strip markdown code fences and parse JSON from LLM output.
 *
 * Tolerates three shapes:
 *   1. Bare JSON: `{...}`
 *   2. Fenced JSON: `` ```json\n{...}\n``` ``
 *   3. CoT-prefixed JSON: reasoning text followed by a bare or fenced JSON object
 *
 * Shape (3) is required for autoreason-style chain-of-thought judges: the
 * model reasons step-by-step, then emits a JSON verdict at the end. Direct
 * JSON.parse fails on leading prose, so we fall back to brace-scanning.
 *
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
  } catch {
    // Fallback: extract the last JSON object from CoT-prefixed output.
    const extracted = extractLastJsonObject(text);
    if (extracted !== null) {
      try {
        return JSON.parse(extracted) as T;
      } catch (err) {
        throw new Error(
          `LLM returned invalid JSON (after extraction): ${err instanceof Error ? err.message : err}\n` +
            `Extracted (first 500 chars): ${extracted.slice(0, 500)}`,
        );
      }
    }
    throw new Error(
      `LLM returned no parseable JSON object.\nRaw (first 500 chars): ${text.slice(0, 500)}`,
    );
  }
}

/**
 * Scan for the last balanced `{...}` object in a string. Walks the string
 * tracking brace depth; once depth returns to 0 we have a candidate object.
 * Returns the last such object (closest to end of string), or null if none.
 *
 * String literals are honored (braces inside quoted strings don't count),
 * with backslash-escape awareness.
 */
function extractLastJsonObject(text: string): string | null {
  let lastObject: string | null = null;
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        lastObject = text.slice(start, i + 1);
        start = -1;
      }
    }
  }

  return lastObject;
}

/**
 * Convergence score for a single goal (Hermes H1).
 * ratio = totalToolCalls / uniqueTools.
 * High ratio (>3.0) = goal is looping over the same tools.
 * Pure function — no side effects, no latency.
 */
export function convergenceScore(
  toolCalls: number,
  uniqueTools: number,
): { score: number; looping: boolean } {
  if (toolCalls === 0 || uniqueTools === 0) {
    return { score: 0, looping: false };
  }
  const score = toolCalls / uniqueTools;
  return { score, looping: score > 3.0 };
}
