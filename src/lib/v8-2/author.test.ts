import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ queryClaudeSdk: vi.fn() }));

vi.mock("../../inference/claude-sdk.js", () => ({
  queryClaudeSdk: mocks.queryClaudeSdk,
  SONNET_MODEL_ID: "claude-sonnet-4-6",
}));

import {
  authorJudgment,
  AuthorError,
  renderEvidenceLedger,
  AUTHOR_ROLE_INSTRUCTIONS,
} from "./author.js";
import type { EvidenceRef } from "./types.js";

const LEDGER: EvidenceRef[] = [
  {
    kind: "task",
    id: "t1",
    excerpt: "blocked",
    retrieved_at: "2026-06-19T00:00:00Z",
  },
  {
    kind: "metric",
    id: "m1",
    excerpt: "down 8%",
    retrieved_at: "2026-06-19T00:00:00Z",
  },
];

function sdkResult(over: Record<string, unknown> = {}) {
  return {
    text: "The task is blocked [1].",
    toolCalls: [],
    numTurns: 1,
    usage: {
      promptTokens: 1,
      completionTokens: 1,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
    model: "claude-sonnet-4-6",
    costUsd: 0.01,
    costAuthoritative: true,
    durationMs: 1,
    ...over,
  };
}

const input = {
  question: "What to do about task-42?",
  contextSummary: "digest",
  ledger: LEDGER,
  options: [],
  subject: "task-42",
  posture: "at_risk",
};

beforeEach(() => vi.clearAllMocks());

describe("renderEvidenceLedger", () => {
  it("renders 1-based [i+1] (kind id) excerpt", () => {
    expect(renderEvidenceLedger(LEDGER)).toBe(
      "[1] (task t1) blocked\n[2] (metric m1) down 8%",
    );
  });
  it("handles an empty ledger", () => {
    expect(renderEvidenceLedger([])).toBe("(no structured evidence retrieved)");
  });
});

describe("authorJudgment", () => {
  it("returns the prose and an authoritative cost", async () => {
    mocks.queryClaudeSdk.mockResolvedValue(sdkResult());
    const res = await authorJudgment(input);
    expect(res.prose).toBe("The task is blocked [1].");
    expect(res.costUsd).toBe(0.01);
  });

  it("calls the SDK free-text (no tools) with the citation contract + ledger in the prompt", async () => {
    mocks.queryClaudeSdk.mockResolvedValue(sdkResult());
    await authorJudgment(input);
    const call = mocks.queryClaudeSdk.mock.calls[0][0];
    expect(call.toolNames).toEqual([]);
    expect(call.extraTools).toBeUndefined();
    expect(call.model).toBe("claude-sonnet-4-6");
    expect(call.systemPrompt.length).toBeGreaterThan(0); // the strategic-voice block
    expect(call.prompt).toContain("Citation discipline"); // JUDGMENT_CITATION_CONTRACT_V1
    expect(call.prompt).toContain("[1] (task t1) blocked"); // rendered ledger
    expect(call.prompt).toContain(AUTHOR_ROLE_INSTRUCTIONS.slice(0, 24));
  });

  it("drops a phantom cost when the SDK cost is not authoritative", async () => {
    mocks.queryClaudeSdk.mockResolvedValue(
      sdkResult({ costAuthoritative: false, costUsd: 0 }),
    );
    const res = await authorJudgment(input);
    expect(res.costUsd).toBeUndefined();
  });

  it("throws AuthorError on empty prose", async () => {
    mocks.queryClaudeSdk.mockResolvedValue(sdkResult({ text: "   " }));
    await expect(authorJudgment(input)).rejects.toBeInstanceOf(AuthorError);
  });

  it("throws AuthorError on an already-aborted signal without calling the SDK", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      authorJudgment(input, { signal: ac.signal }),
    ).rejects.toBeInstanceOf(AuthorError);
    expect(mocks.queryClaudeSdk).not.toHaveBeenCalled();
  });

  it("wraps an SDK throw as AuthorError", async () => {
    mocks.queryClaudeSdk.mockRejectedValue(new Error("api 500"));
    await expect(authorJudgment(input)).rejects.toBeInstanceOf(AuthorError);
  });

  it("renders provided options into the task body", async () => {
    mocks.queryClaudeSdk.mockResolvedValue(sdkResult());
    await authorJudgment({
      ...input,
      options: [
        {
          label: "A",
          summary: "escalate now",
          tradeoffs: ["risk"],
          rank: 1,
          generated_by_role: "synthesizer",
        },
        {
          label: "B",
          summary: "wait a week",
          tradeoffs: ["slower"],
          rank: 2,
          generated_by_role: "synthesizer",
        },
        {
          label: "C",
          summary: "drop it",
          tradeoffs: ["lost work"],
          rank: 3,
          generated_by_role: "synthesizer",
        },
      ],
    });
    const call = mocks.queryClaudeSdk.mock.calls[0][0];
    expect(call.prompt).toContain("A (rank 1): escalate now");
    expect(call.prompt).toContain("Decision options under consideration");
  });
});
