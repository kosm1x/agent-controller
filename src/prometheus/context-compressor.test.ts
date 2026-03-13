/**
 * Context compressor tests — compression trigger, tool pair sanitization, fallback.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatMessage } from "../inference/adapter.js";

vi.mock("../inference/adapter.js", () => ({
  infer: vi.fn(),
}));

import {
  shouldCompress,
  compress,
  sanitizeToolPairs,
} from "./context-compressor.js";
import { infer } from "../inference/adapter.js";

const mockInfer = vi.mocked(infer);

beforeEach(() => {
  vi.clearAllMocks();
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
    expect(result[2].content).toBe("Summary of middle conversation");
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
    // Summary should contain fallback marker
    expect(result[2].content).toContain("compressed");
    expect(result[2].content).toContain("3 messages removed");
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
