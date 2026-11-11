/**
 * Best-effort data writes that fail. The caller still swallows the error (a
 * failed log or ledger row must not fail the work it records), but each
 * failure is counted on the default prom-client registry that
 * src/observability/prometheus.ts serves, and logged once per site per minute.
 *
 * Leaf module: called from catch blocks, so it imports nothing that tests
 * mock with partial factories, and it never throws.
 */
import client from "prom-client";
import { errMsg } from "../lib/err-msg.js";

export type WriteFailureSite =
  | "conversation"
  | "embedding"
  | "cost_task"
  | "cost_attempt"
  | "cost_sdk"
  | "mutation_log"
  | "project_log"
  | "user_evidence"
  | "unknown";

const NAME = "mc_write_failures_total";

// Idempotent: a second module identity (dual specifier, resetModules) must
// reuse the registered counter, not throw "already registered".
export const writeFailuresTotal =
  (client.register.getSingleMetric(NAME) as client.Counter<"site"> | undefined) ??
  new client.Counter({
    name: NAME,
    help: "Best-effort data writes that failed and were swallowed, by write site",
    labelNames: ["site"] as const,
  });

/** One log line per site per interval: a missing table fails every call. */
const LOG_INTERVAL_MS = 60_000;
const lastLogAt = new Map<WriteFailureSite, number>();
const suppressed = new Map<WriteFailureSite, number>();

/** Test helper: reset the log throttle so specs are order-independent. */
export function _resetWriteFailureThrottle(): void {
  lastLogAt.clear();
  suppressed.clear();
}

/**
 * Count a swallowed write failure and log it (throttled). The line carries the
 * site and the error message only: never SQL, bound values or row content.
 * Never throws.
 */
export function noteWriteFailure(site: WriteFailureSite, err: unknown): void {
  try {
    writeFailuresTotal.inc({ site });
  } catch {
    // counting is best-effort too
  }
  try {
    const now = Date.now();
    const last = lastLogAt.get(site);
    if (last !== undefined && now - last < LOG_INTERVAL_MS) {
      suppressed.set(site, (suppressed.get(site) ?? 0) + 1);
      return;
    }
    const skipped = suppressed.get(site) ?? 0;
    lastLogAt.set(site, now);
    suppressed.set(site, 0);
    let message: string;
    try {
      message = errMsg(err);
    } catch {
      message = "(unreadable error)";
    }
    const suffix = skipped > 0 ? ` (+${skipped} suppressed)` : "";
    // Capped: an error message can quote the input the write was given.
    console.error(`[write-failure] ${site}: ${message.slice(0, 200)}${suffix}`);
  } catch {
    // a logger must not break the caller's catch block
  }
}
