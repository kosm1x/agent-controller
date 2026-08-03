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
 * judgments must prove sound in shadow before they reach the operator's brief,
 * and delivery can be armed without touching the producer.
 *
 * §17 green is NECESSARY, NOT SUFFICIENT — do not read a passing gate as an
 * instruction to flip this. Since check 6a was removed (2026-08-02) every
 * surviving §17 check is machine-generated (schema, judgment count, citation
 * resolver, critic LLM, sycophancy probe), so §17 can go green with zero
 * operator input. Arming delivery is a PRODUCT decision — "do these judgments
 * belong in the operator's 06:00 brief?" — and that question is answered by
 * reading them (`mc-ctl judgments`), not by an exit code.
 *
 * Default OFF (`=== "true"` opt-in idiom) so V8.2 stays dormant in the delivered
 * payload until that deliberate flip.
 */

/** True when the V8.2 judgment-assembly producer + nightly probe are armed. */
export function isV82ProducerEnabled(): boolean {
  return process.env.V82_JUDGMENT_PRODUCER_ENABLED === "true";
}

/** True when V8.2 strategic judgments are surfaced into the delivered brief.
 *  Independent of `isV82ProducerEnabled` — the producer can run in shadow while
 *  delivery stays off; flipping this on appends the strategic section so the
 *  judgments actually reach the operator. */
export function isV82DeliveryEnabled(): boolean {
  return process.env.V82_DELIVERY_ENABLED === "true";
}

/** schedule_id of the operator's scheduled task that acts as the strategic
 *  surface (operator ruling 2026-08-03: the 08:00 "Morning Sync" replaced the
 *  retired 06:00 brief as the operator-facing morning surface). When set, the
 *  dynamic scheduler injects one vetted judgment per day into that task's
 *  prompt and appends the Lectura estratégica line to its outbound message
 *  (src/lib/v8-2/sync-surfacing.ts). Unset (the default) = no injection. */
export function getSyncSurfaceScheduleId(): string | null {
  const v = process.env.V82_SYNC_SCHEDULE_ID?.trim();
  return v ? v : null;
}
