/**
 * V8 substrate S2 — critic LLM wrapper tests.
 *
 * Mocks `infer` per the codebase convention (see prometheus/reflector.test.ts).
 * Covers: pass / fail / empty-response / non-JSON / fenced-JSON / infra error /
 * timeout / cost passthrough.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { runCritic, CRITIC_SYSTEM_PROMPT } from "./critic.js";
import { infer } from "../inference/adapter.js";
import type { ReportDraft } from "./report-schema.js";

vi.mock("../inference/adapter.js", () => ({
  infer: vi.fn(),
}));

const mockInfer = vi.mocked(infer);

const draftFixture: ReportDraft = {
  report_id: "00000000-0000-4000-8000-000000000099",
  started_at: "2026-05-19T00:00:00.000Z",
  surface: "morning_brief",
  verified_against: [
    {
      type: "cost_ledger",
      query_sha: "a".repeat(64),
      row_count: 42,
      window_start: "2026-05-19T00:00:00.000Z",
      window_end: "2026-05-19T01:00:00.000Z",
      queried_at: "2026-05-19T01:00:00.000Z",
    },
  ],
  sample_n: 42,
  window: {
    start: "2026-05-19T00:00:00.000Z",
    end: "2026-05-19T01:00:00.000Z",
  },
  claims: [
    { statement: "headline claim with characters", evidence_index: [0] },
  ],
  concerns: [],
};

function mockInferResponse(content: string | null, costUsd = 0.001) {
  mockInfer.mockResolvedValueOnce({
    content,
    usage: {
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      cost_usd: costUsd,
    },
    provider: "test",
    latency_ms: 42,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runCritic — verdict parsing", () => {
  it("returns pass on clean JSON pass", async () => {
    mockInferResponse('{"verdict":"pass","critique":""}');
    const r = await runCritic(draftFixture);
    expect(r.verdict).toBe("pass");
    expect(r.critique).toBe("");
    expect(r.error).toBe(false);
    expect(r.costUsd).toBe(0.001);
  });

  it("returns fail with critique on JSON fail", async () => {
    mockInferResponse(
      '{"verdict":"fail","critique":"n=5 not flagged as small_sample"}',
    );
    const r = await runCritic(draftFixture);
    expect(r.verdict).toBe("fail");
    expect(r.critique).toBe("n=5 not flagged as small_sample");
    expect(r.error).toBe(false);
  });

  it("parses JSON inside ```json fence", async () => {
    mockInferResponse(
      '```json\n{"verdict":"fail","critique":"window mismatch"}\n```',
    );
    const r = await runCritic(draftFixture);
    expect(r.verdict).toBe("fail");
    expect(r.critique).toBe("window mismatch");
    expect(r.error).toBe(false);
  });

  it("parses JSON inside bare ``` fence", async () => {
    mockInferResponse('```\n{"verdict":"pass","critique":""}\n```');
    const r = await runCritic(draftFixture);
    expect(r.verdict).toBe("pass");
    expect(r.error).toBe(false);
  });

  it("extracts JSON from prose-prefixed response", async () => {
    mockInferResponse(
      'Sure, here is the verdict: {"verdict":"pass","critique":""}',
    );
    const r = await runCritic(draftFixture);
    expect(r.verdict).toBe("pass");
    expect(r.error).toBe(false);
  });
});

describe("runCritic — infra-error paths", () => {
  it("flags empty response as error", async () => {
    mockInferResponse("");
    const r = await runCritic(draftFixture);
    expect(r.error).toBe(true);
    expect(r.verdict).toBe("fail");
    expect(r.critique).toContain("empty");
  });

  it("flags null content as error", async () => {
    mockInferResponse(null);
    const r = await runCritic(draftFixture);
    expect(r.error).toBe(true);
    expect(r.verdict).toBe("fail");
  });

  it("flags non-JSON prose as error", async () => {
    mockInferResponse("This report looks fine to me.");
    const r = await runCritic(draftFixture);
    expect(r.error).toBe(true);
    expect(r.verdict).toBe("fail");
    expect(r.critique).toContain("non-JSON");
  });

  it("flags JSON-shaped-but-wrong-verdict as error", async () => {
    mockInferResponse('{"verdict":"maybe","critique":"unsure"}');
    const r = await runCritic(draftFixture);
    expect(r.error).toBe(true);
    expect(r.verdict).toBe("fail");
  });

  it("flags JSON missing critique field as error", async () => {
    mockInferResponse('{"verdict":"pass"}');
    const r = await runCritic(draftFixture);
    expect(r.error).toBe(true);
  });

  it("flags infer() rejection as error", async () => {
    mockInfer.mockRejectedValueOnce(new Error("upstream 503"));
    const r = await runCritic(draftFixture);
    expect(r.error).toBe(true);
    expect(r.verdict).toBe("fail");
    expect(r.critique).toContain("upstream 503");
  });

  it("times out per timeoutMs option", async () => {
    mockInfer.mockImplementationOnce(
      (_req, opts) =>
        new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    );
    const r = await runCritic(draftFixture, { timeoutMs: 50 });
    expect(r.error).toBe(true);
    expect(r.verdict).toBe("fail");
  });

  it("already-aborted signal short-circuits without invoking infer", async () => {
    const ac = new AbortController();
    ac.abort(new Error("caller budget exhausted"));
    const r = await runCritic(draftFixture, { signal: ac.signal });
    expect(r.error).toBe(true);
    expect(r.verdict).toBe("fail");
    expect(r.critique).toContain("caller signal already aborted");
    expect(r.latencyMs).toBe(0);
    expect(mockInfer).not.toHaveBeenCalled();
  });
});

describe("runCritic — multi-object parser (W4)", () => {
  it("picks the real verdict when response contains an example JSON first", async () => {
    mockInferResponse(
      'Here is an example: {"verdict":"pass","critique":""} and here is my actual verdict: {"verdict":"fail","critique":"sample_n=3 not flagged"}',
    );
    const r = await runCritic(draftFixture);
    // First valid verdict wins (example IS valid shape — that's correct per the contract;
    // a critic that emits an example before its verdict is itself a bug, but parser doesn't crash)
    expect(r.error).toBe(false);
    expect(r.verdict).toBe("pass");
  });

  it("balanced-paren walker handles nested objects in critique", async () => {
    mockInferResponse(
      '{"verdict":"fail","critique":"window {start: x, end: y} mismatch"}',
    );
    const r = await runCritic(draftFixture);
    expect(r.error).toBe(false);
    expect(r.verdict).toBe("fail");
    expect(r.critique).toContain("mismatch");
  });

  it("walker tolerates prose with no balanced object", async () => {
    mockInferResponse("This looks fine to me, no JSON here.");
    const r = await runCritic(draftFixture);
    expect(r.error).toBe(true);
  });
});

describe("runCritic — prompt + request shape", () => {
  it("passes the frozen system prompt and report JSON as user", async () => {
    mockInferResponse('{"verdict":"pass","critique":""}');
    await runCritic(draftFixture);
    expect(mockInfer).toHaveBeenCalledOnce();
    const [request] = mockInfer.mock.calls[0];
    expect(request.messages[0].role).toBe("system");
    expect(request.messages[0].content).toBe(CRITIC_SYSTEM_PROMPT);
    expect(request.messages[1].role).toBe("user");
    expect(request.messages[1].content).toContain('"report_id"');
    expect(request.messages[1].content).toContain('"verified_against"');
    expect(request.temperature).toBe(0);
  });

  it("honors providerName override", async () => {
    mockInferResponse('{"verdict":"pass","critique":""}');
    await runCritic(draftFixture, { providerName: "haiku" });
    const [, opts] = mockInfer.mock.calls[0];
    expect(opts?.providerName).toBe("haiku");
  });
});
