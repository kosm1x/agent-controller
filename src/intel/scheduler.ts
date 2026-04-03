/**
 * Intelligence Depot polling scheduler.
 *
 * Runs each collector adapter at its configured interval.
 * Tracks health per source. One failing source doesn't block others.
 */

import type { CollectorAdapter, CollectorHealth } from "./types.js";
import { getAllAdapters } from "./adapters/index.js";
import { insertSignals, pruneOldSignals } from "./signal-store.js";
import { processSignals } from "./delta-engine.js";
import { evaluateDeltas, shouldSuppress, createAlert } from "./alert-router.js";
import { deliverPendingAlerts } from "./alert-delivery.js";

const timers = new Map<string, ReturnType<typeof setInterval>>();
const health = new Map<string, CollectorHealth>();
const collecting = new Set<string>(); // guards against overlapping cycles
let broadcastFn: ((text: string) => Promise<void>) | null = null;

/** Set the broadcast function for alert delivery (called from index.ts after messaging init). */
export function setIntelBroadcast(fn: (text: string) => Promise<void>): void {
  broadcastFn = fn;
}

/**
 * Run a single collection cycle for an adapter.
 * Inserts signals, computes deltas, evaluates alerts, delivers if needed.
 */
async function runCollector(adapter: CollectorAdapter): Promise<void> {
  // Prevent overlapping cycles if previous collect() is still running
  if (collecting.has(adapter.source)) return;
  collecting.add(adapter.source);

  const h = health.get(adapter.source) ?? {
    source: adapter.source,
    lastSuccess: null,
    lastAttempt: null,
    consecutiveFailures: 0,
    totalSignals: 0,
  };
  h.lastAttempt = new Date().toISOString();

  try {
    const signals = await adapter.collect();

    if (signals.length > 0) {
      const inserted = insertSignals(signals);
      const deltas = processSignals(signals);

      h.totalSignals += inserted;
      h.consecutiveFailures = 0;
      h.lastSuccess = new Date().toISOString();

      if (deltas.length > 0) {
        console.log(
          `[intel] ${adapter.source}: ${inserted} signals, ${deltas.length} deltas (${deltas.map((d) => `${d.key}:${d.severity}`).join(", ")})`,
        );

        // Evaluate deltas → create alerts → deliver
        const candidates = evaluateDeltas(deltas);
        for (const candidate of candidates) {
          if (!shouldSuppress(candidate)) {
            createAlert(candidate);
          }
        }

        // Deliver pending FLASH/PRIORITY via Telegram
        if (broadcastFn) {
          await deliverPendingAlerts(broadcastFn).catch((err) => {
            console.warn(
              `[intel] Alert delivery failed:`,
              err instanceof Error ? err.message : err,
            );
          });
        }
      }
    } else {
      h.consecutiveFailures = 0;
      h.lastSuccess = new Date().toISOString();
    }
  } catch (err) {
    h.consecutiveFailures++;
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[intel] ${adapter.source} failed (${h.consecutiveFailures}x): ${msg}`,
    );
  }

  health.set(adapter.source, h);
  collecting.delete(adapter.source);
}

/**
 * Start all collector adapters on their polling intervals.
 * Safe to call multiple times — skips already-running adapters.
 */
export function startIntelCollectors(): void {
  const adapters = getAllAdapters();
  console.log(
    `[intel] Starting ${adapters.length} collectors: ${adapters.map((a) => a.source).join(", ")}`,
  );

  for (const adapter of adapters) {
    if (timers.has(adapter.source)) continue;

    // Initialize health entry
    health.set(adapter.source, {
      source: adapter.source,
      lastSuccess: null,
      lastAttempt: null,
      consecutiveFailures: 0,
      totalSignals: 0,
    });

    // Run immediately on startup, then at interval
    void runCollector(adapter);

    if (adapter.defaultInterval > 0) {
      const timer = setInterval(
        () => void runCollector(adapter),
        adapter.defaultInterval,
      );
      timers.set(adapter.source, timer);
    }
  }

  // Daily signal pruning (30-day retention)
  const pruneTimer = setInterval(
    () => {
      const deleted = pruneOldSignals(30);
      if (deleted > 0) console.log(`[intel] Pruned ${deleted} old signals`);
    },
    24 * 60 * 60_000,
  );
  timers.set("_pruner", pruneTimer);
}

/** Stop all collector intervals (for graceful shutdown). */
export function stopIntelCollectors(): void {
  for (const [source, timer] of timers) {
    clearInterval(timer);
    console.log(`[intel] Stopped collector: ${source}`);
  }
  timers.clear();
}

/** Get health status for all collectors. */
export function getCollectorHealth(): CollectorHealth[] {
  return [...health.values()];
}

/** Check if collectors are running. */
export function isRunning(): boolean {
  return timers.size > 0;
}
