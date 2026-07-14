/**
 * Per-provider rate limiter — sliding 60-second window, ceilings set
 * conservatively below each provider's documented max to absorb bursts.
 * Providers with a daily quota additionally get a sliding 24-hour window
 * (both must have headroom for a call to proceed).
 *
 * Ceilings:
 *   - alpha_vantage:  4/min AND 22/day (FREE tier since 2026-07-14:
 *     5/min, 25 req/day hard — ceilings leave headroom for manual calls)
 *   - polygon:        4/min  (free tier max 5/min)
 *   - fred:         100/min  (free tier max 120/min)
 *
 * In-memory state. Seeded from api_call_budget at boot so restarts
 * don't desync ceilings from recent traffic.
 */

import type { Provider } from "./types.js";

const WINDOW_MS = 60_000;
export const DAY_WINDOW_MS = 86_400_000;

const CEILINGS: Partial<Record<Provider, number>> = {
  alpha_vantage: 4,
  polygon: 4,
  fred: 100,
  // F6 + F6.5 external signal providers. Polymarket raised to 60/min per
  // audit W5 — community experience shows ≥100/min works fine in practice;
  // 60 leaves headroom without throttling a full morning-briefing cascade.
  polymarket: 60,
  alternative_me: 30,
  coinmarketcap: 30,
  binance: 120,
};

/** Sliding 24h ceilings for providers with a daily quota. */
const DAILY_CEILINGS: Partial<Record<Provider, number>> = {
  alpha_vantage: 22,
};

/** Records call times per provider. Timestamps in ms. */
const state = new Map<Provider, number[]>();

/** Retention window for a provider's timestamps (24h when a daily quota applies). */
function retentionMs(provider: Provider): number {
  return DAILY_CEILINGS[provider] !== undefined ? DAY_WINDOW_MS : WINDOW_MS;
}

function countSince(list: number[], cutoff: number): number {
  let i = list.length;
  while (i > 0 && list[i - 1] >= cutoff) i--;
  return list.length - i;
}

/** Returns true if provider can accept another call within BOTH the 60s and (if set) 24h windows. */
export function canCall(provider: Provider): boolean {
  const ceiling = CEILINGS[provider];
  if (ceiling === undefined) return true; // no rate-limit for this provider
  prune(provider);
  const recent = state.get(provider) ?? [];
  if (countSince(recent, Date.now() - WINDOW_MS) >= ceiling) return false;
  const daily = DAILY_CEILINGS[provider];
  if (daily !== undefined && recent.length >= daily) return false;
  return true;
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
  const now = Date.now();
  let wait = 0;
  const inMinute = countSince(recent, now - WINDOW_MS);
  if (inMinute >= ceiling) {
    // Oldest timestamp in the minute window will expire first.
    const oldestInMinute = recent[recent.length - inMinute];
    wait = Math.max(wait, oldestInMinute + WINDOW_MS - now);
  }
  const daily = DAILY_CEILINGS[provider];
  if (daily !== undefined && recent.length >= daily) {
    wait = Math.max(wait, recent[0] + DAY_WINDOW_MS - now);
  }
  return Math.max(0, wait);
}

/**
 * Seed the limiter from the DB for a provider. Call at boot so restarts
 * don't desync. Takes raw ISO-timestamp strings from api_call_budget.
 * Callers should pass history covering the provider's longest window
 * (24h for daily-quota providers, 1 minute otherwise).
 */
export function seedFromHistory(provider: Provider, isoTimes: string[]): void {
  if (CEILINGS[provider] === undefined) return;
  const now = Date.now();
  const cutoff = now - retentionMs(provider);
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
  const cutoff = Date.now() - retentionMs(provider);
  const list = state.get(provider);
  if (!list) return;
  let i = 0;
  while (i < list.length && list[i] < cutoff) i++;
  if (i > 0) state.set(provider, list.slice(i));
}

/** Current 60s-window call counts (for market_budget_stats tool). */
export function currentWindow(): Record<string, number> {
  const out: Record<string, number> = {};
  const cutoff = Date.now() - WINDOW_MS;
  for (const provider of Object.keys(CEILINGS) as Provider[]) {
    prune(provider);
    out[provider] = countSince(state.get(provider) ?? [], cutoff);
  }
  return out;
}

/** Current 24h-window call counts for daily-quota providers. */
export function currentDailyWindow(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const provider of Object.keys(DAILY_CEILINGS) as Provider[]) {
    prune(provider);
    out[provider] = (state.get(provider) ?? []).length;
  }
  return out;
}

/** Ceilings for display/alerting. */
export function ceilings(): Partial<Record<Provider, number>> {
  return { ...CEILINGS };
}

/** Daily ceilings for display/alerting. */
export function dailyCeilings(): Partial<Record<Provider, number>> {
  return { ...DAILY_CEILINGS };
}
