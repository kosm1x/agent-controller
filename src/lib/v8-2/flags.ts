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
 * Note on delivery: the producer (`V82_JUDGMENT_PRODUCER_ENABLED`) writes-and-
 * measures judgments in shadow; surfacing them to the operator is a SEPARATE,
 * second opt-in — `V82_DELIVERY_ENABLED` (`isV82DeliveryEnabled`). With delivery
 * off, the brief still delivers only its V8.1 prose (gated by
 * `V81_BRIEF_DELIVERY_ENABLED`); with it on, `deliverBriefing` appends a
 * strategic-judgment section. The two flags are independent on purpose: the
 * §17 acceptance signal can't accrue until delivery is on, so the operator
 * flips delivery once the shadow proves the judgments sound — without touching
 * the producer. Default OFF (`=== "true"` opt-in idiom) so V8.2 stays dormant
 * in the delivered payload until that deliberate flip.
 */

/** True when the V8.2 judgment-assembly producer + nightly probe are armed. */
export function isV82ProducerEnabled(): boolean {
  return process.env.V82_JUDGMENT_PRODUCER_ENABLED === "true";
}

/** True when V8.2 strategic judgments are surfaced into the delivered brief.
 *  Independent of `isV82ProducerEnabled` — the producer can run in shadow while
 *  delivery stays off; flipping this on appends the strategic section so the
 *  §17 acceptance signal (promote-on-reply) can start accruing. */
export function isV82DeliveryEnabled(): boolean {
  return process.env.V82_DELIVERY_ENABLED === "true";
}
