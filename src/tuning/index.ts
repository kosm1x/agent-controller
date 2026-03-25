/**
 * Jarvis self-tuning system — entry point.
 *
 * Ensures tuning tables exist and re-exports public API.
 */

export { ensureTuningTables } from "./schema.js";
export type {
  TestCase,
  TestCaseCategory,
  TestCaseInput,
  TestCaseExpected,
  SandboxConfig,
  ScopePattern,
  EvalResult,
  EvalSubscores,
  CaseScore,
  Mutation,
  Experiment,
  TuneRun,
  TuningSurface,
  EvalFilter,
} from "./types.js";
export { METRIC_WEIGHTS, EST_COST_PER_INFERENCE_USD } from "./types.js";
