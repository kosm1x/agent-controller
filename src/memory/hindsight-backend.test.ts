/**
 * Hindsight backend tests — mock the client to verify circuit breaker,
 * bank init, and method delegation.
 * Aligned with Hindsight API v2 (2026-03).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HindsightMemoryBackend } from "./hindsight-backend.js";

// Mock the client module
vi.mock("./hindsight-client.js", () => {
  return {
    HindsightClient: vi.fn().mockImplementation(() => ({
      retain: vi.fn().mockResolvedValue(undefined),
      recall: vi.fn().mockResolvedValue({
        results: [{ id: "m1", text: "test memory", type: "world" }],
      }),
      reflect: vi.fn().mockResolvedValue({ text: "test reflection" }),
      upsertBank: vi.fn().mockResolvedValue(undefined),
      health: vi.fn().mockResolvedValue({ status: "healthy" }),
    })),
  };
});

// Mock recall-utility so tests don't hit the DB; assertion-friendly spy.
const logRecallSpy = vi.fn();
vi.mock("./recall-utility.js", () => ({
  logRecall: (...args: unknown[]) => logRecallSpy(...args),
}));

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
  // Tests exercise the Hindsight code path; production default is `false`
  // (see hindsight-backend.ts isRecallPathEnabled — Hindsight's 22s reranker
  // makes the recall path pure tax until upstream is fixed).
  process.env.HINDSIGHT_RECALL_ENABLED = "true";
  backend = new HindsightMemoryBackend("http://localhost:8888", "key");
  mockClient = getMockClient();
});

afterEach(() => {
  delete process.env.HINDSIGHT_RECALL_ENABLED;
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
        expect.objectContaining({ reflect_mission: expect.any(String) }),
      );
      expect(mockClient.retain).toHaveBeenCalledWith("mc-operational", {
        content: "learned something",
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
      expect(mockClient.recall).toHaveBeenCalledWith("mc-operational", {
        query: "what happened",
        budget: "low",
        tags: undefined,
      });
    });

    it("logs a recall_audit row tagged source=hindsight on success", async () => {
      logRecallSpy.mockClear();
      await backend.recall("what happened", { bank: "mc-operational" });
      expect(logRecallSpy).toHaveBeenCalledTimes(1);
      const arg = logRecallSpy.mock.calls[0][0];
      expect(arg.bank).toBe("mc-operational");
      expect(arg.query).toBe("what happened");
      expect(arg.source).toBe("hindsight");
      expect(arg.results).toHaveLength(1);
      expect(typeof arg.latencyMs).toBe("number");
    });

    it("logs source=sqlite-fallback when Hindsight throws", async () => {
      mockClient.recall.mockRejectedValueOnce(new Error("transient"));
      logRecallSpy.mockClear();
      await backend.recall("q", { bank: "mc-operational" });
      expect(logRecallSpy).toHaveBeenCalledTimes(1);
      expect(logRecallSpy.mock.calls[0][0].source).toBe("sqlite-fallback");
    });

    it("excludes outcome:concerns and outcome:failed by default", async () => {
      mockClient.recall.mockResolvedValueOnce({
        results: [
          { id: "1", text: "good memory", tags: ["outcome:success"] },
          { id: "2", text: "concerns memory", tags: ["outcome:concerns"] },
          { id: "3", text: "failed memory", tags: ["outcome:failed"] },
          { id: "4", text: "unknown memory", tags: ["outcome:unknown"] },
          { id: "5", text: "untagged memory", tags: [] },
        ],
      });
      const results = await backend.recall("q", { bank: "mc-operational" });
      const contents = results.map((r) => r.content);
      expect(contents).toContain("good memory");
      expect(contents).toContain("unknown memory");
      expect(contents).toContain("untagged memory");
      expect(contents).not.toContain("concerns memory");
      expect(contents).not.toContain("failed memory");
      expect(results).toHaveLength(3);
    });

    it("respects explicit excludeOutcomes override", async () => {
      mockClient.recall.mockResolvedValueOnce({
        results: [
          { id: "1", text: "success", tags: ["outcome:success"] },
          { id: "2", text: "concerns", tags: ["outcome:concerns"] },
          { id: "3", text: "failed", tags: ["outcome:failed"] },
        ],
      });
      const results = await backend.recall("q", {
        bank: "mc-operational",
        excludeOutcomes: ["outcome:success"],
      });
      const contents = results.map((r) => r.content);
      expect(contents).not.toContain("success");
      expect(contents).toContain("concerns");
      expect(contents).toContain("failed");
    });

    it("empty excludeOutcomes array disables filtering", async () => {
      mockClient.recall.mockResolvedValueOnce({
        results: [
          { id: "1", text: "concerns", tags: ["outcome:concerns"] },
          { id: "2", text: "failed", tags: ["outcome:failed"] },
        ],
      });
      const results = await backend.recall("q", {
        bank: "mc-operational",
        excludeOutcomes: [],
      });
      expect(results).toHaveLength(2);
    });

    it("passes vendor tags through to MemoryItem", async () => {
      mockClient.recall.mockResolvedValueOnce({
        results: [
          {
            id: "1",
            text: "tagged",
            tags: ["telegram", "outcome:success", "conversation"],
          },
        ],
      });
      const results = await backend.recall("q", { bank: "mc-operational" });
      expect(results[0].tags).toEqual([
        "telegram",
        "outcome:success",
        "conversation",
      ]);
    });

    it("treats missing vendor tags as empty array (no false-positive exclusion)", async () => {
      mockClient.recall.mockResolvedValueOnce({
        results: [{ id: "1", text: "no tags field" }],
      });
      const results = await backend.recall("q", { bank: "mc-operational" });
      expect(results).toHaveLength(1);
      expect(results[0].tags).toEqual([]);
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
      mockClient.recall.mockResolvedValue({ results: [] });

      // Circuit is open — should return [] without calling client
      const result = await backend.recall("q", { bank: "mc-operational" });
      expect(result).toEqual([]);

      // Only the 3 failures, not the 4th
      expect(mockClient.recall).toHaveBeenCalledTimes(3);
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

    it("re-opens immediately on half-open probe failure (sticky failures)", async () => {
      // Regression: prior to 2026-04-30, isCircuitOpen() reset
      // circuit.failures to 0 when cooldown expired, so each post-cooldown
      // recall would re-pay the timeout tax up to threshold-1 times before
      // the breaker re-opened. With sticky failures, ONE probe failure
      // re-opens immediately.
      vi.useFakeTimers();
      try {
        mockClient.recall.mockRejectedValue(new Error("down"));

        // 3 failures → breaker opens
        await backend.recall("q", { bank: "mc-operational" });
        await backend.recall("q", { bank: "mc-operational" });
        await backend.recall("q", { bank: "mc-operational" });
        expect(mockClient.recall).toHaveBeenCalledTimes(3);

        // Advance past cooldown (60s + 1)
        vi.advanceTimersByTime(60_001);

        // Half-open probe: should call client once, fail, re-open
        await backend.recall("q", { bank: "mc-operational" });
        expect(mockClient.recall).toHaveBeenCalledTimes(4);

        // Subsequent recall WITHIN cooldown should short-circuit (no new
        // client call). Old behavior would have allowed 2 more probes
        // before tripping again.
        await backend.recall("q", { bank: "mc-operational" });
        await backend.recall("q", { bank: "mc-operational" });
        expect(mockClient.recall).toHaveBeenCalledTimes(4);

        // W4 (audit gap fix): proves recordFailure refreshed lastFailure on
        // the half-open failure. Advancing another full cooldown should
        // permit a NEW probe; if lastFailure had been left stale, the
        // second probe would have fired immediately at the first
        // post-cooldown call rather than after this advance.
        vi.advanceTimersByTime(60_001);
        await backend.recall("q", { bank: "mc-operational" });
        expect(mockClient.recall).toHaveBeenCalledTimes(5);
      } finally {
        vi.useRealTimers();
      }
    });

    it("closes the breaker on successful half-open probe", async () => {
      vi.useFakeTimers();
      try {
        mockClient.recall.mockRejectedValue(new Error("down"));

        // Trip the breaker
        await backend.recall("q", { bank: "mc-operational" });
        await backend.recall("q", { bank: "mc-operational" });
        await backend.recall("q", { bank: "mc-operational" });

        // Advance past cooldown
        vi.advanceTimersByTime(60_001);

        // Probe succeeds — breaker should fully close
        mockClient.recall.mockResolvedValue({
          results: [{ id: "m1", text: "ok", type: "world" }],
        });
        const probe = await backend.recall("q", { bank: "mc-operational" });
        expect(probe).toHaveLength(1);

        // Two more recalls should also pass through (no short-circuit)
        await backend.recall("q", { bank: "mc-operational" });
        await backend.recall("q", { bank: "mc-operational" });
        expect(mockClient.recall).toHaveBeenCalledTimes(6);

        // W3 (audit gap fix): probe success must have RESET the failure
        // counter, not merely flipped open=false. Two more failures
        // should NOT trip the breaker (need 3 consecutive). If counter
        // had stayed at 3, ONE failure here would re-open.
        mockClient.recall.mockRejectedValue(new Error("down again"));
        await backend.recall("q", { bank: "mc-operational" });
        await backend.recall("q", { bank: "mc-operational" });
        expect(mockClient.recall).toHaveBeenCalledTimes(8);

        // The third failure DOES trip it again (counter is 0+3=3)
        await backend.recall("q", { bank: "mc-operational" });
        await backend.recall("q", { bank: "mc-operational" });
        // 9 calls: 6 + 2 mid-failures + 1 trip-call. The 2nd post-trip
        // call short-circuits (breaker now open).
        expect(mockClient.recall).toHaveBeenCalledTimes(9);
      } finally {
        vi.useRealTimers();
      }
    });

    it("serializes concurrent recalls during the half-open window", async () => {
      // W2 (audit gap fix): without probeInFlight tracking, two recalls
      // fired in the same tick after cooldown expiry both flip open=false
      // and both pay the full Hindsight timeout. probeInFlight ensures
      // only ONE goes through; siblings short-circuit.
      vi.useFakeTimers();
      try {
        // Use a deferred mock so the probe stays in-flight while we fire
        // a sibling recall.
        let resolveProbe!: (v: unknown) => void;
        const probePromise = new Promise<unknown>((r) => {
          resolveProbe = r;
        });

        mockClient.recall.mockRejectedValue(new Error("down"));
        // Trip the breaker
        await backend.recall("q", { bank: "mc-operational" });
        await backend.recall("q", { bank: "mc-operational" });
        await backend.recall("q", { bank: "mc-operational" });
        expect(mockClient.recall).toHaveBeenCalledTimes(3);

        // Past cooldown
        vi.advanceTimersByTime(60_001);

        // Now arm the probe to hang
        mockClient.recall.mockReturnValueOnce(
          probePromise as unknown as ReturnType<typeof mockClient.recall>,
        );

        // Fire two recalls concurrently. First is the probe; second
        // should see probeInFlight=true and short-circuit.
        const firstP = backend.recall("q", { bank: "mc-operational" });
        const secondP = backend.recall("q", { bank: "mc-operational" });

        // Second should resolve quickly via SQLite fallback path even
        // though probe is hanging. Total client calls so far: 3 (trip)
        // + 1 (probe in-flight). Sibling MUST NOT add a 5th.
        await secondP;
        expect(mockClient.recall).toHaveBeenCalledTimes(4);

        // Now resolve the probe (still as failure to keep it simple)
        resolveProbe(undefined);
        try {
          await firstP;
        } catch {
          // ignore
        }
      } finally {
        vi.useRealTimers();
      }
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
          reflect_mission: expect.stringContaining("task execution"),
        }),
      );
    });
  });
});
