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
  TuneVariant,
  TuningSurface,
  EvalFilter,
  ParentSelectionStrategy,
} from "./types.js";
export { METRIC_WEIGHTS, EST_COST_PER_INFERENCE_USD } from "./types.js";
export { activateBestVariant } from "./activation.js";
export { selectParent } from "./parent-selection.js";
export { serializeSandbox, deserializeSandbox } from "./variant-store.js";
