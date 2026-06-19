/**
 * V8.2 runtime flags.
 *
 * Direct-env reads (NOT `getConfig()`, which caches at boot) — mirrors
 * `isBriefingDeliveryEnabled()` in `src/briefing/delivery.ts`, so the operator
 * can flip the flag without a code change beyond the env edit + restart and a
 * test can toggle it per-case.
 *
 * `V82_JUDGMENT_PRODUCER_ENABLED` is the master SHADOW switch for the §17
 * activation run: when `true`, the morning surface runs the judgment-assembly
 * producer (writes `judgments` + `attributed_claims` rows, runs the critic, and
 * computes confidence) and the nightly sycophancy probe cron registers. Default
 * OFF (`=== "true"` opt-in idiom) so the whole V8.2 layer stays dormant until
 * the operator deliberately starts the 7-day shadow.
 *
 * Note on delivery: V8.2 judgments are written-and-measured in shadow but are
 * NOT in the operator-facing delivered payload — the brief still delivers its
 * V8.1 prose (gated by `V81_BRIEF_DELIVERY_ENABLED`). Surfacing V8.2 judgments
 * to the operator is the post-shadow activation step, deliberately deferred
 * until the §17 gate proves the judgments are sound. So there is no separate
 * `V82_DELIVERY_ENABLED` flag yet — that lands with the brief-recompose work.
 */

/** True when the V8.2 judgment-assembly producer + nightly probe are armed. */
export function isV82ProducerEnabled(): boolean {
  return process.env.V82_JUDGMENT_PRODUCER_ENABLED === "true";
}
