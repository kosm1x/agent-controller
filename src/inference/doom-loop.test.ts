import { describe, it, expect } from "vitest";
import {
  createDoomLoopState,
  detectContentChanting,
  detectFingerprint,
  detectCycle,
  detectTextStalled,
  updateDoomLoop,
  fnv1a,
  canonicalize,
  fingerprintCalls,
  jaccardSimilarity,
} from "./doom-loop.js";
import type { RoundData } from "./doom-loop.js";

function makeToolCall(name: string, args: Record<string, unknown> = {}) {
  return { function: { name, arguments: JSON.stringify(args) } };
}

function makeToolResult(content: string) {
  return { content };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

describe("fnv1a", () => {
  it("produces consistent hashes", () => {
    expect(fnv1a("hello")).toBe(fnv1a("hello"));
  });

  it("produces different hashes for different inputs", () => {
    expect(fnv1a("hello")).not.toBe(fnv1a("world"));
  });
});

describe("canonicalize", () => {
  it("sorts object keys", () => {
    expect(canonicalize({ b: 2, a: 1 })).toBe(canonicalize({ a: 1, b: 2 }));
  });

  it("handles nested objects", () => {
    const a = { outer: { z: 1, a: 2 } };
    const b = { outer: { a: 2, z: 1 } };
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  it("handles arrays", () => {
    expect(canonicalize([1, 2, 3])).toBe("[1,2,3]");
  });

  it("handles null and primitives", () => {
    expect(canonicalize(null)).toBe("null");
    expect(canonicalize(42)).toBe("42");
    expect(canonicalize("hi")).toBe('"hi"');
  });
});

describe("fingerprintCalls", () => {
  it("produces same fingerprint for reordered JSON keys", () => {
    const a = [makeToolCall("web_search", { query: "test", limit: 5 })];
    const b = [makeToolCall("web_search", { limit: 5, query: "test" })];
    expect(fingerprintCalls(a)).toBe(fingerprintCalls(b));
  });

  it("produces different fingerprints for different args", () => {
    const a = [makeToolCall("web_search", { query: "cats" })];
    const b = [makeToolCall("web_search", { query: "dogs" })];
    expect(fingerprintCalls(a)).not.toBe(fingerprintCalls(b));
  });
});

describe("jaccardSimilarity", () => {
  it("returns 1 for identical strings", () => {
    expect(jaccardSimilarity("hello world", "hello world")).toBe(1);
  });

  it("returns 0 for completely different strings", () => {
    expect(jaccardSimilarity("aaa", "zzz")).toBe(0);
  });

  it("returns intermediate value for partially similar strings", () => {
    const sim = jaccardSimilarity("hello world foo", "hello world bar");
    expect(sim).toBeGreaterThan(0.3);
    expect(sim).toBeLessThan(1);
  });
});

// ---------------------------------------------------------------------------
// Layer 0: Content chanting
// ---------------------------------------------------------------------------

describe("detectContentChanting", () => {
  it("does NOT fire below threshold", () => {
    const state = createDoomLoopState();
    const text = "unique text chunk that is long enough to hash. ".repeat(5);
    expect(detectContentChanting(state, text, 40, 8)).toBeNull();
  });

  it("fires when same chunk appears >= threshold times", () => {
    const state = createDoomLoopState();
    const chunk = "A".repeat(200);
    // Feed the same chunk 8 times (threshold default)
    const text = chunk.repeat(8);
    const signal = detectContentChanting(state, text, 200, 8);
    expect(signal).not.toBeNull();
    expect(signal!.layer).toBe(0);
    expect(signal!.severity).toBe("high");
  });

  it("ignores text shorter than chunk size", () => {
    const state = createDoomLoopState();
    expect(detectContentChanting(state, "short", 200, 8)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Layer 1: Fingerprint
// ---------------------------------------------------------------------------

describe("detectFingerprint", () => {
  it("does NOT fire on first occurrence", () => {
    const state = createDoomLoopState();
    const calls = [makeToolCall("web_search", { q: "test" })];
    const results = [makeToolResult("some result")];
    const { signal } = detectFingerprint(state, calls, results, 3);
    expect(signal).toBeNull();
  });

  it("fires at threshold (same call + same result)", () => {
    const state = createDoomLoopState();
    const calls = [makeToolCall("web_search", { q: "test" })];
    const results = [makeToolResult("same result")];

    detectFingerprint(state, calls, results, 3);
    detectFingerprint(state, calls, results, 3);
    const { signal } = detectFingerprint(state, calls, results, 3);
    expect(signal).not.toBeNull();
    expect(signal!.layer).toBe(1);
  });

  it("does NOT fire for same call + different results", () => {
    const state = createDoomLoopState();
    const calls = [makeToolCall("web_search", { q: "test" })];

    detectFingerprint(state, calls, [makeToolResult("result 1")], 3);
    detectFingerprint(state, calls, [makeToolResult("result 2")], 3);
    const { signal } = detectFingerprint(
      state,
      calls,
      [makeToolResult("result 3")],
      3,
    );
    expect(signal).toBeNull();
  });

  it("catches reordered JSON keys as identical", () => {
    const state = createDoomLoopState();
    const calls1 = [makeToolCall("search", { a: 1, b: 2 })];
    const calls2 = [makeToolCall("search", { b: 2, a: 1 })];
    const results = [makeToolResult("same")];

    detectFingerprint(state, calls1, results, 2);
    const { signal } = detectFingerprint(state, calls2, results, 2);
    expect(signal).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Layer 2: Ping-pong cycle
// ---------------------------------------------------------------------------

describe("detectCycle", () => {
  it("detects period-2 A-B-A-B", () => {
    const state = createDoomLoopState();
    expect(detectCycle(state, "A", 6)).toBeNull();
    expect(detectCycle(state, "B", 6)).toBeNull();
    expect(detectCycle(state, "A", 6)).toBeNull();
    const signal = detectCycle(state, "B", 6);
    expect(signal).not.toBeNull();
    expect(signal!.description).toContain("period-2");
  });

  it("detects period-3 A-B-C-A-B-C", () => {
    const state = createDoomLoopState();
    detectCycle(state, "A", 8);
    detectCycle(state, "B", 8);
    detectCycle(state, "C", 8);
    detectCycle(state, "A", 8);
    detectCycle(state, "B", 8);
    const signal = detectCycle(state, "C", 8);
    expect(signal).not.toBeNull();
    expect(signal!.description).toContain("period-3");
  });

  it("does NOT fire on non-cyclic sequences", () => {
    const state = createDoomLoopState();
    for (const sig of ["A", "B", "C", "D", "E", "F"]) {
      expect(detectCycle(state, sig, 6)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Layer 3: Jaccard
// ---------------------------------------------------------------------------

describe("detectTextStalled", () => {
  it("does NOT fire until window is full", () => {
    const state = createDoomLoopState();
    const text =
      "This is a moderately long text response from the LLM that should be enough chars.";
    expect(detectTextStalled(state, text, 4, 0.85)).toBeNull();
    expect(detectTextStalled(state, text, 4, 0.85)).toBeNull();
    expect(detectTextStalled(state, text, 4, 0.85)).toBeNull();
    // 4th text fills the window — all identical → should fire
    const signal = detectTextStalled(state, text, 4, 0.85);
    expect(signal).not.toBeNull();
    expect(signal!.layer).toBe(3);
  });

  it("does NOT fire when texts are sufficiently different", () => {
    const state = createDoomLoopState();
    detectTextStalled(
      state,
      "The quick brown fox jumps over the lazy dog and more text to meet minimum length",
      4,
      0.85,
    );
    detectTextStalled(
      state,
      "A completely different response about cats and dogs playing in the park together today",
      4,
      0.85,
    );
    detectTextStalled(
      state,
      "Yet another unique text about cooking recipes and ingredient lists for dinner tonight",
      4,
      0.85,
    );
    const signal = detectTextStalled(
      state,
      "Final response about quantum physics and the nature of reality in the universe",
      4,
      0.85,
    );
    expect(signal).toBeNull();
  });

  it("skips very short responses", () => {
    const state = createDoomLoopState();
    for (let i = 0; i < 5; i++) {
      expect(detectTextStalled(state, "ok", 4, 0.85)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: updateDoomLoop
// ---------------------------------------------------------------------------

describe("updateDoomLoop", () => {
  it("returns null for normal round", () => {
    const state = createDoomLoopState();
    const round: RoundData = {
      toolCalls: [makeToolCall("web_search", { q: "unique query" })],
      toolResults: [makeToolResult("unique result")],
      llmText: "A unique response text that is different each time.",
    };
    expect(updateDoomLoop(state, round)).toBeNull();
  });

  it("detects doom loop via fingerprint after repeated identical rounds", () => {
    const state = createDoomLoopState();
    const round: RoundData = {
      toolCalls: [makeToolCall("web_search", { q: "stuck" })],
      toolResults: [makeToolResult("same result")],
      llmText: "",
    };
    updateDoomLoop(state, round);
    updateDoomLoop(state, round);
    const signal = updateDoomLoop(state, round);
    expect(signal).not.toBeNull();
    expect(signal!.layer).toBe(1);
  });
});
