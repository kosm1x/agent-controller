/**
 * constructBriefing orchestrator tests (V8.1 Phase 6 B3).
 * infer() and submitReport() are mocked — no real inference or critic.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";

const inferMock = vi.fn();
vi.mock("../inference/adapter.js", () => ({
  infer: (...a: unknown[]) => inferMock(...a),
}));

const submitMock = vi.fn();
vi.mock("../audit/submit-report.js", () => ({
  submitReport: (...a: unknown[]) => submitMock(...a),
}));

import { constructBriefing } from "./construct.js";
import { getProposedBriefing } from "./storage.js";

/**
 * An LLM-shaped judgment object — deliberately WITHOUT `signal_id`: the model
 * no longer emits it, `constructBriefing` assigns the UUID itself (A2).
 */
function judgment(overrides: Record<string, unknown> = {}) {
  return {
    kind: "stalled_task",
    subject: "t-1",
    posture: "at_risk",
    confidence: "green",
    confidence_reason: "stalled twelve days",
    why: "the task has not advanced in twelve days and now needs attention",
    evidence_indices: [0],
    ...overrides,
  };
}

/** Make infer() return a given judgment payload as its content. */
function inferReturns(payload: unknown): void {
  inferMock.mockResolvedValue({
    content: JSON.stringify(payload),
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    provider: "mock",
    latency_ms: 1,
  });
}

/** Make submitReport() succeed with a given verdict. */
function s2Passes(verdict = "pass"): void {
  submitMock.mockResolvedValue({
    ok: true,
    report: { critic_verdict: verdict, concerns: [] },
  });
}

beforeEach(() => {
  initDatabase(":memory:");
  inferMock.mockReset();
  submitMock.mockReset();
});

afterEach(() => {
  closeDatabase();
});

