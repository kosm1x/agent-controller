import client from "prom-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import {
  registerCohortRollupCron,
  runCohortRollup,
  stopCohortRollupCron,
} from "./rollup-cron.js";

/** Read one labelled value out of a registered metric. */
async function metricValue(
  name: string,
  labels: Record<string, string>,
): Promise<number | undefined> {
  const metric = client.register.getSingleMetric(name);
  if (!metric) return undefined;
  const snapshot = await metric.get();
  return snapshot.values.find((v) =>
    Object.entries(labels).every(([k, val]) => v.labels[k] === val),
  )?.value;
}

/** Silent log so test output stays clean. */
const SILENT = { info: () => {}, warn: () => {} };

beforeEach(() => {
  initDatabase(":memory:");
});

afterEach(() => {
  stopCohortRollupCron();
  closeDatabase();
});

function seedProject(id: string, name: string): void {
  getDatabase()
    .prepare(
      "INSERT INTO projects (id, slug, name, status) VALUES (?, ?, ?, 'active')",
    )
    .run(id, `slug-${id}`, name);
}

describe("runCohortRollup", () => {
  it("runs the roll-up and returns the result", () => {
    seedProject("p-1", "Alpha");
    seedProject("p-2", "Beta");
    const result = runCohortRollup(SILENT);
    expect(result).not.toBeNull();
    expect(result!.candidates).toBe(2);
    expect(result!.cohort_size).toBe(2);

    // The roll-up actually populated the cohort table.
    const n = getDatabase()
      .prepare("SELECT COUNT(*) AS n FROM self_defining_cohort")
      .get() as { n: number };
    expect(n.n).toBe(2);
  });

  it("returns null and does not throw when the roll-up fails", () => {
    // Close the DB so rollUpCohort's getDatabase() throws — runCohortRollup
    // must catch it, log, and return null (never propagate).
    closeDatabase();
    let result: ReturnType<typeof runCohortRollup> | undefined;
    expect(() => {
      result = runCohortRollup(SILENT);
    }).not.toThrow();
    expect(result).toBeNull();
    // re-init so afterEach's closeDatabase has a db to close.
    initDatabase(":memory:");
  });

  it("does not overwrite the cohort-size gauge on a failed roll-up (R1-W4)", async () => {
    seedProject("p-1", "Alpha");
    seedProject("p-2", "Beta");
    runCohortRollup(SILENT); // ok → gauge project=2
    expect(await metricValue("mc_cohort_size", { kind: "project" })).toBe(2);

    const errBefore =
      (await metricValue("mc_cohort_rollup_total", { result: "error" })) ?? 0;

    closeDatabase(); // next roll-up fails
    runCohortRollup(SILENT);

    // Gauge must still read the last-known-good value, not 0.
    expect(await metricValue("mc_cohort_size", { kind: "project" })).toBe(2);
    // Error counter must have incremented.
    initDatabase(":memory:"); // for afterEach
    const errAfter =
      (await metricValue("mc_cohort_rollup_total", { result: "error" })) ?? 0;
    expect(errAfter).toBeGreaterThan(errBefore);
  });
});

describe("registerCohortRollupCron", () => {
  it("registers a cron job and is idempotent", () => {
    expect(registerCohortRollupCron(SILENT)).toBe(true);
    // Re-registering stops the prior job and installs a fresh one.
    expect(registerCohortRollupCron(SILENT)).toBe(true);
    // stopCohortRollupCron is safe to call when nothing is registered.
    stopCohortRollupCron();
    stopCohortRollupCron();
  });
});
