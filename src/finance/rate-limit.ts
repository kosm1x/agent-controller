/**
 * Per-provider rate limiter — sliding 60-second window, ceilings set
 * conservatively below each provider's documented max to absorb bursts.
 *
 * Ceilings (80% of provider max):
 *   - alpha_vantage: 60/min  (tier-1 max 75/min)
 *   - polygon:        4/min  (free tier max 5/min)
 *   - fred:         100/min  (free tier max 120/min)
 *
 * In-memory state. Seeded from api_call_budget at boot so restarts
 * don't desync ceilings from recent traffic.
 */

import type { Provider } from "./types.js";

const WINDOW_MS = 60_000;

const CEILINGS: Partial<Record<Provider, number>> = {
  alpha_vantage: 60,
  polygon: 4,
  fred: 100,
};

/** Records call times per provider. Timestamps in ms. */
const state = new Map<Provider, number[]>();

/** Returns true if provider can accept another call within the current 60s window. */
export function canCall(provider: Provider): boolean {
  const ceiling = CEILINGS[provider];
  if (ceiling === undefined) return true; // no rate-limit for this provider
  prune(provider);
  const recent = state.get(provider) ?? [];
  return recent.length < ceiling;
}

/** Record a call against the provider's window. */
export function recordCall(provider: Provider): void {
  if (CEILINGS[provider] === undefined) return;
  const list = state.get(provider) ?? [];
  list.push(Date.now());
  state.set(provider, list);
  prune(provider);
}

/** Milliseconds until the next call would succeed (0 if available now). */
export function msUntilAvailable(provider: Provider): number {
  const ceiling = CEILINGS[provider];
  if (ceiling === undefined) return 0;
  prune(provider);
  const recent = state.get(provider) ?? [];
  if (recent.length < ceiling) return 0;
  // Oldest timestamp in the window will expire first.
  const oldest = recent[0];
  return Math.max(0, oldest + WINDOW_MS - Date.now());
}

/**
 * Seed the limiter from the DB for a provider. Call at boot so restarts
 * don't desync. Takes raw ISO-timestamp strings from api_call_budget.
 */
export function seedFromHistory(provider: Provider, isoTimes: string[]): void {
  if (CEILINGS[provider] === undefined) return;
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  const ms = isoTimes
    .map((t) => Date.parse(t))
    .filter((t) => Number.isFinite(t) && t >= cutoff)
    .sort((a, b) => a - b);
  state.set(provider, ms);
}

/** Test-only reset. */
export function __resetForTests(): void {
  state.clear();
}

function prune(provider: Provider): void {
  const cutoff = Date.now() - WINDOW_MS;
  const list = state.get(provider);
  if (!list) return;
  let i = 0;
  while (i < list.length && list[i] < cutoff) i++;
  if (i > 0) state.set(provider, list.slice(i));
}

/** Current call counts (for market_budget_stats tool). */
export function currentWindow(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const provider of Object.keys(CEILINGS) as Provider[]) {
    prune(provider);
    out[provider] = (state.get(provider) ?? []).length;
  }
  return out;
}

/** Ceilings for display/alerting. */
export function ceilings(): Partial<Record<Provider, number>> {
  return { ...CEILINGS };
}
