/**
 * Ship C (2026-04-30) — recall-compare module tests.
 *
 * Mocks both backends; verifies parallel execution, timeout isolation,
 * top-N trimming, and error handling per side.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const hindsightRecallSpy = vi.fn();
const sqliteRecallSpy = vi.fn();

vi.mock("./hindsight-client.js", () => ({
  HindsightClient: vi.fn().mockImplementation(() => ({
    recall: hindsightRecallSpy,
  })),
}));

vi.mock("./sqlite-backend.js", () => ({
  SqliteMemoryBackend: vi.fn().mockImplementation(() => ({
    recall: sqliteRecallSpy,
  })),
}));

import { compareBackends } from "./recall-compare.js";

beforeEach(() => {
  hindsightRecallSpy.mockReset();
  sqliteRecallSpy.mockReset();
});

describe("compareBackends", () => {
  it("returns top-3 from each backend in parallel", async () => {
    hindsightRecallSpy.mockResolvedValue({
      results: [
        { text: "hindsight 1", tags: ["a"] },
        { text: "hindsight 2" },
        { text: "hindsight 3" },
        { text: "hindsight 4" },
      ],
    });
    sqliteRecallSpy.mockResolvedValue([
      { content: "sqlite 1", tags: [] },
      { content: "sqlite 2" },
      { content: "sqlite 3" },
    ]);

    const r = await compareBackends("test query", "mc-jarvis");

    expect(r.query).toBe("test query");
    expect(r.bank).toBe("mc-jarvis");
    expect(r.hindsight.results).toHaveLength(3);
    expect(r.hindsight.totalCount).toBe(4);
    expect(r.hindsight.results[0].content).toBe("hindsight 1");
    expect(r.hindsight.results[0].tags).toEqual(["a"]);
    expect(r.hindsight.error).toBeUndefined();
    expect(r.sqlite.results).toHaveLength(3);
    expect(r.sqlite.totalCount).toBe(3);
    expect(r.sqlite.results[0].content).toBe("sqlite 1");
    expect(r.sqlite.error).toBeUndefined();
  });

  it("respects custom topN", async () => {
    hindsightRecallSpy.mockResolvedValue({
      results: Array.from({ length: 10 }, (_, i) => ({ text: `r${i}` })),
    });
    sqliteRecallSpy.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => ({ content: `s${i}` })),
    );
    const r = await compareBackends("q", "mc-jarvis", { topN: 5 });
    expect(r.hindsight.results).toHaveLength(5);
    expect(r.sqlite.results).toHaveLength(5);
  });

  it("returns error sentinel when Hindsight throws (sqlite still runs)", async () => {
    hindsightRecallSpy.mockRejectedValue(new Error("connection refused"));
    sqliteRecallSpy.mockResolvedValue([{ content: "sqlite ok" }]);

    const r = await compareBackends("q", "mc-jarvis");
    expect(r.hindsight.error).toContain("connection refused");
    expect(r.hindsight.results).toEqual([]);
    expect(r.sqlite.error).toBeUndefined();
    expect(r.sqlite.results[0].content).toBe("sqlite ok");
  });

  it("returns error sentinel when SQLite throws (hindsight still runs)", async () => {
    hindsightRecallSpy.mockResolvedValue({
      results: [{ text: "hindsight ok" }],
    });
    sqliteRecallSpy.mockRejectedValue(new Error("DB locked"));

    const r = await compareBackends("q", "mc-jarvis");
    expect(r.hindsight.results[0].content).toBe("hindsight ok");
    expect(r.sqlite.error).toContain("DB locked");
    expect(r.sqlite.results).toEqual([]);
  });

  it("times out a slow backend without blocking the other", async () => {
    // Hindsight takes 1s, SQLite returns immediately.
    hindsightRecallSpy.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ results: [{ text: "late" }] }), 1000),
        ),
    );
    sqliteRecallSpy.mockResolvedValue([{ content: "sqlite fast" }]);

    const start = Date.now();
    const r = await compareBackends("q", "mc-jarvis", { timeoutMs: 100 });
    const elapsed = Date.now() - start;

    // Should have completed at the timeout boundary, not waited the full 1s
    expect(elapsed).toBeLessThan(500);
    expect(r.hindsight.error).toContain("timeout");
    expect(r.hindsight.results).toEqual([]);
    expect(r.sqlite.results[0].content).toBe("sqlite fast");
  });

  it("trims long content to ≤200 chars with ellipsis", async () => {
    const long = "x".repeat(500);
    hindsightRecallSpy.mockResolvedValue({ results: [{ text: long }] });
    sqliteRecallSpy.mockResolvedValue([{ content: long }]);
    const r = await compareBackends("q", "mc-jarvis");
    expect(r.hindsight.results[0].content.length).toBeLessThanOrEqual(200);
    expect(r.hindsight.results[0].content.endsWith("…")).toBe(true);
    expect(r.sqlite.results[0].content.length).toBeLessThanOrEqual(200);
  });

  it("preserves bank parameter in result", async () => {
    hindsightRecallSpy.mockResolvedValue({ results: [] });
    sqliteRecallSpy.mockResolvedValue([]);
    const r = await compareBackends("q", "mc-operational");
    expect(r.bank).toBe("mc-operational");
  });

  it("handles backends returning empty result sets", async () => {
    hindsightRecallSpy.mockResolvedValue({ results: [] });
    sqliteRecallSpy.mockResolvedValue([]);
    const r = await compareBackends("q", "mc-jarvis");
    expect(r.hindsight.results).toEqual([]);
    expect(r.hindsight.totalCount).toBe(0);
    expect(r.hindsight.error).toBeUndefined();
    expect(r.sqlite.results).toEqual([]);
  });

  it("returns shape-stable result when BOTH sides fail (W5)", async () => {
    // Both Hindsight and SQLite throw — shape must still match the
    // contract that mc-ctl reads (`.hindsight.error`, `.sqlite.error`,
    // `.hindsight.results`, `.sqlite.results`). Without this test a
    // future refactor that returns null on a failed side would silently
    // break the bash consumer.
    hindsightRecallSpy.mockRejectedValue(new Error("hindsight down"));
    sqliteRecallSpy.mockRejectedValue(new Error("db locked"));

    const r = await compareBackends("q", "mc-jarvis");
    expect(r.hindsight.error).toContain("hindsight down");
    expect(r.hindsight.results).toEqual([]);
    expect(r.hindsight.totalCount).toBe(0);
    expect(typeof r.hindsight.latencyMs).toBe("number");
    expect(r.sqlite.error).toContain("db locked");
    expect(r.sqlite.results).toEqual([]);
    expect(r.sqlite.totalCount).toBe(0);
    expect(typeof r.sqlite.latencyMs).toBe("number");
  });

  it("returns shape-stable result when BOTH sides time out", async () => {
    hindsightRecallSpy.mockImplementation(
      () => new Promise(() => {}), // never resolves
    );
    sqliteRecallSpy.mockImplementation(
      () => new Promise(() => {}), // never resolves
    );
    const r = await compareBackends("q", "mc-jarvis", { timeoutMs: 50 });
    expect(r.hindsight.error).toContain("timeout");
    expect(r.sqlite.error).toContain("timeout");
    expect(r.hindsight.results).toEqual([]);
    expect(r.sqlite.results).toEqual([]);
  });

  it("handles missing tags / undefined content gracefully", async () => {
    hindsightRecallSpy.mockResolvedValue({
      results: [{ text: undefined }, { text: "ok" }],
    });
    sqliteRecallSpy.mockResolvedValue([
      { content: undefined },
      { content: "ok" },
    ]);
    const r = await compareBackends("q", "mc-jarvis");
    expect(r.hindsight.results).toHaveLength(2);
    expect(r.hindsight.results[0].content).toBe("");
    expect(r.sqlite.results[0].content).toBe("");
  });
});
