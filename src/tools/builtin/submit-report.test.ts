/**
 * v7.7 Spine 1 Phase 2a — submit_report tool boundary tests.
 *
 * 2026-05-27: runCritic now calls `queryClaudeSdk` directly with an inline
 * `submit_verdict` MCP tool (see audit/critic.ts header for rationale).
 * Mocks at that layer; helpers synthesize the SDK's tool-invocation
 * lifecycle. :memory: DB for real persistence so the per-task cap query
 * exercises real SQL.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { submitReportTool } from "./submit-report.js";
import { initDatabase, closeDatabase, getDatabase } from "../../db/index.js";
import { queryClaudeSdk } from "../../inference/claude-sdk.js";
import type { ReportDraft } from "../../audit/report-schema.js";

vi.mock("../../inference/claude-sdk.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../inference/claude-sdk.js")
  >("../../inference/claude-sdk.js");
  return {
    ...actual,
    queryClaudeSdk: vi.fn(),
  };
});

const mockQuery = vi.mocked(queryClaudeSdk);
const T0 = "2026-05-19T00:00:00.000Z";
const T1 = "2026-05-19T01:00:00.000Z";
const SHA256 = "a".repeat(64);

function validArgs(
  overrides: Partial<ReportDraft> = {},
): Record<string, unknown> {
  return {
    report_id: crypto.randomUUID(),
    started_at: T0,
    surface: "morning_brief",
    verified_against: [
      {
        type: "cost_ledger",
        query_sha: SHA256,
        row_count: 42,
        window_start: T0,
        window_end: T1,
        queried_at: T1,
      },
    ],
    sample_n: 42,
    window: { start: T0, end: T1 },
    claims: [
      { statement: "headline claim with characters", evidence_index: [0] },
    ],
    concerns: [],
    ...overrides,
  };
}

/**
 * Synthesize the SDK invoking `submit_verdict` with the given verdict +
 * critique. Mirrors the real SDK's tool-call lifecycle that runCritic
 * depends on (closure sink captures, query() resolves with empty text +
 * toolCalls). See critic.ts header for the forced-tool contract.
 */
function simulateVerdict(verdict: "pass" | "fail", critique: string) {
  mockQuery.mockImplementationOnce(async (opts) => {
    const submitVerdict = opts.extraTools?.[0];
    if (submitVerdict) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (submitVerdict as any).handler({ verdict, critique }, {});
    }
    return {
      text: "",
      toolCalls: ["submit_verdict"],
      numTurns: 1,
      usage: {
        promptTokens: 100,
        completionTokens: 20,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      costUsd: 0.0005,
      costAuthoritative: true,
      durationMs: 20,
      model: "claude-sonnet-4-6",
    };
  });
}

function mockPass() {
  simulateVerdict("pass", "");
}

function mockFail(critique = "sample_n=5 not flagged") {
  simulateVerdict("fail", critique);
}

beforeEach(() => {
  initDatabase(":memory:");
  vi.clearAllMocks();
});

afterEach(() => {
  closeDatabase();
});

describe("submit_report tool — Tool interface conformance", () => {
  it("declares the right annotations (additive DB write, recoverable)", () => {
    expect(submitReportTool.name).toBe("submit_report");
    expect(submitReportTool.readOnlyHint).toBe(false);
    expect(submitReportTool.destructiveHint).toBe(false);
    expect(submitReportTool.idempotentHint).toBe(false);
    expect(submitReportTool.openWorldHint).toBe(false);
    expect(submitReportTool.deferred).toBe(false);
  });

  it("function definition exposes the required draft fields as parameters", () => {
    const params = submitReportTool.definition.function.parameters as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(params.required).toEqual(
      expect.arrayContaining([
        "report_id",
        "started_at",
        "surface",
        "verified_against",
        "sample_n",
        "window",
        "claims",
      ]),
    );
    expect(Object.keys(params.properties)).toEqual(
      expect.arrayContaining([
        "report_id",
        "started_at",
        "surface",
        "verified_against",
        "sample_n",
        "window",
        "claims",
        "concerns",
        "task_id",
      ]),
    );
  });
});

describe("submit_report — success path", () => {
  it("returns ok:true with critic_verdict on schema-valid draft + pass critic", async () => {
    mockPass();
    const out = await submitReportTool.execute(validArgs());
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.critic_verdict).toBe("pass");
    expect(parsed.retry_count).toBe(0);
    expect(typeof parsed.report_id).toBe("string");
  });

  it("returns ok:true with fail_returned_anyway on critic fail (no reviseFn — tool is single-pass)", async () => {
    mockFail("aggregate sample_n=5 missing small_sample concern");
    const out = await submitReportTool.execute(validArgs());
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.critic_verdict).toBe("fail_returned_anyway");
    expect(parsed.critic_critique).toContain("small_sample");
  });
});

