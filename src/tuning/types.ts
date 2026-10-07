/**
 * Shared types for the Jarvis self-tuning system.
 *
 * Inspired by Karpathy's autoresearch: autonomous overnight experiment loop
 * that modifies config surfaces, evaluates against a composite metric,
 * keeps improvements, and discards regressions.
 */

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

export type TestCaseCategory =
  "tool_selection" | "scope_accuracy" | "classification";

export interface TestCaseInput {
  message: string;
  conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface TestCaseExpected {
  /** Tools that SHOULD be called (tool_selection). */
  tools?: string[];
  /** Tools that MUST NOT be called (tool_selection). */
  not_tools?: string[];
  /**
   * The tool the mined run called FIRST (tool_selection). Recorded for future
   * use only: the evaluator IGNORES it until round boundaries are recorded
   * (without them it is one arbitrary tool of a possibly parallel first
   * round). Written by the miner for rows mined after 2026-10-04.
   */
  first_tools?: string[];
  /** Expected agent type (classification). */
  agent_type?: string;
  /** Expected scope groups to be active (scope_accuracy). */
  scope_groups?: string[];
  /** Scope groups that MUST NOT be active (scope_accuracy). */
  not_scope_groups?: string[];
}

export interface TestCase {
  case_id: string;
  category: TestCaseCategory;
  input: TestCaseInput;
  expected: TestCaseExpected;
  weight: number;
  source: "manual" | "mined" | "generated";
  active: boolean;
  /**
   * Which population the case came from (eval-gate breakdown): `seed` =
   * tune_test_cases rows, `mined` / `flywheel` = mined_test_cases rows by
   * source. Set by getActiveTestCases; absent = seed.
   */
  sourceGroup?: CaseSourceGroup;
}

export type CaseSourceGroup = "seed" | "mined" | "flywheel";

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export interface CaseScore {
  caseId: string;
  category: TestCaseCategory;
  score: number; // 0.0 - 1.0
  weight?: number; // from TestCase.weight (defaults to 1.0 if missing)
  details: Record<string, unknown>;
  /**
   * tool_selection only: the case expects tools but NONE of them was offered
   * to the model (not registered in the eval process, or scoped out). Such a
   * case is never probed and never scored — it lives in
   * `EvalResult.reachability.excludedCases`, not in `perCase`.
   */
  excluded?: boolean;
}

/**
 * Who could the model have picked? Expected-tool slots of every probed or
 * excluded tool_selection case, split by whether the tool was offered.
 * Printed by the eval gate on every run so a shrinking scored population is
 * visible, never silent.
 */
export interface ToolReachability {
  /** tool_selection cases with expected tools, none offered — not scored. */
  casesExcluded: number;
  /** The excluded cases themselves (score 0, `excluded: true`; never averaged). */
  excludedCases: CaseScore[];
  /** Expected-tool slots that were offered to the model. */
  slotsOffered: number;
  /** Expected-tool slots naming a tool the eval process never registered. */
  slotsNotRegistered: number;
  /** Expected-tool slots registered but cut by message scoping. */
  slotsScopedOut: number;
}

export interface EvalSubscores {
  toolSelection: number; // 0-100
  scopeAccuracy: number; // 0-100
  classification: number; // 0-100
}

export interface EvalResult {
  compositeScore: number; // 0-100
  subscores: EvalSubscores;
  perCase: CaseScore[];
  /** Offered/unreachable expected-tool accounting (tool_selection). */
  reachability: ToolReachability;
  totalTokens: number;
  estimatedCostUsd: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Sandbox configuration
// ---------------------------------------------------------------------------

export interface ScopePattern {
  pattern: RegExp;
  group: string;
}

export interface SandboxConfig {
  /** Override tool descriptions: toolName → new description text. */
  toolDescriptionOverrides?: Map<string, string>;
  /** Override scope patterns (replaces the default SCOPE_PATTERNS). */
  scopePatternOverrides?: ScopePattern[];
  /**
   * OPTIONAL system message for the tool_selection probe, built from the
   * names of the tools offered to that case. Off by default: the default
   * probe sends no system message (the claude-sdk path then substitutes its
   * generic "You are a helpful assistant."). Experiment-only for now.
   */
  probeSystemPrompt?: (offeredToolNames: string[]) => string;
  /**
   * Model rounds per tool_selection probe (integer 1-5; absent = 1). Tools
   * never execute: rounds after the first see a simulated success. A case
   * hits when an expected tool is called in ANY round. The eval gate uses 3;
   * the overnight tuning loop stays on 1.
   */
  probeRounds?: number;
}

// ---------------------------------------------------------------------------
// Experiments
// ---------------------------------------------------------------------------

export type TuningSurface =
  "tool_description" | "scope_rule" | "classifier" | "prompt";

export type ExperimentStatus =
  "pending" | "passed" | "regressed" | "rejected" | "error";

export interface Mutation {
  surface: TuningSurface;
  target: string; // e.g. "web_search" or "SCOPE_PATTERNS.coding"
  mutation_type: "rewrite" | "adjust";
  mutated_value: string;
  hypothesis: string;
}

export interface Experiment {
  experiment_id: string;
  run_id: string;
  surface: TuningSurface;
  target: string;
  mutation_type: string;
  original_value: string;
  mutated_value: string;
  hypothesis: string;
  baseline_score: number | null;
  mutated_score: number | null;
  status: ExperimentStatus;
  /** SQLite `datetime('now')` string; populated by the DB on INSERT. */
  created_at?: string;
  /** v7.5: SkillClaw-style failure source on non-pass. Null on pass. */
  failure_source?: FailureSource | null;
  /** v7.5: GEPA-style confidence avg (per-case score stddev proxy, 0-1). */
  confidence_avg?: number | null;
}

// ---------------------------------------------------------------------------
// Overnight runs
// ---------------------------------------------------------------------------

export type RunStatus = "running" | "completed" | "aborted" | "budget_exceeded";

export interface TuneRun {
  run_id: string;
  status: RunStatus;
  baseline_score: number | null;
  best_score: number | null;
  experiments_run: number;
  experiments_won: number;
  total_cost_usd: number;
  report: string | null;
  started_at: string;
  completed_at: string | null;
}

// ---------------------------------------------------------------------------
// Eval runner config
// ---------------------------------------------------------------------------

export interface EvalFilter {
  category?: TestCaseCategory;
  caseIds?: string[];
}

// ---------------------------------------------------------------------------
// Metric weights
// ---------------------------------------------------------------------------

export const METRIC_WEIGHTS = {
  toolSelection: 0.5,
  scopeAccuracy: 0.3,
  classification: 0.2,
} as const;

/** Estimated cost per LLM inference call in USD (DashScope). */
export const EST_COST_PER_INFERENCE_USD = 0.03;

// ---------------------------------------------------------------------------
// Variant archive (HyperAgents evolutionary pattern)
// ---------------------------------------------------------------------------

export interface TuneVariant {
  variant_id: string;
  parent_id: string | null;
  run_id: string;
  generation: number;
  config_json: string;
  composite_score: number;
  subscores_json: string | null;
  valid: boolean;
  activated_at: string | null;
  created_at: string;
  /**
   * sha256 of the pristine code scope patterns for the groups this variant
   * overrides, taken at generation (fingerprint.ts). NULL = legacy row.
   */
  code_fingerprint?: string | null;
}

// ---------------------------------------------------------------------------
// v7.5 additions — failure classification + confidence signals
// ---------------------------------------------------------------------------

/**
 * Failure-source classification for regressed/errored experiments.
 * Adopted from SkillClaw (arXiv:2604.08377) — distinguishes whether the
 * mutation itself was bad (skill), the agent misused a good mutation (agent),
 * or infra failed (env).
 */
export type FailureSource = "skill" | "agent" | "env";
