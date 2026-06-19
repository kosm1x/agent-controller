/**
 * Self-healing triage monitor — runtime flag.
 *
 * Direct-env read (NOT `getConfig()`, which caches at boot) — mirrors
 * `isV82ProducerEnabled()`, so the operator can arm the monitor with an env edit
 * + restart and a test can toggle it per-case. Default OFF (`=== "true"` opt-in)
 * so the monitor ships DORMANT: the cron does not register until the operator
 * deliberately sets `SELF_HEALING_TRIAGE_ENABLED=true` (a systemd drop-in, like
 * the V8.2 producer — never a .env edit, which systemd Environment overrides).
 */
export function isTriageMonitorEnabled(): boolean {
  return process.env.SELF_HEALING_TRIAGE_ENABLED === "true";
}