describe("submit_report — error paths", () => {
  it("returns ok:false kind:schema on malformed input", async () => {
    const args = validArgs();
    delete (args as Record<string, unknown>).surface;
    const out = await submitReportTool.execute(args);
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.kind).toBe("schema");
    expect(Array.isArray(parsed.issues)).toBe(true);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("returns ok:false kind:invariants on stale citation", async () => {
    const args = validArgs({ started_at: T1 });
    (args.verified_against as Array<Record<string, unknown>>)[0].queried_at =
      T0;
    const out = await submitReportTool.execute(args);
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.kind).toBe("invariants");
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe("submit_report — per-task call cap", () => {
  it("audit-revisions count, passes don't: 3 fails then capped, 100 passes never capped", async () => {
    const taskIdFails = "task-with-fails";
    // 3 fail_returned_anyway attempts → 4th call capped
    mockFail("c1");
    mockFail("c2");
    mockFail("c3");
    for (let i = 0; i < 3; i++) {
      const out = await submitReportTool.execute({
        ...validArgs(),
        task_id: taskIdFails,
      });
      expect(JSON.parse(out).critic_verdict).toBe("fail_returned_anyway");
    }
    const out4 = await submitReportTool.execute({
      ...validArgs(),
      task_id: taskIdFails,
    });
    const parsed4 = JSON.parse(out4);
    expect(parsed4.ok).toBe(false);
    expect(parsed4.kind).toBe("cap_exceeded");
    expect(parsed4.message).toContain("PROCEED to delivery");
    expect(mockQuery).toHaveBeenCalledTimes(3); // 4th never reached critic

    // Separate task_id with all passes — cap never fires regardless of count
    const taskIdPasses = "task-all-passes";
    for (let i = 0; i < 5; i++) {
      mockPass();
      const out = await submitReportTool.execute({
        ...validArgs(),
        task_id: taskIdPasses,
      });
      expect(JSON.parse(out).critic_verdict).toBe("pass");
    }
    // 5 more critic calls happened, no cap
    expect(mockQuery).toHaveBeenCalledTimes(8);
  });

  it("calls without task_id are NOT capped (each is a separate report)", async () => {
    // 5 anonymous calls should all proceed
    for (let i = 0; i < 5; i++) {
      mockPass();
      const out = await submitReportTool.execute(validArgs());
      const parsed = JSON.parse(out);
      expect(parsed.ok).toBe(true);
    }
    expect(mockQuery).toHaveBeenCalledTimes(5);
  });

  it("cap is per task_id — different task IDs do not share the count", async () => {
    mockPass();
    mockPass();
    mockPass();
    mockPass();
    await submitReportTool.execute({ ...validArgs(), task_id: "task-a" });
    await submitReportTool.execute({ ...validArgs(), task_id: "task-a" });
    await submitReportTool.execute({ ...validArgs(), task_id: "task-a" });
    // task-a cap reached; task-b is fresh
    const out = await submitReportTool.execute({
      ...validArgs(),
      task_id: "task-b",
    });
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.critic_verdict).toBe("pass");
    expect(mockQuery).toHaveBeenCalledTimes(4);
  });
});

describe("submit_report — persistence side-effect", () => {
  it("each ok:true call persists a row in reports", async () => {
    mockPass();
    const out = await submitReportTool.execute(validArgs());
    const parsed = JSON.parse(out);
    const row = getDatabase()
      .prepare("SELECT * FROM reports WHERE report_id = ?")
      .get(parsed.report_id) as Record<string, unknown>;
    expect(row.surface).toBe("morning_brief");
    expect(row.critic_verdict).toBe("pass");
  });
});

describe("submit_report — return-shape contract (pinned for morning.ts step 12)", () => {
  it("pass response: ok+report_id+critic_verdict+retry_count, NO critic_critique field", async () => {
    mockPass();
    const out = await submitReportTool.execute(validArgs());
    const parsed = JSON.parse(out);
    expect(Object.keys(parsed).sort()).toEqual(
      ["critic_verdict", "ok", "report_id", "retry_count"].sort(),
    );
  });

  it("fail_returned_anyway response: includes critic_critique field", async () => {
    mockFail("explicit critique text");
    const out = await submitReportTool.execute(validArgs());
    const parsed = JSON.parse(out);
    expect(parsed.critic_verdict).toBe("fail_returned_anyway");
    expect(parsed.critic_critique).toBe("explicit critique text");
  });
});

describe("submit_report — WeakMap cache (S2-W6 regression guard)", () => {
  it("warm path: 2 calls on same DB reuse one prepared statement (no error)", async () => {
    // Hot-path correctness: each call must hit the cache + re-bind, not crash.
    mockPass();
    mockPass();
    const a = await submitReportTool.execute(validArgs());
    const b = await submitReportTool.execute(validArgs());
    expect(JSON.parse(a).ok).toBe(true);
    expect(JSON.parse(b).ok).toBe(true);
  });

  it("closeDatabase + initDatabase cycle does NOT serve stale prepared statement", async () => {
    mockPass();
    const out1 = await submitReportTool.execute(validArgs());
    expect(JSON.parse(out1).ok).toBe(true);

    // Swap DB underneath. The WeakMap is keyed by Database reference; the
    // new instance from initDatabase MUST get a fresh prepared statement,
    // not the stale one from the (now closed) prior DB.
    closeDatabase();
    initDatabase(":memory:");

    mockPass();
    const out2 = await submitReportTool.execute(validArgs());
    expect(JSON.parse(out2).ok).toBe(true);
  });
});
