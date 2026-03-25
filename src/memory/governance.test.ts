/**
 * Memory governance tests — per-task store rate limiting.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Hoist mocks
const { mockRetain } = vi.hoisted(() => ({
  mockRetain: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./index.js", () => ({
  getMemoryService: () => ({
    retain: mockRetain,
    recall: vi.fn().mockResolvedValue([]),
    reflect: vi.fn().mockResolvedValue(""),
    isHealthy: vi.fn().mockResolvedValue(true),
    backend: "hindsight",
  }),
}));

import {
  memoryStoreTool,
  setMemoryTaskContext,
} from "../tools/builtin/memory.js";

describe("governance: per-task store limit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setMemoryTaskContext(null); // clear state
  });

  afterEach(() => {
    setMemoryTaskContext(null);
  });

  it("allows up to 5 stores per task", async () => {
    setMemoryTaskContext("task-1");

    for (let i = 0; i < 5; i++) {
      const result = await memoryStoreTool.execute({
        content: `observation ${i}`,
      });
      expect(result).toContain("stored");
    }

    expect(mockRetain).toHaveBeenCalledTimes(5);
  });

  it("blocks the 6th store with a warning", async () => {
    setMemoryTaskContext("task-2");

    // Exhaust the limit
    for (let i = 0; i < 5; i++) {
      await memoryStoreTool.execute({ content: `obs ${i}` });
    }

    // 6th should be blocked
    const result = await memoryStoreTool.execute({
      content: "one too many",
    });
    expect(result).toContain("warning");
    expect(result).toContain("limit reached");
    expect(mockRetain).toHaveBeenCalledTimes(5); // not 6
  });

  it("resets counter when task context is cleared", async () => {
    setMemoryTaskContext("task-3");

    for (let i = 0; i < 5; i++) {
      await memoryStoreTool.execute({ content: `obs ${i}` });
    }

    // Clear context (simulates task completion)
    setMemoryTaskContext(null);
    setMemoryTaskContext("task-4");

    // Should work again with fresh counter
    const result = await memoryStoreTool.execute({
      content: "fresh task",
    });
    expect(result).toContain("stored");
  });

  it("allows unlimited stores when no task context is set", async () => {
    // No setMemoryTaskContext call — simulates standalone tool usage
    for (let i = 0; i < 10; i++) {
      const result = await memoryStoreTool.execute({
        content: `standalone ${i}`,
      });
      expect(result).toContain("stored");
    }

    expect(mockRetain).toHaveBeenCalledTimes(10);
  });

  it("passes trust tier 3 and source agent to retain", async () => {
    setMemoryTaskContext("task-5");

    await memoryStoreTool.execute({
      content: "test observation",
      bank: "jarvis",
    });

    expect(mockRetain).toHaveBeenCalledWith("test observation", {
      bank: "mc-jarvis",
      tags: [],
      async: true,
      trustTier: 3,
      source: "agent",
    });
  });
});
