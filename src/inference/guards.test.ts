/**
 * Tests for guards.ts — loop guard functions extracted from inferWithTools.
 */

import { describe, it, expect } from "vitest";
import {
  buildToolSignature,
  checkConsecutiveRepeats,
  checkStaleLoop,
  checkAnalysisParalysis,
  checkPersistentFailure,
  isTokenBudgetExceeded,
} from "./guards.js";

const tc = (name: string, args = "{}") => ({
  id: "1",
  type: "function" as const,
  function: { name, arguments: args },
});

// ---------------------------------------------------------------------------
// buildToolSignature
// ---------------------------------------------------------------------------

describe("buildToolSignature", () => {
  it("builds a sorted signature from tool calls", () => {
    const sig = buildToolSignature([
      tc("web_search", '{"q":"test"}'),
      tc("file_read", '{"path":"/tmp/x"}'),
    ]);
    expect(sig).toContain("file_read");
    expect(sig).toContain("web_search");
    // Sorted — file_read before web_search
    expect(sig.indexOf("file_read")).toBeLessThan(sig.indexOf("web_search"));
  });

  it("returns empty string for empty array", () => {
    expect(buildToolSignature([])).toBe("");
  });

  it("produces identical signatures for same calls regardless of order", () => {
    const a = buildToolSignature([tc("b", "1"), tc("a", "2")]);
    const b = buildToolSignature([tc("a", "2"), tc("b", "1")]);
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// checkConsecutiveRepeats
// ---------------------------------------------------------------------------

describe("checkConsecutiveRepeats", () => {
  it("increments count when signatures match", () => {
    expect(checkConsecutiveRepeats("sig_a", "sig_a", 0)).toBe(1);
    expect(checkConsecutiveRepeats("sig_a", "sig_a", 2)).toBe(3);
  });

  it("resets count when signatures differ", () => {
    expect(checkConsecutiveRepeats("sig_b", "sig_a", 5)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// checkStaleLoop
// ---------------------------------------------------------------------------

describe("checkStaleLoop", () => {
  it("increments when single tool returns small result", () => {
    const results = [{ content: '{"error":"not found"}' }]; // <300 chars
    expect(checkStaleLoop(results, 1, 0)).toBe(1);
  });

  it("resets when result is large (>= 300 chars)", () => {
    const results = [{ content: "x".repeat(300) }];
    expect(checkStaleLoop(results, 1, 3)).toBe(0);
  });

  it("resets when multiple tools called", () => {
    const results = [{ content: "small" }, { content: "also small" }];
    expect(checkStaleLoop(results, 2, 3)).toBe(0);
  });

  it("boundary: 299 chars counts as small", () => {
    const results = [{ content: "x".repeat(299) }];
    expect(checkStaleLoop(results, 1, 0)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// checkAnalysisParalysis
// ---------------------------------------------------------------------------

describe("checkAnalysisParalysis", () => {
  it("increments when all tools read-only and no uncalled action tools", () => {
    const calls = [tc("file_read"), tc("grep")];
    const called = new Set(["file_read", "grep", "file_write"]);
    const available = new Set(["file_write"]); // already called
    expect(checkAnalysisParalysis(calls, called, available, 0)).toBe(1);
  });

  it("does not increment when uncalled action tools exist (gathering phase)", () => {
    const calls = [tc("file_read")];
    const called = new Set(["file_read"]);
    const available = new Set(["file_write"]); // not yet called
    expect(checkAnalysisParalysis(calls, called, available, 2)).toBe(2); // frozen
  });

  it("resets when a non-read-only tool is called", () => {
    const calls = [tc("file_read"), tc("file_write")];
    const called = new Set(["file_read", "file_write"]);
    const available = new Set(["file_write"]);
    expect(checkAnalysisParalysis(calls, called, available, 4)).toBe(0);
  });

  it("returns 0 for empty tool calls", () => {
    expect(checkAnalysisParalysis([], new Set(), new Set(), 3)).toBe(0);
  });

  it("increments when no action tools available at all", () => {
    const calls = [tc("web_search")];
    const called = new Set(["web_search"]);
    const available = new Set<string>(); // no non-read-only tools
    expect(checkAnalysisParalysis(calls, called, available, 0)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// checkPersistentFailure
// ---------------------------------------------------------------------------

describe("checkPersistentFailure", () => {
  it("increments when all results are errors", () => {
    const results = [{ content: "Error: not found" }];
    expect(checkPersistentFailure(results, 0)).toBe(1);
  });

  it("resets when any result is not an error", () => {
    const results = [
      { content: "Error: timeout" },
      { content: "Success! Created file." },
    ];
    expect(checkPersistentFailure(results, 3)).toBe(0);
  });

  it("returns 0 for empty results", () => {
    expect(checkPersistentFailure([], 5)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// isTokenBudgetExceeded
// ---------------------------------------------------------------------------

describe("isTokenBudgetExceeded", () => {
  it("returns true when prompt >= budget", () => {
    expect(isTokenBudgetExceeded(28000, 28000)).toBe(true);
    expect(isTokenBudgetExceeded(30000, 28000)).toBe(true);
  });

  it("returns false when prompt < budget", () => {
    expect(isTokenBudgetExceeded(27999, 28000)).toBe(false);
  });

  it("returns false when budget is Infinity", () => {
    expect(isTokenBudgetExceeded(999999, Infinity)).toBe(false);
  });
});
