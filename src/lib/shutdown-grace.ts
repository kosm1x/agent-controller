/**
 * Shutdown grace-period env parsing. Lives in its own module so tests can
 * import it without booting `main()` from `index.ts` (which fails fast on
 * missing MC_API_KEY).
 *
 * Defaults to 30s — tripled from 10s on 2026-05-25 after the morning briefing
 * surfaced `Service shutdown` as a recurring blocker (6 chat tasks killed
 * across 8 days). Clamped to [0, 300_000] so a typo can't stall systemd's
 * shutdown indefinitely. 0 is a valid value (skip grace period entirely).
 */

const DEFAULT_GRACE_MS = 30_000;
const MAX_REASONABLE_GRACE_MS = 300_000;

export function readShutdownGraceMs(): number {
  const raw = process.env.MC_SHUTDOWN_GRACE_MS;
  if (raw === undefined || raw === "") return DEFAULT_GRACE_MS;
  // W1 audit fold: parseInt would silently accept "30.5" (→30), "30000abc"
  // (→30000), "0x7530" (→0). Strict whole-decimal-string check first.
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return DEFAULT_GRACE_MS;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(parsed) || parsed < 0) return DEFAULT_GRACE_MS;
  return Math.min(parsed, MAX_REASONABLE_GRACE_MS);
}
