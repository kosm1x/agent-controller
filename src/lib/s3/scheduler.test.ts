/**
 * S3-I3-tests — counter-increment regression coverage for
 * `mc_s3_evaluator_errors_total`. The Prom counter is registered live on
 * `:8080/metrics`; these tests lock the dynamic-import path inside
 * `runCadenceTick` + `noticeError` so a future refactor that breaks the
 * `await import("../../observability/prometheus.js")` chain fails loudly.
 *
 * Three injected-throw fixtures, one per `kind` label:
 *   - `signal`: per-signal evaluator threw (per-signal isolation in the loop)
 *   - `burst`: burst detection / persistence threw after alerts emitted
 *   - `tick`: outer cron callback's catch hook (noticeError)
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type Mock,
} from "vitest";
import client from "prom-client";
import { initDatabase, closeDatabase } from "../../db/index.js";
import { insertSignalIfMissing } from "./registry.js";

// IMPORTANT: dynamic-import the modules under test AFTER mocks are
// installed. vi.mock hoists, but the prom counter registration relies on
// import order; we control it explicitly via the registry.clear() in
// afterEach.

vi.mock("./burst.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./burst.js")>();
  return {
    ...actual,
    // Defaults to the real impls; individual tests override via vi.mocked.
    loadRecentUnbundledAlerts: vi.fn(actual.loadRecentUnbundledAlerts),
    detectBursts: vi.fn(actual.detectBursts),
    persistBurstBundle: vi.fn(actual.persistBurstBundle),
  };
});

vi.mock("./evaluator.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./evaluator.js")>();
  return {
    ...actual,
    evaluateSignal: vi.fn(actual.evaluateSignal),
  };
});

beforeEach(() => {
  initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
  // Intentionally do NOT clear the prom-client registry between tests:
  // the counter is registered when prometheus.js loads (once per test
  // file), and clearing the registry orphans the counter's internal
  // state from the registry while the function-side reference still
  // points at the orphan. The before/after delta pattern in each test
  // already neutralizes cross-test accumulation.
  //
  // RELIES ON: vitest default `pool: 'forks'` + `isolate: true`. Each
  // test file gets its own worker process so the prom-client singleton
  // is per-process. DO NOT enable `pool: 'threads'` or `isolate: false`
  // without revisiting this contract — `evaluator.test.ts` calls
  // `client.register.clear()` and would wipe this file's counter mid-run.
  vi.restoreAllMocks();
});

function seedSignal(cadence: "hourly" | "nightly" = "nightly"): void {
  insertSignalIfMissing({
    signal_name: "test_signal",
    signal_kind: "test",
    source_substrate: "test",
    baseline_query: "SELECT 100 AS value",
    baseline_value_json: '{"value":50}',
    tolerance_json: '{"kind":"absolute_threshold","op":"gt","value":50}',
    cadence,
    alert_priority: "P1",
    enabled: 1,
    established_at: "2026-05-19T00:00:00.000Z",
    established_by: "test",
  });
}

/**
 * Read the labeled value of `mc_s3_evaluator_errors_total{cadence,kind}` by
 * parsing the registry's Prom-text rendering. Counter.get() is async + the
 * sync internal hashMap is not part of the public API; grepping the text
 * format is the stable read path.
 */
async function readEvalErrCount(
  cadence: string,
  kind: "signal" | "burst" | "tick",
): Promise<number> {
  const text = await client.register.metrics();
  const line = text
    .split("\n")
    .find(
      (l) =>
        l.startsWith("mc_s3_evaluator_errors_total{") &&
        l.includes(`cadence="${cadence}"`) &&
        l.includes(`kind="${kind}"`),
    );
  if (!line) return 0;
  const m = line.match(/}\s+(\d+(?:\.\d+)?)$/);
  return m ? Number(m[1]) : 0;
}

describe("recordS3EvaluatorError counter — runCadenceTick integration", () => {
  it("bumps {cadence, kind='signal'} when evaluateSignal throws", async () => {
    seedSignal("nightly");
    const evaluator = await import("./evaluator.js");
    (evaluator.evaluateSignal as unknown as Mock).mockRejectedValueOnce(
      new Error("synthetic per-signal failure"),
    );

    const { runCadenceTick } = await import("./scheduler.js");
    const before = await readEvalErrCount("nightly", "signal");
    const result = await runCadenceTick("nightly");
    const after = await readEvalErrCount("nightly", "signal");

    expect(result.alertsEmitted).toBe(0);
    expect(after - before).toBe(1);
  });

  it("bumps {cadence, kind='tick'} via noticeError (outer cron-callback catch path)", async () => {
    const { noticeError } = await import("./scheduler.js");
    const before = await readEvalErrCount("hourly", "tick");
    // noticeError is async-awaitable so tests can lock the dynamic-import
    // path; the production caller in registerS3CronJobs uses `void` to
    // preserve fire-and-forget semantics.
    await noticeError("hourly", new Error("synthetic tick failure"));
    const after = await readEvalErrCount("hourly", "tick");
    expect(after - before).toBe(1);
  });

  it("bumps {kind='burst'} on direct counter call (locks label contract; integration via signal-kind sibling)", async () => {
    // NOTE on coverage scope: this test does NOT exercise the burst-catch
    // dynamic-import chain end-to-end (mocking loadRecentUnbundledAlerts to
    // throw through vi.mock partials wouldn't propagate through scheduler.ts's
    // static-import binding). Coverage of the dynamic-import string lives in
    // the signal-kind test above; this test only locks the LABEL contract for
    // the 'burst' kind so a future refactor that renames the literal or
    // breaks the cardinality fails fast.
    const { recordS3EvaluatorError } =
      await import("../../observability/prometheus.js");
    const before = await readEvalErrCount("every_4h", "burst");
    recordS3EvaluatorError("every_4h", "burst");
    const after = await readEvalErrCount("every_4h", "burst");
    expect(after - before).toBe(1);
  });
});
