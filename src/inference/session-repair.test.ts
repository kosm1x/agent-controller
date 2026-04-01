import { describe, it, expect } from "vitest";
import { repairSession } from "./session-repair.js";
import type { ChatMessage } from "./adapter.js";

function msg(
  role: string,
  content: string,
  extra?: Partial<ChatMessage>,
): ChatMessage {
  return {
    role: role as ChatMessage["role"],
    content,
    ...extra,
  } as ChatMessage;
}

function toolResult(callId: string, content: string): ChatMessage {
  return { role: "tool", content, tool_call_id: callId } as ChatMessage;
}

function assistantWithCalls(
  content: string,
  calls: Array<{ id: string; name: string; args?: string }>,
): ChatMessage {
  return {
    role: "assistant",
    content,
    tool_calls: calls.map((c) => ({
      id: c.id,
      type: "function" as const,
      function: { name: c.name, arguments: c.args ?? "{}" },
    })),
  } as ChatMessage;
}

describe("repairSession", () => {
  it("removes orphaned ToolResults", () => {
    const messages: ChatMessage[] = [
      msg("user", "hello"),
      toolResult("orphan-123", '{"data": "stale"}'),
      msg("assistant", "hi there"),
    ];
    const stats = repairSession(messages);
    expect(stats.orphanedToolResults).toBe(1);
    expect(messages).toHaveLength(2);
    expect(messages.every((m) => m.role !== "tool")).toBe(true);
  });

  it("inserts synthetic errors for unmatched ToolUse", () => {
    const messages: ChatMessage[] = [
      msg("user", "search something"),
      assistantWithCalls("", [{ id: "call-1", name: "web_search" }]),
      // no tool result for call-1
      msg("assistant", "I found nothing"),
    ];
    const stats = repairSession(messages);
    expect(stats.syntheticErrors).toBe(1);
    expect(messages[2].role).toBe("tool");
    expect(messages[2].tool_call_id).toBe("call-1");
    expect(messages[2].content).toContain("missing");
  });

  it("deduplicates ToolResults with same tool_call_id (keeps last)", () => {
    const messages: ChatMessage[] = [
      msg("user", "go"),
      assistantWithCalls("", [{ id: "call-1", name: "web_search" }]),
      toolResult("call-1", "first result"),
      toolResult("call-1", "second result"),
    ];
    const stats = repairSession(messages);
    expect(stats.dedupedResults).toBe(1);
    expect(messages.filter((m) => m.role === "tool")).toHaveLength(1);
    expect(messages[2].content).toBe("second result");
  });

  it("merges consecutive same-role messages", () => {
    const messages: ChatMessage[] = [
      msg("user", "part 1"),
      msg("user", "part 2"),
      msg("assistant", "response"),
    ];
    const stats = repairSession(messages);
    expect(stats.mergedMessages).toBe(1);
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe("part 1\n\npart 2");
  });

  it("does NOT merge assistant messages with tool_calls", () => {
    const messages: ChatMessage[] = [
      msg("user", "go"),
      assistantWithCalls("thinking...", [{ id: "c1", name: "web_search" }]),
      toolResult("c1", "data"),
      assistantWithCalls("more...", [{ id: "c2", name: "web_read" }]),
      toolResult("c2", "more data"),
    ];
    const stats = repairSession(messages);
    expect(stats.mergedMessages).toBe(0);
    expect(messages).toHaveLength(5);
  });

  it("handles clean conversation with no repairs needed", () => {
    const messages: ChatMessage[] = [
      msg("user", "hello"),
      assistantWithCalls("let me search", [{ id: "c1", name: "web_search" }]),
      toolResult("c1", '{"results": []}'),
      msg("assistant", "No results found"),
    ];
    const stats = repairSession(messages);
    expect(stats.orphanedToolResults).toBe(0);
    expect(stats.syntheticErrors).toBe(0);
    expect(stats.dedupedResults).toBe(0);
    expect(stats.mergedMessages).toBe(0);
    expect(messages).toHaveLength(4);
  });

  it("handles all 4 issues in a single conversation", () => {
    const messages: ChatMessage[] = [
      msg("user", "part 1"),
      msg("user", "part 2"), // merge
      toolResult("orphan-1", "stale"), // orphan
      assistantWithCalls("", [
        { id: "c1", name: "web_search" },
        { id: "c2", name: "web_read" },
      ]),
      toolResult("c1", "first"), // c2 unmatched → synthetic
      toolResult("c1", "duplicate"), // dedup
    ];
    const stats = repairSession(messages);
    expect(stats.orphanedToolResults).toBe(1);
    expect(stats.dedupedResults).toBe(1);
    expect(stats.syntheticErrors).toBe(1);
    expect(stats.mergedMessages).toBe(1);
  });

  it("does NOT merge tool messages", () => {
    const messages: ChatMessage[] = [
      msg("user", "go"),
      assistantWithCalls("", [
        { id: "c1", name: "a" },
        { id: "c2", name: "b" },
      ]),
      toolResult("c1", "result 1"),
      toolResult("c2", "result 2"),
    ];
    const stats = repairSession(messages);
    expect(stats.mergedMessages).toBe(0);
    expect(messages.filter((m) => m.role === "tool")).toHaveLength(2);
  });
});
