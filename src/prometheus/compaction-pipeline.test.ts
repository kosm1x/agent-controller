import { describe, it, expect, vi, afterEach } from "vitest";
import { compactL0, compactL1, compactL3 } from "./compaction-pipeline.js";
import type { ChatMessage } from "../inference/adapter.js";

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
