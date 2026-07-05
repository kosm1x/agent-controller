/**
 * Prometheus Core — Shared types, enums, and utilities.
 */

import { errMsg } from "../lib/err-msg.js";

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
  /**
   * 2026-05-10 cutover audit C1 (round-2): SDK-reported model the underlying
   * inference call actually invoked. The wrapper at queryClaudeSdkComplexWith-
   * Fallback may swap Opus→Sonnet on plan-gate failure, so the goal-level
   * model is decided per-call, not per-task. Heavy/swarm aggregations take
   * the LAST non-empty model across rounds — sufficient for cost_ledger
   * attribution since dispatcher rolls up per-task. The dispatcher prefers
   * `result.tokenUsage.actualModel` over `getModelFromTask()` (which
   * hardcodes Sonnet under SDK mode).
   */
  actualModel?: string;
  /**
   * SDK-reported `total_cost_usd` summed across every inference call inside
   * a Prometheus run (plan + replan + executor goal calls + selfAssess +
   * retry + reflect). Heavy/swarm surface this to dispatcher as
   * `actualCostUsd` so cost_ledger reflects real billing instead of the
   * `calculateCost()` fallback which returns $0 for Claude models (those
   * defaults expect SDK to always surface the authoritative number, which
   * only the fast-runner chat branch was doing prior to this fix).
   */
  actualCostUsd?: number;
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
  /** Whether the goal's completion criteria were ultimately satisfied.
   * - true: selfAssess returned met=true on some round (or threw — selfAssess's
   *   catch path defaults to a met=true assessment to avoid spurious failure
   *   when the judge LLM itself is unavailable).
   * - false: every selfAssess round through MAX_SELF_ASSESS returned met=false;
   *   the goal still returns ok=true (best-effort) but the reflector reads
   *   this so the orchestrator's success gate sees the truth instead of the
   *   "4/4 completed" heuristic masking it.
   * - undefined: not assessed — the goal had no completionCriteria (nothing
   *   to verify). */
  criteriaMet?: boolean;
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

/**
 * Per-dimension critique with evidence (RationalRewards pattern, v7.5 L3).
 *
 * Replaces "goal failed" with "Dimension X scored 0.4 because <evidence>".
 * Lets the planner target the lowest-scoring dimension on replan instead of
 * re-trying the entire goal graph blind.
 *
 * Dimensions match the 5-axis prompt in `reflector.ts`:
 *   completion       — goals reached usable output
 *   correctness      — goals failed/produced empty results (inverse axis)
 *   evidence_quality — claims defensible from observed tool evidence
 *   effort           — work appropriate for task (not bloated/thin)
 *   domain_coverage  — domain-knowledge map concepts addressed (when available)
 */
export interface DimensionalCritique {
  dimension:
    | "completion"
    | "correctness"
    | "evidence_quality"
    | "effort"
    | "domain_coverage";
  score: number; // 0.0 to 1.0
  evidence: string; // citation / justification
}

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
  /**
   * Per-dimension critiques (v7.5 L3 / RationalRewards). Optional —
   * populated when the LLM emits a `dimensions` array in its JSON output.
   * Absent for heuristic-only reflections and pre-L3 callers.
   */
  dimensions?: DimensionalCritique[];
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
/**
 * Typed error for parseLLMJson failures. The user-safe `.message` is generic
 * and never carries raw LLM content. The raw content is attached as a
 * separate field so operators (in journalctl) can still diagnose, but it
 * never propagates to user-visible error surfaces.
 *
 * History (v7.6 Spine 1 G8): the previous Error subclass embedded "Raw
 * (first 500 chars): ..." directly in the message. That message rode the
 * `Planning failed: ${err.message}` chain through `task.failed` events and
 * surfaced verbatim to users in router.ts:2321 (background-agent failures)
 * and rituals/dynamic.ts:574 (scheduled-task broadcasts). Same prompt-
 * enhancer-leakage class as the original CIRICD bug — error path leaking
 * unparsed LLM output.
 */
export class LLMJsonParseError extends Error {
  /** Raw LLM output (first 500 chars). Operator-visible only — never user-facing. */
  readonly rawSample: string;
  /** Stage at which parsing failed. Helps disambiguate in logs. */
  readonly stage: "no-object" | "extracted-invalid";
  /** Underlying JSON parse error message, if any. */
  readonly innerMessage: string | undefined;

  constructor(opts: {
    stage: "no-object" | "extracted-invalid";
    rawSample: string;
    innerMessage?: string;
  }) {
    // User-safe message — generic, no raw content.
    super("LLM returned unparseable JSON");
    this.name = "LLMJsonParseError";
    this.stage = opts.stage;
    this.rawSample = opts.rawSample;
    this.innerMessage = opts.innerMessage;
  }

  /**
   * Operator-only diagnostic detail. Returns the raw sample + inner message
   * formatted for journalctl. NEVER call this from a user-facing surface.
   */
  diagnosticDetail(): string {
    const inner = this.innerMessage ? ` (${this.innerMessage})` : "";
    return `[${this.stage}]${inner} sample: ${this.rawSample}`;
  }
}

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
        throw new LLMJsonParseError({
          stage: "extracted-invalid",
          rawSample: extracted.slice(0, 500),
          innerMessage: errMsg(err),
        });
      }
    }
    throw new LLMJsonParseError({
      stage: "no-object",
      rawSample: text.slice(0, 500),
    });
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
