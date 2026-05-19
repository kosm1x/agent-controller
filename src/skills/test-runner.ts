/**
 * v7.7 Spine 3 Phase 2 Bundle 2 — S5 skill test runner.
 *
 * Executes the `tests_json` declared in a skill version's frontmatter and
 * writes each outcome to `skill_test_runs`. After all tests run for a
 * given (skillId, versionId) pair, flips the parent `skills.is_certified`
 * flag based on the aggregate result.
 *
 * Phase 2 NOTE on execution model:
 *
 *   Spec §9 says tests run via `dry_run=true skill_run` calls — the
 *   real `skill_run` (with ToolSource dispatch + dry_run-mock-tool
 *   resolution) is Phase 4 work. Phase 2's test runner is a
 *   MINI-EXECUTOR that bypasses ToolSource entirely:
 *
 *     - system prompt = `${body}` + a frozen "return ONLY JSON" suffix
 *     - user message  = `JSON.stringify(test.input)`
 *     - Single `infer()` call; response parsed as JSON
 *     - Matched against test.expect.output_match (deep partial) OR
 *       test.expect_error.{class, detail_contains}
 *
 *   This is the simplest viable harness. Phase 4's full `skill_run`
 *   will replace this; the `skill_test_runs` schema is forward-compatible.
 *
 * The runner does NOT modify `skill_failures` (that's Phase 4's
 * `skill_run`-time anti-list). Test failures decertify the skill but
 * don't trip the anti-list directly.
 */

import { z } from "zod";
import { getDatabase } from "../db/index.js";
import { runSkillPrompt } from "./mini-runner.js";

// ---------------------------------------------------------------------------
// Test schema — validates a single tests_json entry
// ---------------------------------------------------------------------------

