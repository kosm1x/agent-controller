/**
 * Best-effort data writes that fail. The caller still swallows the error (a
 * failed log or ledger row must not fail the work it records), but each
 * failure is counted on the default prom-client registry that
 * src/observability/prometheus.ts serves, and logged once per site per minute.
 * Scheduled jobs that catch their own failure count them the same way, by job
 * id (`noteJobFailure`).
 *
 * Leaf module: called from catch blocks, so it imports nothing that tests
 * mock with partial factories, and it never throws.
 */
import client from "prom-client";
import { errMsg } from "../lib/err-msg.js";
import type { Cadence } from "../lib/s3/registry.js";

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

const JOB_NAME = "mc_job_failures_total";

// Same get-or-create as the write counter above.
const jobFailuresTotal =
  (client.register.getSingleMetric(JOB_NAME) as client.Counter<"job"> | undefined) ??
  new client.Counter({
    name: JOB_NAME,
    help: "Scheduled-job failures that the job caught and swallowed, by job id",
    labelNames: ["job"] as const,
  });

/** One log line per key per interval: a missing table fails every call. */
const LOG_INTERVAL_MS = 60_000;
// Keyed by tag + key, where the key is a fixed write site or a fixed job id
// (the id the job passes to scheduleCron), never a string built from data.
// That is what keeps these maps bounded.
const lastLogAt = new Map<string, number>();
const suppressed = new Map<string, number>();

/** Test helper: reset the log throttle so specs are order-independent. */
export function _resetWriteFailureThrottle(): void {
  lastLogAt.clear();
  suppressed.clear();
}

/**
 * `[<tag>] <key>: <message, at most 200 characters>`, at most once per key per
 * minute, with the count of lines suppressed since the last one. Never throws.
 */
function logThrottled(tag: string, key: string, err: unknown): void {
  try {
    const mapKey = `${tag} ${key}`;
    const now = Date.now();
    const last = lastLogAt.get(mapKey);
    if (last !== undefined && now - last < LOG_INTERVAL_MS) {
      suppressed.set(mapKey, (suppressed.get(mapKey) ?? 0) + 1);
      return;
    }
    const skipped = suppressed.get(mapKey) ?? 0;
    lastLogAt.set(mapKey, now);
    suppressed.set(mapKey, 0);
    let message: string;
    try {
      message = errMsg(err);
    } catch {
      message = "(unreadable error)";
    }
    const suffix = skipped > 0 ? ` (+${skipped} suppressed)` : "";
    // Capped: an error message can quote the input the work was given.
    console.error(`[${tag}] ${key}: ${message.slice(0, 200)}${suffix}`);
  } catch {
    // a logger must not break the caller's catch block
  }
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
  logThrottled("write-failure", site, err);
}

/**
 * The scheduleCron ids whose jobs catch their own failure and count it here.
 * Closed so the `job` label stays bounded.
 */
export type JobFailureId =
  | "cohort-rollup"
  | "tasks-retention"
  | "checkpoint-prune"
  | "intel-signal-prune"
  | "proactive-nudge"
  | "self-healing-triage"
  | "sycophancy-probe"
  | "x-health-probe"
  | "idle-detect"
  | `s3-${Cadence}`;

/**
 * Count a failure a scheduled job caught and swallowed, and log it (throttled).
 * Record-only: it does not page. `id` is the fixed id the job passes to
 * scheduleCron. Never throws.
 */
export function noteJobFailure(id: JobFailureId, err: unknown): void {
  try {
    jobFailuresTotal.inc({ job: id });
  } catch {
    // counting is best-effort too
  }
  logThrottled("job-failure", id, err);
}
