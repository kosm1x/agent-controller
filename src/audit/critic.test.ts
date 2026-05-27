/**
 * V8 substrate S2 — critic LLM wrapper tests (2026-05-27 forced-tool rewrite).
 *
 * The pre-rewrite tests mocked `infer` and asserted free-text JSON parsing.
 * The new path uses `queryClaudeSdk` with a forced `submit_verdict` MCP tool;
 * the model's "output" is the args it passes to the tool, captured via a
 * closure in `buildSubmitVerdictTool`.
 *
 * Mock strategy: stub `queryClaudeSdk` to either (a) invoke the registered
 * tool's handler with synthetic args (happy path), or (b) skip the handler
 * and return free text (degraded-model fallback path). The handler-invocation
 * simulates what the real SDK does when the model emits a tool_use block.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { runCritic, CRITIC_SYSTEM_PROMPT } from "./critic.js";
import { queryClaudeSdk } from "../inference/claude-sdk.js";
import type { ReportDraft } from "./report-schema.js";

vi.mock("../inference/claude-sdk.js", async () => {
  const actual = await vi.importActual<
    typeof import("../inference/claude-sdk.js")
  >("../inference/claude-sdk.js");
  return {
    ...actual,
    queryClaudeSdk: vi.fn(),
  };
});

const mockQuery = vi.mocked(queryClaudeSdk);

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

/**
 * Simulate the SDK invoking the `submit_verdict` handler before returning.
 * Mirrors the real SDK's tool-call lifecycle for the happy path.
 */
