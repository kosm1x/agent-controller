import { describe, it, expect, vi, afterEach } from "vitest";
import {
  compactL0,
  compactL1,
  compactL3,
  compactConversation,
} from "./compaction-pipeline.js";
import type { ChatMessage } from "../inference/adapter.js";

// Stub only shouldCompress + compress; keep the real sanitizeToolPairs so the
// compactL1/compactL3 unit tests below are unaffected.
const { shouldCompressMock, compressMock } = vi.hoisted(() => ({
  shouldCompressMock: vi.fn(),
  compressMock: vi.fn(),
}));
vi.mock("./context-compressor.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./context-compressor.js")>();
  return {
    ...actual,
    shouldCompress: (...a: unknown[]) => shouldCompressMock(...a),
    compress: (...a: unknown[]) => compressMock(...a),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

function msg(role: string, content: string): ChatMessage {
  return { role: role as ChatMessage["role"], content } as ChatMessage;
}

function assistantWithCalls(
  content: string,
  calls: Array<{ id: string; name: string }>,
): ChatMessage {
  return {
    role: "assistant",
    content,
    tool_calls: calls.map((c) => ({
      id: c.id,
      type: "function" as const,
      function: { name: c.name, arguments: "{}" },
    })),
  } as ChatMessage;
}

function toolResult(callId: string, content: string): ChatMessage {
  return { role: "tool", content, tool_call_id: callId } as ChatMessage;
}

describe("compactL0", () => {
  it("truncates long tool results outside tail window", () => {
    const messages: ChatMessage[] = [
      msg("system", "system prompt"),
      assistantWithCalls("search", [{ id: "c1", name: "web_search" }]),
      toolResult("c1", "x".repeat(5000)),
      assistantWithCalls("search2", [{ id: "c2", name: "web_search" }]),
      toolResult("c2", "y".repeat(3000)),
      msg("assistant", "final response"),
    ];
    const { messages: result, truncated } = compactL0(messages, 2, 200);
    // Only the first tool result (index 2) is outside tail (last 2 = indices 4,5)
    // Index 4 (toolResult c2) is inside tail, so only 1 truncated
    expect(truncated).toBe(1);
    // First tool result (index 2) should be truncated
    expect((result[2].content as string).length).toBeLessThan(5000);
    expect(result[2].content).toContain("…truncated");
    // Last message (in tail) should be untouched
    expect(result[5].content).toBe("final response");
  });

  it("preserves tool results within tail window", () => {
    const messages: ChatMessage[] = [
      msg("system", "prompt"),
      assistantWithCalls("", [{ id: "c1", name: "a" }]),
      toolResult("c1", "x".repeat(5000)),
    ];
    // keepTail=2 means last 2 messages are in tail
    const { messages: result, truncated } = compactL0(messages, 2, 200);
    expect(truncated).toBe(0);
    expect(result[2].content).toBe("x".repeat(5000));
  });

  it("does not mutate original messages", () => {
    const original = toolResult("c1", "x".repeat(500));
    const messages = [msg("system", "p"), original, msg("assistant", "done")];
    compactL0(messages, 1, 50);
    expect(original.content).toBe("x".repeat(500));
  });
});

describe("compactL1", () => {
  it("removes oldest pairs from middle", () => {
    const messages: ChatMessage[] = [
      msg("system", "system"), // head[0]
      msg("user", "go"), // head[1]
      msg("assistant", "ok"), // head[2]
      // --- middle ---
      assistantWithCalls("search", [{ id: "c1", name: "web_search" }]),
      toolResult("c1", "result1"),
      assistantWithCalls("search2", [{ id: "c2", name: "web_read" }]),
      toolResult("c2", "result2"),
      assistantWithCalls("search3", [{ id: "c3", name: "web_search" }]),
      toolResult("c3", "result3"),
      assistantWithCalls("search4", [{ id: "c4", name: "web_read" }]),
      toolResult("c4", "result4"),
      // --- tail ---
      msg("user", "question"),
      assistantWithCalls("final", [{ id: "c5", name: "a" }]),
      toolResult("c5", "answer"),
      msg("assistant", "done"),
    ];
    const { messages: result, removedPairs } = compactL1(messages, 3, 4, 3);
    expect(removedPairs).toBe(3);
    expect(result.length).toBeLessThan(messages.length);
    // Head and tail should be preserved
    expect(result[0].content).toBe("system");
    expect(result[result.length - 1].content).toBe("done");
  });

  it("returns original messages when middle is empty", () => {
    const messages: ChatMessage[] = [
      msg("system", "s"),
      msg("user", "u"),
      msg("assistant", "a"),
    ];
    const { messages: result, removedPairs } = compactL1(messages, 2, 1, 3);
    expect(removedPairs).toBe(0);
    expect(result).toBe(messages);
  });
});

describe("compactConversation", () => {
  function bigConversation(): ChatMessage[] {
    return [
      msg("system", "system prompt"),
      msg("user", "go"),
      msg("assistant", "ok"),
      assistantWithCalls("s1", [{ id: "c1", name: "web_search" }]),
      toolResult("c1", "r1"),
      assistantWithCalls("s2", [{ id: "c2", name: "web_read" }]),
      toolResult("c2", "r2"),
      msg("user", "q"),
      assistantWithCalls("s3", [{ id: "c3", name: "a" }]),
      toolResult("c3", "r3"),
      msg("assistant", "done"),
    ];
  }

  it("escalates to L3 when L2 compression is still over threshold", async () => {
    // shouldCompress fires after L0, after L1, and (new) after L2. true/true
    // means L0+L1 didn't suffice; the 3rd true means the L2 summary is STILL
    // over threshold → must fall through to the deterministic L3 floor rather
    // than return an L2 result that would thrash the caller's compaction loop.
    shouldCompressMock
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true);
    compressMock.mockResolvedValue([
      msg("system", "system prompt"),
      msg("assistant", "still-huge summary"),
    ]);
    const result = await compactConversation(bigConversation(), 1000, 0.8);
    expect(result.level).toBe("L3");
    expect(compressMock).toHaveBeenCalledOnce();
  });

  it("returns L2 when compression brings it under threshold", async () => {
    shouldCompressMock
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false); // L2 result is under threshold
    compressMock.mockResolvedValue([
      msg("system", "system prompt"),
      msg("assistant", "summary"),
    ]);
    const result = await compactConversation(bigConversation(), 1000, 0.8);
    expect(result.level).toBe("L2");
  });

  it("escalates to L3 when L2 throws (all providers down)", async () => {
    shouldCompressMock.mockReturnValueOnce(true).mockReturnValueOnce(true);
    compressMock.mockRejectedValue(new Error("all providers down"));
    const result = await compactConversation(bigConversation(), 1000, 0.8);
    expect(result.level).toBe("L3");
  });

  it("passes focusTopic through to compress() at L2", async () => {
    // Tier-A cherry-pick plumbing: the pipeline must forward focusTopic
    // to compress() so the topic-biased summarization actually fires.
    // L0/L1/L3 are deterministic and ignore it.
    shouldCompressMock
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    compressMock.mockResolvedValue([
      msg("system", "system prompt"),
      msg("assistant", "summary"),
    ]);

    await compactConversation(
      bigConversation(),
      1000,
      0.8,
      "active goal: refactor router",
      "coding artifacts (file paths, diffs)",
    );

    // compress(messages, keepHead, keepTail, contextInjection, focusTopic)
    const call = compressMock.mock.calls[0];
    expect(call[3]).toBe("active goal: refactor router");
    expect(call[4]).toBe("coding artifacts (file paths, diffs)");
  });

  it("passes undefined focusTopic when caller omits it (regression guard)", async () => {
    shouldCompressMock
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    compressMock.mockResolvedValue([
      msg("system", "system prompt"),
      msg("assistant", "summary"),
    ]);

    await compactConversation(bigConversation(), 1000, 0.8);

    const call = compressMock.mock.calls[0];
    expect(call[3]).toBeUndefined();
    expect(call[4]).toBeUndefined();
  });
});

describe("compactL3", () => {
  it("preserves system message and tail", () => {
    const messages: ChatMessage[] = [
      msg("system", "important system prompt"),
      msg("user", "msg1"),
      msg("assistant", "msg2"),
      msg("user", "msg3"),
      msg("assistant", "msg4"),
      msg("user", "recent"),
      msg("assistant", "latest"),
    ];
    const { messages: result, removedCount } = compactL3(messages, 2);
    expect(result[0].content).toBe("important system prompt");
    expect(result[1].content).toContain("Emergency truncation");
    expect(result[result.length - 1].content).toBe("latest");
    expect(result[result.length - 2].content).toBe("recent");
    expect(removedCount).toBe(4); // 7 - 1 system - 2 tail
  });

  it("handles no system message", () => {
    const messages: ChatMessage[] = [
      msg("user", "msg1"),
      msg("assistant", "msg2"),
      msg("user", "recent"),
    ];
    const { messages: result } = compactL3(messages, 2);
    expect(result[0].content).toContain("Emergency truncation");
    expect(result[result.length - 1].content).toBe("recent");
  });
});
