/**
 * SqliteMemoryBackend recall-instrumentation tests (V8.1 Phase A —
 * bundle V8.1-PA-recall-logging).
 *
 * Scope: the `instrument` constructor flag and the `recall()` wrapper that
 * applies outcome bias + writes a recall_audit row when this backend is the
 * top-level memory service. The hybrid retrieval body (`recallHybrid`) and
 * the collaborators (`applyOutcomeBias`, `logRecall`) are covered by their
 * own suites — here we mock them and verify the wiring only.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// getDatabase throws → recallHybrid's outer try/catch returns [] — a
// deterministic empty `raw` so the wrapper assertions don't depend on DB
// state. writeWithRetry is imported by the module but unused on this path.
vi.mock("../db/index.js", () => ({
  getDatabase: vi.fn(() => {
    throw new Error("no db in test");
  }),
  writeWithRetry: vi.fn((fn: () => unknown) => fn()),
}));

const logRecallSpy = vi.fn();
vi.mock("./recall-utility.js", () => ({
  logRecall: (...args: unknown[]) => logRecallSpy(...args),
}));

const applyOutcomeBiasSpy = vi.fn();
vi.mock("./outcome-bias.js", () => ({
  applyOutcomeBias: (...args: unknown[]) => applyOutcomeBiasSpy(...args),
}));

import { SqliteMemoryBackend } from "./sqlite-backend.js";
import type { MemoryItem, RecallOptions } from "./types.js";

const KEPT: MemoryItem[] = [{ content: "biased-result", tags: [] }];

beforeEach(() => {
  vi.clearAllMocks();
  // Controlled bias result so we can prove the wrapper forwards `kept`,
  // `excluded`, and `breakdown` rather than the raw retrieval output.
  applyOutcomeBiasSpy.mockReturnValue({
    kept: KEPT,
    excluded: 2,
    breakdown: { success: 1, concerns: 0, failed: 2, unknown: 0 },
  });
});

const opts = (extra: Partial<RecallOptions> = {}): RecallOptions =>
  ({ bank: "mc-jarvis", ...extra }) as RecallOptions;

describe("SqliteMemoryBackend — recall instrumentation", () => {
  describe("instrument=true (primary service, the default)", () => {
    it("applies outcome bias to the raw retrieval result", async () => {
      const backend = new SqliteMemoryBackend();
      await backend.recall("query text", opts());

      expect(applyOutcomeBiasSpy).toHaveBeenCalledTimes(1);
      // raw is [] because getDatabase throws inside recallHybrid.
      const [rawArg, optsArg] = applyOutcomeBiasSpy.mock.calls[0]!;
      expect(rawArg).toEqual([]);
      expect(optsArg).toMatchObject({ bank: "mc-jarvis" });
    });

    it("writes a recall_audit row tagged source='sqlite-primary'", async () => {
      const backend = new SqliteMemoryBackend();
      await backend.recall("query text", opts());

      expect(logRecallSpy).toHaveBeenCalledTimes(1);
      const row = logRecallSpy.mock.calls[0]![0] as Record<string, unknown>;
      expect(row.source).toBe("sqlite-primary");
      expect(row.bank).toBe("mc-jarvis");
      expect(row.query).toBe("query text");
      expect(row.results).toBe(KEPT);
      expect(row.excludedCount).toBe(2);
      expect(row.outcomeBreakdown).toEqual({
        success: 1,
        concerns: 0,
        failed: 2,
        unknown: 0,
      });
      expect(typeof row.latencyMs).toBe("number");
      expect(row.latencyMs as number).toBeGreaterThanOrEqual(0);
    });

    it("returns the biased `kept` set, not the raw retrieval result", async () => {
      const backend = new SqliteMemoryBackend();
      const result = await backend.recall("query text", opts());
      expect(result).toBe(KEPT);
    });

    it("tags the row with the resolved recall mode (default: coherence)", async () => {
      const backend = new SqliteMemoryBackend();
      await backend.recall("q", opts());
      const row = logRecallSpy.mock.calls[0]![0] as Record<string, unknown>;
      expect(row.mode).toBe("coherence");
    });

    it("propagates an explicit recallMode onto the logged row", async () => {
      const backend = new SqliteMemoryBackend();
      await backend.recall("q", opts({ recallMode: "correspondence" }));
      const row = logRecallSpy.mock.calls[0]![0] as Record<string, unknown>;
      expect(row.mode).toBe("correspondence");
    });
  });

  describe("instrument=false (nested fallback / A/B tool)", () => {
    it("does NOT write a recall_audit row", async () => {
      const backend = new SqliteMemoryBackend(false);
      await backend.recall("query text", opts());
      expect(logRecallSpy).not.toHaveBeenCalled();
    });

    it("does NOT apply outcome bias — returns raw retrieval", async () => {
      const backend = new SqliteMemoryBackend(false);
      const result = await backend.recall("query text", opts());
      expect(applyOutcomeBiasSpy).not.toHaveBeenCalled();
      // raw recallHybrid output (getDatabase threw → []).
      expect(result).toEqual([]);
    });
  });
});
