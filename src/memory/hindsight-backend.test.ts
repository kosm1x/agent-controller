/**
 * Hindsight backend tests — mock the client to verify circuit breaker,
 * bank init, and method delegation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { HindsightMemoryBackend } from "./hindsight-backend.js";

// Mock the client module
vi.mock("./hindsight-client.js", () => {
  return {
    HindsightClient: vi.fn().mockImplementation(() => ({
      retain: vi.fn().mockResolvedValue(undefined),
      recall: vi.fn().mockResolvedValue({
        memories: [
          { content: "test memory", relevance: 0.9, created_at: "2026-01-01" },
        ],
      }),
      reflect: vi.fn().mockResolvedValue({ reflection: "test reflection" }),
      upsertBank: vi.fn().mockResolvedValue(undefined),
      health: vi.fn().mockResolvedValue({ status: "ok" }),
    })),
  };
});

import { HindsightClient } from "./hindsight-client.js";

let backend: HindsightMemoryBackend;
let mockClient: ReturnType<typeof getMockClient>;

function getMockClient() {
  // Access the mock instance created by the constructor
  return vi.mocked(HindsightClient).mock.results[0]?.value as unknown as {
    retain: ReturnType<typeof vi.fn>;
    recall: ReturnType<typeof vi.fn>;
    reflect: ReturnType<typeof vi.fn>;
    upsertBank: ReturnType<typeof vi.fn>;
    health: ReturnType<typeof vi.fn>;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  backend = new HindsightMemoryBackend("http://localhost:8888", "key");
  mockClient = getMockClient();
});

describe("HindsightMemoryBackend", () => {
  describe("retain", () => {
    it("should store memory via client", async () => {
      await backend.retain("learned something", {
        bank: "mc-operational",
        tags: ["test"],
        taskId: "task-1",
      });

      expect(mockClient.upsertBank).toHaveBeenCalledWith(
        "mc-operational",
        expect.objectContaining({ mission: expect.any(String) }),
      );
      expect(mockClient.retain).toHaveBeenCalledWith("mc-operational", {
        observation: "learned something",
        tags: ["test"],
        async: true,
      });
    });

    it("should default async to true", async () => {
      await backend.retain("test", { bank: "mc-operational" });

      expect(mockClient.retain).toHaveBeenCalledWith(
        "mc-operational",
        expect.objectContaining({ async: true }),
      );
    });

    it("should respect explicit async: false", async () => {
      await backend.retain("test", {
        bank: "mc-operational",
        async: false,
      });

      expect(mockClient.retain).toHaveBeenCalledWith(
        "mc-operational",
        expect.objectContaining({ async: false }),
      );
    });
  });

  describe("recall", () => {
    it("should search memories and return mapped results", async () => {
      const results = await backend.recall("what happened", {
        bank: "mc-operational",
        maxResults: 5,
      });

      expect(results).toHaveLength(1);
      expect(results[0].content).toBe("test memory");
      expect(results[0].relevance).toBe(0.9);
      expect(mockClient.recall).toHaveBeenCalledWith("mc-operational", {
        query: "what happened",
        budget: "low",
        tags: undefined,
        max_results: 5,
      });
    });
  });

  describe("reflect", () => {
    it("should return synthesized reflection", async () => {
      const result = await backend.reflect("patterns", {
        bank: "mc-operational",
      });

      expect(result).toBe("test reflection");
      expect(mockClient.reflect).toHaveBeenCalledWith("mc-operational", {
        query: "patterns",
        budget: "mid",
        tags: undefined,
      });
    });
  });

  describe("isHealthy", () => {
    it("should return true when Hindsight is healthy", async () => {
      expect(await backend.isHealthy()).toBe(true);
    });

    it("should return false on health check failure", async () => {
      mockClient.health.mockRejectedValueOnce(new Error("Connection refused"));
      expect(await backend.isHealthy()).toBe(false);
    });
  });

  describe("circuit breaker", () => {
    it("should open circuit after 3 failures", async () => {
      mockClient.recall.mockRejectedValue(new Error("down"));

      // 3 failures trigger circuit open
      await backend.recall("q", { bank: "mc-operational" });
      await backend.recall("q", { bank: "mc-operational" });
      await backend.recall("q", { bank: "mc-operational" });

      // Reset mock to see if 4th call goes through
      mockClient.recall.mockResolvedValue({ memories: [] });

      // Circuit is open — should return [] without calling client
      const result = await backend.recall("q", { bank: "mc-operational" });
      expect(result).toEqual([]);

      // The 4th call should NOT have triggered upsertBank (circuit open)
      // Client was called for bank init + 3 failures = multiple times
      // After circuit opens, no more calls happen
      const totalRecallCalls = mockClient.recall.mock.calls.length;
      expect(totalRecallCalls).toBe(3); // Only the 3 failures, not the 4th
    });

    it("should not block retain when circuit is open", async () => {
      // Open the circuit via retain failures
      mockClient.retain.mockRejectedValue(new Error("down"));

      await backend.retain("a", { bank: "mc-operational" });
      await backend.retain("b", { bank: "mc-operational" });
      await backend.retain("c", { bank: "mc-operational" });

      // Circuit is open — retain should silently skip
      mockClient.retain.mockResolvedValue(undefined);
      await backend.retain("d", { bank: "mc-operational" });

      // Only 3 calls to retain (the 4th was skipped)
      expect(mockClient.retain).toHaveBeenCalledTimes(3);
    });
  });

  describe("lazy bank creation", () => {
    it("should create bank on first use and cache", async () => {
      await backend.recall("q1", { bank: "mc-operational" });
      await backend.recall("q2", { bank: "mc-operational" });

      // upsertBank called only once (cached after first)
      expect(mockClient.upsertBank).toHaveBeenCalledTimes(1);
      expect(mockClient.upsertBank).toHaveBeenCalledWith(
        "mc-operational",
        expect.objectContaining({
          mission: expect.stringContaining("task execution"),
        }),
      );
    });
  });
});