describe("constructBriefing", () => {
  it("constructs, S2-checks, and persists a briefing (happy path)", async () => {
    inferReturns({ judgments: [judgment()] });
    s2Passes("pass");

    const result = await constructBriefing({ surface: "morning" });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.detail);
    expect(result.briefing.surface).toBe("morning");
    expect(result.briefing.judgments).toHaveLength(1);
    expect(result.briefing.critic_verdict).toBe("pass");

    // Persisted and retrievable.
    const stored = getProposedBriefing(result.briefing.briefing_id);
    expect(stored).not.toBeNull();
    expect(stored!.status).toBe("pending");

    // §13 instrumentation: the briefing's inference cost is tagged
    // `reflection:morning` so the activation gate can measure cache-read.
    const cost = getDatabase()
      .prepare(
        `SELECT COUNT(*) AS c FROM cost_ledger WHERE agent_type = 'reflection:morning'`,
      )
      .get() as { c: number };
    expect(cost.c).toBe(1);
  });

  it("carries the S2 verdict onto the briefing", async () => {
    inferReturns({ judgments: [judgment()] });
    s2Passes("fail_returned_anyway");
    const result = await constructBriefing();
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.briefing.critic_verdict).toBe("fail_returned_anyway");
  });

  it("fails at the parse stage when inference returns non-JSON", async () => {
    inferMock.mockResolvedValue({
      content: "I could not produce a briefing.",
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      provider: "mock",
      latency_ms: 1,
    });
    const result = await constructBriefing();
    expect(result).toMatchObject({ ok: false, stage: "parse" });
  });

  it("strips code fences from the inference response", async () => {
    inferMock.mockResolvedValue({
      content:
        "```json\n" + JSON.stringify({ judgments: [judgment()] }) + "\n```",
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      provider: "mock",
      latency_ms: 1,
    });
    s2Passes();
    const result = await constructBriefing();
    expect(result.ok).toBe(true);
  });

  it("normalizes a SQLite-format cursor timestamp into a valid ISO wall_start (A1)", async () => {
    // Regression: reflection_cursors.updated_at is a SQLite datetime('now')
    // string ("YYYY-MM-DD HH:MM:SS"), which the schema's z.iso.datetime()
    // rejected — the 2026-05-22 morning-briefing failure. toIsoUtc() must
    // normalize it before it reaches BriefingSchema as source_window.wall_start.
    getDatabase()
      .prepare(
        `INSERT INTO reflection_cursors (cursor_name, last_event_id, updated_at)
         VALUES ('morning_brief', 0, datetime('now'))`,
      )
      .run();
    inferReturns({ judgments: [judgment()] });
    s2Passes();
    const result = await constructBriefing();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.detail);
    expect(result.briefing.source_window.wall_start).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });

  it("assigns a unique signal_id to each judgment the LLM omits (A2)", async () => {
    // The LLM cannot reliably generate UUIDs and DetectionSignal has no id to
    // cite — the orchestrator owns judgment identity. judgment() emits none.
    inferReturns({ judgments: [judgment(), judgment()] });
    s2Passes();
    const result = await constructBriefing();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.detail);
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for (const j of result.briefing.judgments) {
      expect(j.signal_id).toMatch(uuid);
    }
    const ids = result.briefing.judgments.map((j) => j.signal_id);
    expect(new Set(ids).size).toBe(2);
  });

  it("derives highest_leverage_pick from the highest_leverage judgment (A2)", async () => {
    inferReturns({
      judgments: [judgment(), judgment({ posture: "highest_leverage" })],
    });
    s2Passes();
    const result = await constructBriefing();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.detail);
    const hl = result.briefing.judgments.find(
      (j) => j.posture === "highest_leverage",
    );
    expect(hl).toBeDefined();
    expect(result.briefing.highest_leverage_pick).toBe(hl!.signal_id);
  });

  it("leaves highest_leverage_pick unset when no judgment is highest_leverage", async () => {
    inferReturns({ judgments: [judgment(), judgment()] });
    s2Passes();
    const result = await constructBriefing();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.detail);
    expect(result.briefing.highest_leverage_pick).toBeUndefined();
  });

  it("fails at the schema stage when the LLM returns zero judgments", async () => {
    inferReturns({ judgments: [] });
    s2Passes();
    const result = await constructBriefing();
    expect(result).toMatchObject({ ok: false, stage: "schema" });
  });

  it("records inference cost even when the briefing fails validation (§13)", async () => {
    // Inference SUCCEEDED (tokens spent) but the briefing fails schema — the
    // §13 cache-read ratio must still count this call. recordReflectionCost
    // is placed after infer(), before validation, exactly so.
    inferReturns({ judgments: [] });
    s2Passes();
    const result = await constructBriefing();
    expect(result).toMatchObject({ ok: false, stage: "schema" });
    const cost = getDatabase()
      .prepare(
        `SELECT COUNT(*) AS c FROM cost_ledger WHERE agent_type = 'reflection:morning'`,
      )
      .get() as { c: number };
    expect(cost.c).toBe(1);
  });

  it("fails at the invariants stage on two highest_leverage judgments", async () => {
    inferReturns({
      judgments: [
        judgment({ posture: "highest_leverage" }),
        judgment({ posture: "highest_leverage" }),
      ],
    });
    s2Passes();
    const result = await constructBriefing();
    expect(result).toMatchObject({ ok: false, stage: "invariants" });
  });

  it("fails at the s2 stage when submitReport rejects the draft", async () => {
    inferReturns({ judgments: [judgment()] });
    submitMock.mockResolvedValue({
      ok: false,
      kind: "schema",
      issues: ["claims.0.statement: too short"],
      draft: {},
    });
    const result = await constructBriefing();
    expect(result).toMatchObject({ ok: false, stage: "s2" });
  });

  it("maps an input-assembly failure to the assembly stage", async () => {
    closeDatabase(); // getDatabase() inside assembly now throws
    const result = await constructBriefing();
    expect(result).toMatchObject({ ok: false, stage: "assembly" });
    expect(inferMock).not.toHaveBeenCalled();
    initDatabase(":memory:"); // restore for afterEach
  });

  it("maps a thrown infer() error to the inference stage (C1)", async () => {
    inferMock.mockRejectedValue(new Error("all providers down"));
    s2Passes();
    const result = await constructBriefing();
    expect(result).toMatchObject({ ok: false, stage: "inference" });
    expect(submitMock).not.toHaveBeenCalled();
  });

  it("flags an out-of-range evidence_index as 'invariants', not 's2' (C3)", async () => {
    // verified_against has 4 sources (indices 0-3); 9 is out of range.
    inferReturns({ judgments: [judgment({ evidence_indices: [9] })] });
    s2Passes();
    const result = await constructBriefing();
    expect(result).toMatchObject({ ok: false, stage: "invariants" });
    // S2 must not run on a briefing that failed invariant validation.
    expect(submitMock).not.toHaveBeenCalled();
  });

  it("does not invoke the S2 critic before a parseable judgment exists", async () => {
    inferMock.mockResolvedValue({
      content: "garbage",
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      provider: "mock",
      latency_ms: 1,
    });
    await constructBriefing();
    expect(submitMock).not.toHaveBeenCalled();
  });
});
