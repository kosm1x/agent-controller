/**
 * Context compressor tests — compression trigger, tool pair sanitization, fallback.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ChatMessage } from "../inference/adapter.js";

vi.mock("../inference/adapter.js", () => ({
  infer: vi.fn(),
}));

import {
  shouldCompress,
  estimateTokens,
  compress,
  sanitizeToolPairs,
  SUMMARY_PREFIX,
} from "./context-compressor.js";
import { infer } from "../inference/adapter.js";

const mockInfer = vi.mocked(infer);

beforeEach(() => {
  vi.clearAllMocks();
});

// File-scope spy restore. The two warn-spy tests in the anti-thrashing
// describe call mockRestore() explicitly, but if either throws between
// mockImplementation and the explicit restore, the spy would leak to
// subsequent tests. Audit W6 — `feedback_testing.md` rule: always
// `vi.restoreAllMocks()` in afterEach, not beforeEach.
afterEach(() => {
  vi.restoreAllMocks();
});

describe("estimateTokens", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it("should return 0 for empty array", () => {
    expect(estimateTokens([])).toBe(0);
  });

  it("should estimate string content as chars / 4", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "x".repeat(400) },
    ];
    expect(estimateTokens(messages)).toBe(100);
  });

  it("should count array content (multimodal)", () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "hello" }] as unknown as string,
      },
    ];
    expect(estimateTokens(messages)).toBeGreaterThan(0);
  });

  it("should count tool_calls", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "tc-1",
            type: "function",
            function: { name: "test", arguments: "x".repeat(400) },
          },
        ],
      },
    ];
    expect(estimateTokens(messages)).toBeGreaterThan(100);
  });

  it("should handle null content gracefully", () => {
    const messages: ChatMessage[] = [{ role: "assistant", content: null }];
    expect(estimateTokens(messages)).toBe(0);
  });
});

describe("shouldCompress", () => {
  it("should return false for short conversations", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "You are helpful" },
      { role: "user", content: "Hello" },
    ];
    expect(shouldCompress(messages, 128_000)).toBe(false);
  });

  it("should return true when exceeding threshold", () => {
    // Create a message that would exceed 85% of a small context limit
    const bigContent = "x".repeat(4000); // ~1000 tokens
    const messages: ChatMessage[] = [{ role: "user", content: bigContent }];
    // 1000 tokens > 1000 * 0.85 = 850
    expect(shouldCompress(messages, 1000)).toBe(true);
  });

  it("should count tool_calls content", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "tc-1",
            type: "function",
            function: { name: "test", arguments: "x".repeat(4000) },
          },
        ],
      },
    ];
    expect(shouldCompress(messages, 1000)).toBe(true);
  });
});

describe("compress", () => {
  it("should not compress when messages count <= keepHead + keepTail", async () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    const result = await compress(messages, 2, 2);
    expect(result).toEqual(messages);
  });

  it("should compress middle messages with LLM summary", async () => {
    mockInfer.mockResolvedValueOnce({
      content: "Summary of middle conversation",
      tool_calls: undefined,
      usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
      provider: "test",
      latency_ms: 50,
    });

    const messages: ChatMessage[] = [
      { role: "system", content: "sys" }, // head[0]
      { role: "user", content: "hello" }, // head[1]
      { role: "assistant", content: "response1" }, // middle
      { role: "user", content: "question" }, // middle
      { role: "assistant", content: "response2" }, // middle
      { role: "user", content: "follow up" }, // tail[0]
      { role: "assistant", content: "answer" }, // tail[1]
    ];

    const result = await compress(messages, 2, 2);

    // Should have: 2 head + 1 summary + 2 tail = 5
    expect(result.length).toBe(5);
    expect(result[0].content).toBe("sys");
    expect(result[1].content).toBe("hello");
    expect(result[2].role).toBe("system");
    expect(result[2].content).toContain(SUMMARY_PREFIX);
    expect(result[2].content).toContain("Summary of middle conversation");
    expect(result[3].content).toBe("follow up");
    expect(result[4].content).toBe("answer");
  });

  it("should fallback to drop-without-summary when infer fails", async () => {
    mockInfer.mockRejectedValueOnce(new Error("Provider down"));

    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "mid1" },
      { role: "user", content: "mid2" },
      { role: "assistant", content: "mid3" },
      { role: "user", content: "recent1" },
      { role: "assistant", content: "recent2" },
    ];

    const result = await compress(messages, 2, 2);

    expect(result.length).toBe(5);
    // Summary should contain SUMMARY_PREFIX + fallback marker
    expect(result[2].content).toContain(SUMMARY_PREFIX);
    expect(result[2].content).toContain("compressed");
    expect(result[2].content).toContain("3 messages removed");
  });

  it("should detect existing summary and use update prompt", async () => {
    mockInfer.mockResolvedValueOnce({
      content: "Updated summary with new info",
      tool_calls: undefined,
      usage: { prompt_tokens: 80, completion_tokens: 30, total_tokens: 110 },
      provider: "test",
      latency_ms: 50,
    });

    const messages: ChatMessage[] = [
      { role: "system", content: "sys" }, // head
      { role: "user", content: "hello" }, // head
      {
        role: "system",
        content: `${SUMMARY_PREFIX} Previous summary of events`,
      }, // middle — existing summary
      { role: "assistant", content: "new response" }, // middle — new message
      { role: "user", content: "new question" }, // middle — new message
      { role: "user", content: "recent1" }, // tail
      { role: "assistant", content: "recent2" }, // tail
    ];

    const result = await compress(messages, 2, 2);

    // Should use update prompt with existing summary
    const inferCall = mockInfer.mock.calls[0][0];
    // messages[0] is the NO_TOOLS preamble; messages[1] is the actual prompt
    const prompt =
      typeof inferCall.messages[1].content === "string"
        ? inferCall.messages[1].content
        : "";
    expect(prompt).toContain("Update this existing summary");
    expect(prompt).toContain("Previous summary of events");

    // Existing summary should NOT appear in the "New messages" section
    expect(prompt).not.toContain(`[system]: ${SUMMARY_PREFIX}`);

    // Output should have SUMMARY_PREFIX
    expect(result[2].content).toContain(SUMMARY_PREFIX);
    expect(result[2].content).toContain("Updated summary with new info");
  });

  it("should append contextInjection to summary", async () => {
    mockInfer.mockResolvedValueOnce({
      content: "Summary text",
      tool_calls: undefined,
      usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
      provider: "test",
      latency_ms: 50,
    });

    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "mid1" },
      { role: "user", content: "mid2" },
      { role: "assistant", content: "mid3" },
      { role: "user", content: "recent1" },
      { role: "assistant", content: "recent2" },
    ];

    const result = await compress(
      messages,
      2,
      2,
      "Current goal: Do the thing\nCriteria: pass tests",
    );

    expect(result[2].content).toContain(SUMMARY_PREFIX);
    expect(result[2].content).toContain("[ACTIVE CONTEXT]");
    expect(result[2].content).toContain("Current goal: Do the thing");
    expect(result[2].content).toContain("Criteria: pass tests");
  });

  it("should work without contextInjection (backward compat)", async () => {
    mockInfer.mockResolvedValueOnce({
      content: "Summary text",
      tool_calls: undefined,
      usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
      provider: "test",
      latency_ms: 50,
    });

    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "mid1" },
      { role: "user", content: "mid2" },
      { role: "assistant", content: "mid3" },
      { role: "user", content: "recent1" },
      { role: "assistant", content: "recent2" },
    ];

    const result = await compress(messages, 2, 2);

    expect(result[2].content).toContain(SUMMARY_PREFIX);
    expect(result[2].content).not.toContain("[ACTIVE CONTEXT]");
  });
});

describe("sanitizeToolPairs", () => {
  it("should remove orphaned tool results", () => {
    const messages: ChatMessage[] = [
      { role: "tool", content: "result", tool_call_id: "orphan-1" },
      { role: "user", content: "hello" },
    ];
    const result = sanitizeToolPairs(messages);
    expect(result.length).toBe(1);
    expect(result[0].role).toBe("user");
  });

  it("should keep matched tool results", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "tc-1",
            type: "function",
            function: { name: "test", arguments: "{}" },
          },
        ],
      },
      { role: "tool", content: "result", tool_call_id: "tc-1" },
    ];
    const result = sanitizeToolPairs(messages);
    expect(result.length).toBe(2);
  });

  it("should add stub results for orphaned tool_calls", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "tc-orphan",
            type: "function",
            function: { name: "test", arguments: "{}" },
          },
        ],
      },
    ];
    const result = sanitizeToolPairs(messages);
    expect(result.length).toBe(2);
    expect(result[1].role).toBe("tool");
    expect(result[1].tool_call_id).toBe("tc-orphan");
    expect(result[1].content).toBe("[Result compressed]");
  });
});

describe("compress — language directive (Hermes v0.11 fix)", () => {
  // Hermes May Tier-2 #7. Before the fix, both prompt paths were
  // English-only, so Spanish-MX conversations got English summaries that
  // poisoned subsequent context. These tests pin the directive on both
  // paths so a future copy-edit can't silently regress.
  const messages: ChatMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "hola" },
    { role: "assistant", content: "respuesta 1" },
    { role: "user", content: "otra pregunta" },
    { role: "assistant", content: "respuesta 2" },
    { role: "user", content: "reciente 1" },
    { role: "assistant", content: "reciente 2" },
  ];

  it("includes the conversation-language directive in the initial-compress prompt", async () => {
    mockInfer.mockResolvedValueOnce({
      content: "Resumen",
      tool_calls: undefined,
      usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
      provider: "test",
      latency_ms: 50,
    });

    await compress(messages, 2, 2);

    const prompt = mockInfer.mock.calls[0][0].messages[1].content as string;
    // Anchor on the user-language rule (W5: avoid pinning flavor text like
    // "Spanish" that would falsely fail on benign rewording).
    expect(prompt).toContain("language used by the USER");
    // Header names must still be advertised so structure stays stable
    expect(prompt).toContain("`## Intent`");
    // User-quote exception must survive — guards W3 latent conflict
    expect(prompt).toContain("verbatim quotes");
  });

  it("includes the language directive in the PRESERVE+ADD update prompt", async () => {
    mockInfer.mockResolvedValueOnce({
      content: "Resumen actualizado",
      tool_calls: undefined,
      usage: { prompt_tokens: 60, completion_tokens: 25, total_tokens: 85 },
      provider: "test",
      latency_ms: 50,
    });

    const messagesWithPrior: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hola" },
      {
        role: "system",
        content: `${SUMMARY_PREFIX} Resumen previo en español`,
      },
      { role: "assistant", content: "nueva respuesta" },
      { role: "user", content: "nueva pregunta" },
      { role: "user", content: "reciente 1" },
      { role: "assistant", content: "reciente 2" },
    ];

    await compress(messagesWithPrior, 2, 2);

    const prompt = mockInfer.mock.calls[0][0].messages[1].content as string;
    // Must use the update prompt (existing summary detected)
    expect(prompt).toContain("Update this existing summary");
    // AND must carry the language directive on this path too
    expect(prompt).toContain("language used by the USER");
    // Header-stability invariant on the path most likely to drift (W5)
    expect(prompt).toContain("`## Intent`");
    // PRESERVE+ADD continuity addendum — W1 fix
    expect(prompt).toContain("existing summary's language");
  });
});

describe("compress — anti-thrashing guards (Hermes v0.11 fix)", () => {
  // Hermes May Tier-2 #9. Two distinct thrashing surfaces previously
  // existed: (1) only the FIRST SUMMARY_PREFIX block was detected — later
  // ones were treated as raw text → summary-of-summary fidelity loss; and
  // (2) a no-new-messages compress still LLM-called the update prompt
  // with an empty New messages slot, wasting ~$0.01 + 2-5s every cycle.

  it("short-circuits the LLM call when middle has ONLY the existing summary", async () => {
    // No mockInfer setup — if compress() calls infer(), the test fails
    // because the mock has no queued response.
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" }, // head[0]
      { role: "user", content: "hola" }, // head[1]
      {
        role: "system",
        content: `${SUMMARY_PREFIX} Resumen previo de la conversación`,
      }, // middle — only the summary, no new turns
      { role: "user", content: "recent1" }, // tail[0]
      { role: "assistant", content: "recent2" }, // tail[1]
    ];

    const result = await compress(messages, 2, 2);

    // Zero LLM calls — that is the point of the guard
    expect(mockInfer).not.toHaveBeenCalled();
    // Result shape mirrors the regular path: head + summary + tail = 5
    expect(result.length).toBe(5);
    expect(result[0].content).toBe("sys");
    expect(result[1].content).toBe("hola");
    expect(result[2].role).toBe("system");
    expect(result[2].content).toContain(SUMMARY_PREFIX);
    expect(result[2].content).toContain("Resumen previo de la conversación");
    expect(result[3].content).toBe("recent1");
    expect(result[4].content).toBe("recent2");
  });

  it("preserves contextInjection AND sanitizes orphan tool pairs in tail on the short-circuit", async () => {
    // The early-return path must mirror the full path's behavior for
    // contextInjection — otherwise an active goal would silently drop on
    // no-op cycles. It must also run sanitizeToolPairs on the tail — if a
    // future refactor drops that, orphan tool messages slip through and
    // the API rejects the next round. Audit W5 fix.
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hola" },
      {
        role: "system",
        content: `${SUMMARY_PREFIX} Resumen previo`,
      },
      // Tail: orphan tool result (its assistant tool_call was compressed
      // away). sanitizeToolPairs must convert it to "[Result compressed]".
      {
        role: "tool",
        tool_call_id: "tc-orphan",
        content: "raw orphan tool result",
      },
      { role: "assistant", content: "recent2" },
    ];

    const result = await compress(messages, 2, 2, "active goal: pay bills");

    expect(mockInfer).not.toHaveBeenCalled();
    // contextInjection preserved
    expect(result[2].content).toContain("[ACTIVE CONTEXT]");
    expect(result[2].content).toContain("active goal: pay bills");
    // Orphan tool RESULT (no matching assistant tool_call in scope) is
    // REMOVED by sanitizeToolPairs — same behavior as the regular path.
    // Result length drops from 5 (raw) to 4 (orphan stripped).
    expect(result.length).toBe(4);
    expect(result.some((m) => m.role === "tool")).toBe(false);
  });

  it("collapses multiple summary blocks defensively — uses the latest", async () => {
    mockInfer.mockResolvedValueOnce({
      content: "Resumen actualizado",
      tool_calls: undefined,
      usage: { prompt_tokens: 60, completion_tokens: 25, total_tokens: 85 },
      provider: "test",
      latency_ms: 50,
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const messages: ChatMessage[] = [
      { role: "system", content: "sys" }, // head[0]
      { role: "user", content: "hola" }, // head[1]
      // Two summaries in middle — anomalous but possible (snapshot replay,
      // manual injection, future bug). The LATER one is canonical because
      // each update absorbs prior facts.
      {
        role: "system",
        content: `${SUMMARY_PREFIX} OLD summary (should be dropped)`,
      },
      { role: "user", content: "msg between summaries" },
      {
        role: "system",
        content: `${SUMMARY_PREFIX} NEW summary (canonical)`,
      },
      { role: "user", content: "post-summary new question" },
      { role: "user", content: "recent1" }, // tail[0]
      { role: "assistant", content: "recent2" }, // tail[1]
    ];

    await compress(messages, 2, 2);

    // Warn fires on the collapse
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnMsg = warnSpy.mock.calls[0][0] as string;
    expect(warnMsg).toContain("2 SUMMARY_PREFIX blocks");
    expect(warnMsg).toContain("defensive collapse");

    // Update prompt receives the LATEST summary in the "Existing summary:"
    // slot — NOT the earliest. (The pre-fix code would have used the first
    // and folded the second into "New messages:" as raw text.)
    const prompt = mockInfer.mock.calls[0][0].messages[1].content as string;
    expect(prompt).toContain("NEW summary (canonical)");
    expect(prompt).not.toContain("OLD summary (should be dropped)");

    warnSpy.mockRestore();
  });

  it("handles 3+ summary blocks (audit W7) — still uses the latest", async () => {
    mockInfer.mockResolvedValueOnce({
      content: "Resumen actualizado",
      tool_calls: undefined,
      usage: { prompt_tokens: 60, completion_tokens: 25, total_tokens: 85 },
      provider: "test",
      latency_ms: 50,
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hola" },
      { role: "system", content: `${SUMMARY_PREFIX} v1 oldest` },
      { role: "user", content: "interleaved msg" },
      { role: "system", content: `${SUMMARY_PREFIX} v2 middle` },
      { role: "system", content: `${SUMMARY_PREFIX} v3 newest (canonical)` },
      { role: "user", content: "post-summaries msg" },
      { role: "user", content: "recent1" },
      { role: "assistant", content: "recent2" },
    ];

    await compress(messages, 2, 2);

    // Warn fires with count=3
    const warnMsg = warnSpy.mock.calls[0][0] as string;
    expect(warnMsg).toContain("3 SUMMARY_PREFIX blocks");

    // Update prompt receives ONLY the newest (v3), drops v1 and v2
    const prompt = mockInfer.mock.calls[0][0].messages[1].content as string;
    expect(prompt).toContain("v3 newest (canonical)");
    expect(prompt).not.toContain("v1 oldest");
    expect(prompt).not.toContain("v2 middle");

    warnSpy.mockRestore();
  });

  it("does NOT warn when there is exactly one summary block (the normal case)", async () => {
    mockInfer.mockResolvedValueOnce({
      content: "Resumen actualizado",
      tool_calls: undefined,
      usage: { prompt_tokens: 60, completion_tokens: 25, total_tokens: 85 },
      provider: "test",
      latency_ms: 50,
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hola" },
      { role: "system", content: `${SUMMARY_PREFIX} Solo un resumen` },
      { role: "user", content: "una pregunta nueva" },
      { role: "user", content: "recent1" },
      { role: "assistant", content: "recent2" },
    ];

    await compress(messages, 2, 2);

    // Single-summary case — no defensive-collapse warning
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("compress — focusTopic posture (Tier-A cherry-pick)", () => {
  // Hermes April Tier-2 #1 §7 cherry-pick. Optional `focusTopic` biases the
  // L2 summarization prompt toward preserving topic-relevant content; never
  // drops prior facts. Tests pin the prompt addendum on both paths + the
  // clamp + the regression guard (no addendum when omitted).

  const baseMessages: ChatMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "hola" },
    { role: "assistant", content: "respuesta 1" },
    { role: "user", content: "edita src/foo.ts" },
    { role: "assistant", content: "respuesta 2" },
    { role: "user", content: "reciente 1" },
    { role: "assistant", content: "reciente 2" },
  ];

  it("appends the focusTopic addendum to the initial-compress prompt", async () => {
    mockInfer.mockResolvedValueOnce({
      content: "Resumen",
      tool_calls: undefined,
      usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
      provider: "test",
      latency_ms: 50,
    });

    await compress(
      baseMessages,
      2,
      2,
      undefined,
      "coding artifacts (file paths, diffs, errors)",
    );

    const prompt = mockInfer.mock.calls[0][0].messages[1].content as string;
    // Addendum present
    expect(prompt).toContain("ALSO prioritize preserving content related to:");
    expect(prompt).toContain("coding artifacts (file paths, diffs, errors)");
    // Floor-preserve invariant must still be in the prompt body — additive,
    // never override
    expect(prompt).toContain("does NOT permit dropping facts");
    // Ordering invariant: focus addendum FIRST (sets bias up front), then
    // LANGUAGE_RULE LAST (most-recent-wins heuristic). Mirrors the update
    // path — consistent ordering keeps prompt-shape drift detectable.
    const focusIdx = prompt.indexOf("ALSO prioritize");
    const langIdx = prompt.indexOf("language used by the USER");
    expect(focusIdx).toBeGreaterThan(-1);
    expect(focusIdx).toBeLessThan(langIdx);
  });

  it("appends the focusTopic addendum to the PRESERVE+ADD update prompt", async () => {
    mockInfer.mockResolvedValueOnce({
      content: "Resumen actualizado",
      tool_calls: undefined,
      usage: { prompt_tokens: 60, completion_tokens: 25, total_tokens: 85 },
      provider: "test",
      latency_ms: 50,
    });

    const messagesWithPrior: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hola" },
      {
        role: "system",
        content: `${SUMMARY_PREFIX} Resumen previo en español`,
      },
      { role: "assistant", content: "nueva respuesta" },
      { role: "user", content: "edita el archivo" },
      { role: "user", content: "reciente 1" },
      { role: "assistant", content: "reciente 2" },
    ];

    await compress(messagesWithPrior, 2, 2, undefined, "file paths and diffs");

    const prompt = mockInfer.mock.calls[0][0].messages[1].content as string;
    // Update path still selected (existing summary detected)
    expect(prompt).toContain("Update this existing summary");
    // Focus addendum landed on this path too
    expect(prompt).toContain("ALSO prioritize preserving content related to:");
    expect(prompt).toContain("file paths and diffs");
    // PRESERVE+ADD continuity addendum still present (W1)
    expect(prompt).toContain("existing summary's language");
    // Ordering invariant must hold on the UPDATE path too (audit W2). Future
    // copy-edits that swap LANGUAGE_RULE above focusPreamble on either path
    // get caught here, not only on the initial-compress path.
    const focusIdx = prompt.indexOf("ALSO prioritize");
    const langIdx = prompt.indexOf("language used by the USER");
    expect(focusIdx).toBeGreaterThan(-1);
    expect(focusIdx).toBeLessThan(langIdx);
  });

  it("omits the focusTopic addendum when no topic is passed (backward compat)", async () => {
    mockInfer.mockResolvedValueOnce({
      content: "Resumen",
      tool_calls: undefined,
      usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
      provider: "test",
      latency_ms: 50,
    });

    await compress(baseMessages, 2, 2);

    const prompt = mockInfer.mock.calls[0][0].messages[1].content as string;
    expect(prompt).not.toContain("ALSO prioritize preserving");
    // Sanity: the structural prompt is still there
    expect(prompt).toContain("`## Intent`");
  });

  it("clamps focusTopic to 200 chars and warns on overflow", async () => {
    mockInfer.mockResolvedValueOnce({
      content: "Resumen",
      tool_calls: undefined,
      usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
      provider: "test",
      latency_ms: 50,
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // 300-char topic: 100 chars of "A" + 100 of "B" + 100 of "C"
    const longTopic = "A".repeat(100) + "B".repeat(100) + "C".repeat(100);
    await compress(baseMessages, 2, 2, undefined, longTopic);

    const prompt = mockInfer.mock.calls[0][0].messages[1].content as string;
    // First 200 chars survive
    expect(prompt).toContain("A".repeat(100) + "B".repeat(100));
    // Last 100 chars dropped
    expect(prompt).not.toContain("C".repeat(50));

    // Warn fired
    const warnMsg = warnSpy.mock.calls[0]?.[0] as string;
    expect(warnMsg).toContain("focusTopic clamped");
    expect(warnMsg).toContain("300");
    warnSpy.mockRestore();
  });

  it("treats whitespace-only / empty focusTopic as absent", async () => {
    mockInfer.mockResolvedValueOnce({
      content: "Resumen",
      tool_calls: undefined,
      usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
      provider: "test",
      latency_ms: 50,
    });

    await compress(baseMessages, 2, 2, undefined, "   \n  \t  ");

    const prompt = mockInfer.mock.calls[0][0].messages[1].content as string;
    // No addendum from whitespace input
    expect(prompt).not.toContain("ALSO prioritize preserving");
  });

  it("skips the focusTopic LLM round on the no-op short-circuit (existingSummary + empty newMiddle)", async () => {
    // If compress() invokes infer(), the test fails — no mock queued.
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" }, // head[0]
      { role: "user", content: "hola" }, // head[1]
      { role: "system", content: `${SUMMARY_PREFIX} Resumen previo` }, // middle (only)
      { role: "user", content: "reciente 1" }, // tail[0]
      { role: "assistant", content: "reciente 2" }, // tail[1]
    ];

    const result = await compress(messages, 2, 2, undefined, "coding");

    // Short-circuit triggered (no infer call)
    expect(mockInfer).not.toHaveBeenCalled();
    // Preserved summary is the middle of the result
    const middle = result[2];
    expect(middle.role).toBe("system");
    expect((middle.content as string).startsWith(SUMMARY_PREFIX)).toBe(true);
    expect(middle.content as string).toContain("Resumen previo");
    // No FOCUS marker leaks into the in-memory [CONTEXT SUMMARY] block
    expect(middle.content as string).not.toContain("[FOCUS:");
  });
});