const TestExpectSchema = z
  .object({
    output_type: z.enum(["text", "json", "structured"]).optional(),
    output_match: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const TestExpectErrorSchema = z
  .object({
    class: z.string().min(1),
    detail_contains: z.string().optional(),
  })
  .strict();

export const SkillTestSchema = z
  .object({
    name: z.string().min(1),
    input: z.record(z.string(), z.unknown()),
    expect: TestExpectSchema.optional(),
    expect_error: TestExpectErrorSchema.optional(),
  })
  .strict()
  .refine(
    (t) => Boolean(t.expect) !== Boolean(t.expect_error),
    "test must declare exactly one of `expect` or `expect_error`",
  );

export type SkillTest = z.infer<typeof SkillTestSchema>;

export const SkillTestsArraySchema = z.array(SkillTestSchema);

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

export type TestResultStatus = "pass" | "fail" | "error" | "timeout";

export interface TestRunOutcome {
  testName: string;
  result: TestResultStatus;
  /** Actual LLM output, JSON-stringified. NULL on infrastructure error. */
  actualJson: string | null;
  /** Stringified expectation for forensics. NULL when match was structural. */
  expectedJson: string | null;
  diffSummary: string | null;
  durationMs: number;
}

export interface RunSkillTestsResult {
  skillId: string;
  versionId: number;
  certified: boolean;
  outcomes: TestRunOutcome[];
}

export interface RunSkillTestsOptions {
  /** Cap individual test LLM call latency. Default 30s. */
  timeoutMs?: number;
  /** Override inference provider. */
  providerName?: string;
  /** Caller abort signal — short-circuits remaining tests. */
  signal?: AbortSignal;
  /** Task id for skill_test_runs.task_id provenance. */
  taskId?: string;
}

// Phase 4 refactor: runner harness (RUNNER_PREFIX + JSON-only contract +
// override detection) lives in `./mini-runner.ts` so the dispatcher and
// the test runner can't drift apart. The shared module returns a
// normalized MiniRunResult that this file maps onto skill_test_runs.

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

/**
 * Run every test declared in `tests_json` for the given skill version.
 * Writes one row to `skill_test_runs` per test + flips
 * `skills.is_certified` based on the aggregate result.
 *
 * Returns the per-test outcomes and the resolved certification flag.
 *
 * On schema-invalid `tests_json` the runner returns
 * `{certified: false, outcomes: []}` and writes NO rows — caller can
 * see this and decide (typically queue an alert; never auto-certify a
 * malformed-tests skill).
 */
export async function runSkillTests(
  skillId: string,
  versionId: number,
  options: RunSkillTestsOptions = {},
): Promise<RunSkillTestsResult> {
  const db = getDatabase();
  const version = db
    .prepare(
      "SELECT body, tests_json FROM skill_versions WHERE id = ? AND skill_id = ?",
    )
    .get(versionId, skillId) as
    | { body: string; tests_json: string }
    | undefined;

  if (!version) {
    // Caller passed a bad pair; surface via empty outcomes + no certify.
    flipCertified(skillId, false);
    return { skillId, versionId, certified: false, outcomes: [] };
  }

  let parsedTests: SkillTest[];
  try {
    const raw = JSON.parse(version.tests_json);
    parsedTests = SkillTestsArraySchema.parse(raw);
  } catch {
    // Malformed tests_json — not a runtime fail, but caller MUST NOT
    // certify a skill whose tests we couldn't parse.
    flipCertified(skillId, false);
    return { skillId, versionId, certified: false, outcomes: [] };
  }

  if (parsedTests.length === 0) {
    // No tests = cannot certify. Spec §9: "is_certified=1 iff every
    // test has result='pass' ... within 7 days" — vacuously certifying
    // is the wrong default.
    flipCertified(skillId, false);
    return { skillId, versionId, certified: false, outcomes: [] };
  }

  const outcomes: TestRunOutcome[] = [];
  let aborted = false;
  for (const test of parsedTests) {
    if (options.signal?.aborted) {
      // R1-W1 fold: when caller aborts BEFORE a test ran, don't write a
      // synthetic 'error' row (the test never executed; recording an
      // error misrepresents the skill). Mark `aborted` and skip the
      // is_certified flip below — a previously-certified skill must NOT
      // be decertified by a SIGTERM mid-sweep.
      aborted = true;
      break;
    }
    const outcome = await runOneTest(version.body, test, options);
    outcomes.push(outcome);
    writeTestRun(skillId, versionId, outcome, options.taskId ?? null);
  }

  if (aborted) {
    // Preserve existing is_certified — caller signaled abort; this run
    // is informationally incomplete.
    const db = getDatabase();
    const row = db
      .prepare("SELECT is_certified FROM skills WHERE skill_id = ?")
      .get(skillId) as { is_certified: number } | undefined;
    return {
      skillId,
      versionId,
      certified: (row?.is_certified ?? 0) === 1,
      outcomes,
    };
  }

  const allPassed = outcomes.every((o) => o.result === "pass");
  flipCertified(skillId, allPassed);
  return { skillId, versionId, certified: allPassed, outcomes };
}

// ---------------------------------------------------------------------------
// Per-test execution
// ---------------------------------------------------------------------------

async function runOneTest(
  body: string,
  test: SkillTest,
  options: RunSkillTestsOptions,
): Promise<TestRunOutcome> {
  const result = await runSkillPrompt(body, test.input, {
    timeoutMs: options.timeoutMs,
    providerName: options.providerName,
    signal: options.signal,
  });

  const expectedJson = JSON.stringify(test.expect ?? test.expect_error ?? null);

  switch (result.status) {
    case "ok":
      // Phase 2 invariant: judgeOutcome guarantees a non-null output here.
      return judgeOutcome(test, result.output!, result.durationMs);
    case "empty":
      return {
        testName: test.name,
        result: "error",
        actualJson: null,
        expectedJson,
        diffSummary: result.message ?? "LLM returned empty response",
        durationMs: result.durationMs,
      };
    case "unparseable":
      return {
        testName: test.name,
        result: "error",
        actualJson:
          result.rawExcerpt !== null ? JSON.stringify(result.rawExcerpt) : null,
        expectedJson,
        diffSummary:
          result.message ??
          "LLM response did not contain a parseable JSON object",
        durationMs: result.durationMs,
      };
    case "timeout":
      return {
        testName: test.name,
        result: "timeout",
        actualJson: null,
        expectedJson,
        diffSummary: result.message ?? "test timeout",
        durationMs: result.durationMs,
      };
    case "error":
    default:
      return {
        testName: test.name,
        result: "error",
        actualJson: null,
        expectedJson,
        diffSummary: result.message ?? "unknown harness error",
        durationMs: result.durationMs,
      };
  }
}

/**
 * Compare LLM output against the test's expectation. Returns a fully
 * populated TestRunOutcome with result + diff summary.
 *
 *   - `expect.output_match`: deep partial match against the actual
 *     object. Extra keys in `actual` are ignored; mismatched values
 *     fail.
 *   - `expect_error`: actual must have an `error` field equal to
 *     `class`, and the `detail` field (if present) must contain
 *     `detail_contains` as substring.
 */
function judgeOutcome(
  test: SkillTest,
  actual: Record<string, unknown>,
  durationMs: number,
): TestRunOutcome {
  const actualJson = JSON.stringify(actual);

  if (test.expect_error) {
    const expectedJson = JSON.stringify(test.expect_error);
    const errClass = (actual as { error?: unknown }).error;
    if (errClass !== test.expect_error.class) {
      return {
        testName: test.name,
        result: "fail",
        actualJson,
        expectedJson,
        diffSummary: `expected error class "${test.expect_error.class}", got ${JSON.stringify(errClass)}`,
        durationMs,
      };
    }
    if (test.expect_error.detail_contains) {
      const detail = String((actual as { detail?: unknown }).detail ?? "");
      if (!detail.includes(test.expect_error.detail_contains)) {
        return {
          testName: test.name,
          result: "fail",
          actualJson,
          expectedJson,
          diffSummary: `error detail did not contain "${test.expect_error.detail_contains}"; got "${detail.slice(0, 200)}"`,
          durationMs,
        };
      }
    }
    return {
      testName: test.name,
      result: "pass",
      actualJson,
      expectedJson,
      diffSummary: null,
      durationMs,
    };
  }

  // expect.output_match path
  const expect = test.expect ?? {};
  const expectedJson = JSON.stringify(expect);
  if (!expect.output_match) {
    // expect block with no output_match → treat any non-error JSON as pass.
    // expect.output_type alone is informational; we don't enforce type
    // shape at the harness layer (Phase 4 typed-output discipline).
    return {
      testName: test.name,
      result: "pass",
      actualJson,
      expectedJson,
      diffSummary: null,
      durationMs,
    };
  }

  const diff = deepPartialMatch(expect.output_match, actual);
  if (diff) {
    return {
      testName: test.name,
      result: "fail",
      actualJson,
      expectedJson,
      diffSummary: diff,
      durationMs,
    };
  }
  return {
    testName: test.name,
    result: "pass",
    actualJson,
    expectedJson,
    diffSummary: null,
    durationMs,
  };
}

/**
 * Deep partial match. Returns null on match, or a short diff summary
 * string on mismatch. Recurses into nested objects; arrays compared by
 * length + element index (no permutation).
 */
function deepPartialMatch(
  expected: Record<string, unknown>,
  actual: Record<string, unknown> | unknown,
  pathPrefix = "",
): string | null {
  if (typeof actual !== "object" || actual === null || Array.isArray(actual)) {
    return `${pathPrefix || "<root>"}: expected object, got ${typeof actual}`;
  }
  const actualObj = actual as Record<string, unknown>;
  for (const key of Object.keys(expected)) {
    const path = pathPrefix ? `${pathPrefix}.${key}` : key;
    const expectedVal = expected[key];
    const actualVal = actualObj[key];
    if (
      expectedVal !== null &&
      typeof expectedVal === "object" &&
      !Array.isArray(expectedVal)
    ) {
      const sub = deepPartialMatch(
        expectedVal as Record<string, unknown>,
        actualVal,
        path,
      );
      if (sub) return sub;
      continue;
    }
    if (Array.isArray(expectedVal)) {
      if (!Array.isArray(actualVal)) {
        return `${path}: expected array, got ${typeof actualVal}`;
      }
      if (expectedVal.length !== actualVal.length) {
        return `${path}: expected array length ${expectedVal.length}, got ${actualVal.length}`;
      }
      for (let i = 0; i < expectedVal.length; i++) {
        const ev = expectedVal[i];
        const av = actualVal[i];
        if (typeof ev === "object" && ev !== null && !Array.isArray(ev)) {
          const sub = deepPartialMatch(
            ev as Record<string, unknown>,
            av,
            `${path}[${i}]`,
          );
          if (sub) return sub;
        } else if (!Object.is(ev, av)) {
          return `${path}[${i}]: expected ${JSON.stringify(ev)}, got ${JSON.stringify(av)}`;
        }
      }
      continue;
    }
    if (!Object.is(expectedVal, actualVal)) {
      return `${path}: expected ${JSON.stringify(expectedVal)}, got ${JSON.stringify(actualVal)}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// DB persistence helpers
// ---------------------------------------------------------------------------

function writeTestRun(
  skillId: string,
  versionId: number,
  outcome: TestRunOutcome,
  taskId: string | null,
): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO skill_test_runs (
       skill_id, version_id, test_name, result, actual_output_json,
       expected_output_json, diff_summary, duration_ms, task_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    skillId,
    versionId,
    outcome.testName,
    outcome.result,
    outcome.actualJson,
    outcome.expectedJson,
    outcome.diffSummary,
    outcome.durationMs,
    taskId,
  );

  // Counter bump via dynamic import to avoid a hard cycle (test-runner →
  // prometheus → … ). Matches Spine 2 B2's pattern for mc_s3_evaluator_errors.
  // R1-W2 fold: log the import failure instead of swallowing it silently
  // — per `feedback_prometheus_counter_recovery_path`, the counter's
  // failure path is itself a load-bearing surface.
  void import("../observability/prometheus.js")
    .then(({ recordSkillTestResult }) => recordSkillTestResult(outcome.result))
    .catch((err) => {
      console.warn(
        "[skills:test-runner] counter import failed (counter not incremented):",
        err instanceof Error ? err.message : String(err),
      );
    });
}

function flipCertified(skillId: string, certified: boolean): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE skills SET is_certified = ?, updated_at = datetime('now') WHERE skill_id = ?`,
  ).run(certified ? 1 : 0, skillId);
}
