/**
 * V8.3 (Autonomous Execution Gates) — runtime flag.
 *
 * Read directly from `process.env` (NOT via getConfig(), which caches at boot)
 * so the operator can arm the pipeline with an env edit + restart and a test can
 * toggle it per-case. Mirrors the V8.2 flag convention in `src/lib/v8-2/flags.ts`.
 *
 * The Phase 2 pipeline ships DORMANT: this flag defaults OFF and there is no
 * call site yet (Phase 2 is unit-tested modules only). The eventual decision
 * trigger seam will gate on `isV83Enabled()`, exactly as `runJudgmentAssembly`
 * gates on `isV82ProducerEnabled()` in `src/triggers/morning-surface.ts`.
 */

/** True when the V8.3 decision pipeline is armed (may write the decision ledger). */
export function isV83Enabled(): boolean {
  return process.env.V83_ENABLED === "true";
}