function mockToolCalled(args: { verdict: "pass" | "fail"; critique: string }) {
  mockQuery.mockImplementationOnce(async (opts) => {
    const submitVerdict = opts.extraTools?.[0];
    if (submitVerdict) {
      // The SDK calls `handler(args, extra)` and threads its return through
      // its tool-result channel. We don't need the return value here — the
      // closure sink in critic.ts is what we care about.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (submitVerdict as any).handler(args, {});
    }
    return {
      text: "",
      toolCalls: ["submit_verdict"],
      numTurns: 1,
      usage: {
        promptTokens: 100,
        completionTokens: 30,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      costUsd: 0.0012,
      costAuthoritative: true,
      durationMs: 42,
      model: "claude-sonnet-4-6",
    };
  });
}

/**
 * Simulate the degraded path: SDK returns text without invoking the tool
 * (model went off-script). `runCritic` should fall back to parsing the
 * text via `parseCriticVerdict`.
 */
function mockTextOnly(text: string, costUsd = 0.001) {
  mockQuery.mockResolvedValueOnce({
    text,
    toolCalls: [],
    numTurns: 1,
    usage: {
      promptTokens: 100,
      completionTokens: 30,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
    costUsd,
    costAuthoritative: true,
    durationMs: 42,
    model: "claude-sonnet-4-6",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runCritic — forced submit_verdict tool (happy path)", () => {
  it("captures a clean PASS verdict from the tool args", async () => {
    mockToolCalled({ verdict: "pass", critique: "" });
    const r = await runCritic(draftFixture);
    expect(r.verdict).toBe("pass");
    expect(r.critique).toBe("");
    expect(r.error).toBe(false);
    expect(r.costUsd).toBe(0.0012);
  });

  it("captures a FAIL verdict with critique", async () => {
    mockToolCalled({
      verdict: "fail",
      critique: "n=5 not flagged as small_sample",
    });
    const r = await runCritic(draftFixture);
    expect(r.verdict).toBe("fail");
    expect(r.critique).toBe("n=5 not flagged as small_sample");
    expect(r.error).toBe(false);
  });

  it("passes a single submit_verdict extraTool to the SDK", async () => {
    mockToolCalled({ verdict: "pass", critique: "" });
    await runCritic(draftFixture);
    const [call] = mockQuery.mock.calls;
    expect(call[0].extraTools).toHaveLength(1);
    expect(call[0].extraTools?.[0].name).toBe("submit_verdict");
    expect(call[0].toolNames).toEqual([]);
    expect(call[0].systemPrompt).toBe(CRITIC_SYSTEM_PROMPT);
    expect(call[0].prompt).toContain('"report_id"');
  });
});

describe("runCritic — no tool call ⇒ audit_failed (audit-C1)", () => {
  // Audit-C1: prior to the 2026-05-27 fix there was a defense-in-depth
  // fallback that tried to parse free text via parseCriticVerdict. That
  // fallback re-introduced the exact chain-of-thought failure mode the
  // forced-tool refactor was built to close (Sonnet emits a JSON-like
  // {...} block in its preamble that the parser could pick up). The
  // contract is now strict: no submit_verdict call = audit_failed.

  it("flags free-text response with JSON-shaped content as audit_failed", async () => {
    // The pre-fix path would have parsed this as a clean pass.
    mockTextOnly('{"verdict":"pass","critique":""}');
    const r = await runCritic(draftFixture);
    expect(r.error).toBe(true);
    expect(r.verdict).toBe("fail");
    expect(r.critique).toContain("did not call submit_verdict");
  });

  it("flags chain-of-thought preamble (the original bug) as audit_failed", async () => {
    mockTextOnly(
      "I need to verify this report against its cited evidence. Let me query the database.",
    );
    const r = await runCritic(draftFixture);
    expect(r.error).toBe(true);
    expect(r.verdict).toBe("fail");
    expect(r.critique).toContain("did not call submit_verdict");
  });

  it("flags empty response (no tool + no text) as audit_failed", async () => {
    mockTextOnly("");
    const r = await runCritic(draftFixture);
    expect(r.error).toBe(true);
    expect(r.verdict).toBe("fail");
    expect(r.critique).toContain("did not call submit_verdict");
  });
});

describe("runCritic — abort race recovery (audit-C2)", () => {
  it("returns the captured verdict when abort fires AFTER the handler ran", async () => {
    // Simulate: handler captures verdict, then SDK throws due to abort.
    // Pre-fix behavior would discard the captured verdict and report
    // audit_failed. Post-fix: trust the closure sink.
    mockQuery.mockImplementationOnce(async (opts) => {
      const submitVerdict = opts.extraTools?.[0];
      if (submitVerdict) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (submitVerdict as any).handler(
          { verdict: "pass", critique: "" },
          {},
        );
      }
      throw new Error("aborted mid-stream");
    });
    const r = await runCritic(draftFixture);
    expect(r.verdict).toBe("pass");
    expect(r.critique).toBe("");
    expect(r.error).toBe(false);
  });

  it("reports audit_failed when abort fires BEFORE the handler ran", async () => {
    mockQuery.mockRejectedValueOnce(new Error("aborted before tool call"));
    const r = await runCritic(draftFixture);
    expect(r.error).toBe(true);
    expect(r.verdict).toBe("fail");
    expect(r.critique).toContain("aborted before tool call");
  });
});

describe("runCritic — double-call guard (audit-W2)", () => {
  it("rejects a second submit_verdict call; first verdict survives via C2 recovery", async () => {
    mockQuery.mockImplementationOnce(async (opts) => {
      const submitVerdict = opts.extraTools?.[0];
      if (submitVerdict) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (submitVerdict as any).handler(
          { verdict: "pass", critique: "" },
          {},
        );
        await expect(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (submitVerdict as any).handler(
            { verdict: "fail", critique: "second call" },
            {},
          ),
        ).rejects.toThrow("more than once");
      }
      return {
        text: "",
        toolCalls: ["submit_verdict", "submit_verdict"],
        numTurns: 1,
        usage: {
          promptTokens: 100,
          completionTokens: 30,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
        costUsd: 0.001,
        costAuthoritative: true,
        durationMs: 42,
        model: "claude-sonnet-4-6",
      };
    });
    const r = await runCritic(draftFixture);
    // First verdict is what's captured; the W2 throw is swallowed inside
    // the mock's expect-rejects so queryClaudeSdk still resolves cleanly.
    expect(r.verdict).toBe("pass");
    expect(r.error).toBe(false);
  });
});

describe("runCritic — infra-error paths", () => {
  it("flags queryClaudeSdk rejection as error", async () => {
    mockQuery.mockRejectedValueOnce(new Error("upstream 503"));
    const r = await runCritic(draftFixture);
    expect(r.error).toBe(true);
    expect(r.verdict).toBe("fail");
    expect(r.critique).toContain("upstream 503");
  });

  it("times out per timeoutMs option", async () => {
    mockQuery.mockImplementationOnce(
      (opts) =>
        new Promise((_resolve, reject) => {
          opts.abortSignal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    );
    const r = await runCritic(draftFixture, { timeoutMs: 50 });
    expect(r.error).toBe(true);
    expect(r.verdict).toBe("fail");
  });

  it("already-aborted signal short-circuits without invoking the SDK", async () => {
    const ac = new AbortController();
    ac.abort(new Error("caller budget exhausted"));
    const r = await runCritic(draftFixture, { signal: ac.signal });
    expect(r.error).toBe(true);
    expect(r.verdict).toBe("fail");
    expect(r.critique).toContain("caller signal already aborted");
    expect(r.latencyMs).toBe(0);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("omits costUsd when SDK marks costAuthoritative=false (abort path)", async () => {
    mockQuery.mockResolvedValueOnce({
      text: "",
      toolCalls: [],
      numTurns: 0,
      usage: {
        promptTokens: 50,
        completionTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      costUsd: 0,
      costAuthoritative: false,
      durationMs: 5,
      model: "claude-sonnet-4-6",
    });
    const r = await runCritic(draftFixture);
    expect(r.error).toBe(true);
    expect(r.costUsd).toBeUndefined();
  });
});

// Audit-W5 / 2026-05-27 follow-up: the prior "defaults missing critique to ''"
// test was removed when the handler's `args.critique ?? ""` belt-and-braces
// was deleted. Zod's `.optional().default("")` on the schema applies BEFORE
// the handler runs, so in production `args.critique` is always a string by
// the time the handler sees it. Testing Zod's default behavior at the
// handler level was testing Zod itself, not our code.
