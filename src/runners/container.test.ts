/**
 * Container helpers unit tests.
 * Tests name generation and sentinel output parsing.
 */

import { describe, it, expect } from "vitest";
import {
  generateContainerName,
  parsePayload,
  OUTPUT_START_MARKER,
  OUTPUT_END_MARKER,
} from "./container.js";

describe("generateContainerName", () => {
  it("should generate mc- prefixed names", () => {
    const name = generateContainerName("test");
    expect(name).toMatch(/^mc-test-\d+$/);
  });

  it("should sanitize special characters", () => {
    const name = generateContainerName("My Task!@#$");
    expect(name).toMatch(/^mc-my-task--\d+$/);
  });

  it("should truncate long prefixes", () => {
    const name = generateContainerName("a".repeat(100));
    // mc- + 30 chars max + - + timestamp
    expect(name.startsWith("mc-")).toBe(true);
    const parts = name.split("-");
    expect(parts[1].length).toBeLessThanOrEqual(30);
  });

  it("should use default prefix", () => {
    const name = generateContainerName();
    expect(name).toMatch(/^mc-task-\d+$/);
  });
});

describe("sentinel markers", () => {
  it("should have distinct start and end markers", () => {
    expect(OUTPUT_START_MARKER).not.toBe(OUTPUT_END_MARKER);
    expect(OUTPUT_START_MARKER).toContain("START");
    expect(OUTPUT_END_MARKER).toContain("END");
  });
});

// -------------------------------------------------------------------------
// parsePayload — host-side discrimination of worker heartbeat vs final result.
// Extracted from spawnContainer() closure 2026-05-23 (qa-audit W1 fold) so
// the progress branch can be exercised without standing up a docker
// subprocess. The closure now delegates and applies the imperative state
// updates (resetTimer / lastOutput); behavior preserved.
// -------------------------------------------------------------------------

describe("parsePayload", () => {
  it("returns progress kind for type:'progress' payload, no output", () => {
    const result = parsePayload(
      JSON.stringify({ type: "progress", elapsedMs: 120000 }),
    );
    expect(result.kind).toBe("progress");
    expect(result.output).toBeUndefined();
  });

  it("returns result kind with success output for type:'result' payload", () => {
    const result = parsePayload(
      JSON.stringify({
        type: "result",
        success: true,
        content: "done",
        durationMs: 5000,
      }),
    );
    expect(result.kind).toBe("result");
    expect(result.output?.status).toBe("success");
    expect(result.output?.error).toBeUndefined();
  });

  it("returns result kind with error output when payload has error field", () => {
    const result = parsePayload(
      JSON.stringify({ type: "result", error: "Orchestration crashed" }),
    );
    expect(result.kind).toBe("result");
    expect(result.output?.status).toBe("error");
    expect(result.output?.error).toBe("Orchestration crashed");
  });

  it("treats untyped payload as result (backward compat for older workers)", () => {
    // A future worker (or older one) that forgets the discriminator should
    // still resolve as a final result, not be silently discarded.
    const result = parsePayload(
      JSON.stringify({ success: true, content: "legacy" }),
    );
    expect(result.kind).toBe("result");
    expect(result.output?.status).toBe("success");
  });

  it("treats near-miss type values as result (not progress)", () => {
    // qa-audit W3 boundary case — substring matching on 'progress' must
    // NOT happen; only the literal `type === "progress"` opens the branch.
    expect(parsePayload(JSON.stringify({ type: "progressing" })).kind).toBe(
      "result",
    );
    expect(parsePayload(JSON.stringify({ type: "result" })).kind).toBe(
      "result",
    );
    expect(parsePayload(JSON.stringify({ type: "PROGRESS" })).kind).toBe(
      "result",
    );
  });

  it("falls back to raw-string success output for malformed JSON", () => {
    // The closure's pre-extraction behavior preserved: anything that
    // can't parse as JSON becomes a success result with the raw text.
    const result = parsePayload("not json at all");
    expect(result.kind).toBe("result");
    expect(result.output?.status).toBe("success");
    expect(result.output?.result).toBe("not json at all");
  });
});
