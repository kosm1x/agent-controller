/**
 * constructBriefing orchestrator tests (V8.1 Phase 6 B3).
 * infer() and submitReport() are mocked — no real inference or critic.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, initDatabase } from "../db/index.js";

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

/** A schema-valid judgment object. */
function judgment(overrides: Record<string, unknown> = {}) {
  return {
    signal_id: crypto.randomUUID(),
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

  it("fails at the schema stage when the LLM returns zero judgments", async () => {
    inferReturns({ judgments: [] });
    s2Passes();
    const result = await constructBriefing();
    expect(result).toMatchObject({ ok: false, stage: "schema" });
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
