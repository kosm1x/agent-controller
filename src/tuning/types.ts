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
  | "tool_selection"
  | "scope_accuracy"
  | "classification";

export interface TestCaseInput {
  message: string;
  conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface TestCaseExpected {
  /** Tools that SHOULD be called (tool_selection). */
  tools?: string[];
  /** Tools that MUST NOT be called (tool_selection). */
  not_tools?: string[];
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
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export interface CaseScore {
  caseId: string;
  category: TestCaseCategory;
  score: number; // 0.0 - 1.0
  details: Record<string, unknown>;
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
}

// ---------------------------------------------------------------------------
// Experiments
// ---------------------------------------------------------------------------

export type TuningSurface =
  | "tool_description"
  | "scope_rule"
  | "classifier"
  | "prompt";

export type ExperimentStatus = "pending" | "passed" | "regressed" | "error";

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
}

export type ParentSelectionStrategy = "best" | "latest" | "score_prop";
