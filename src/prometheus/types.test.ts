/**
 * Tests for shared type utilities.
 */

import { describe, it, expect } from "vitest";
import {
  parseLLMJson,
  defaultConfig,
  convergenceScore,
  LLMJsonParseError,
} from "./types.js";

describe("parseLLMJson", () => {
  it("should parse plain JSON", () => {
    const result = parseLLMJson<{ key: string }>('{"key": "value"}');
    expect(result.key).toBe("value");
  });

  it("should strip ```json fences", () => {
    const input = '```json\n{"goals": []}\n```';
    const result = parseLLMJson<{ goals: unknown[] }>(input);
    expect(result.goals).toEqual([]);
  });

  it("should strip ``` fences without language", () => {
    const input = '```\n{"data": 42}\n```';
    const result = parseLLMJson<{ data: number }>(input);
    expect(result.data).toBe(42);
  });

  it("should handle whitespace around fences", () => {
    const input = '  ```json\n{"ok": true}\n```  ';
    const result = parseLLMJson<{ ok: boolean }>(input);
    expect(result.ok).toBe(true);
  });

  it("should throw a typed LLMJsonParseError on invalid JSON", () => {
    expect(() => parseLLMJson("not json at all")).toThrow(LLMJsonParseError);
  });

  it("should throw on empty input", () => {
    expect(() => parseLLMJson("")).toThrow();
  });

  // ---------------------------------------------------------------------------
  // v7.6 Spine 1 G8 — error.message never carries raw LLM content
  // ---------------------------------------------------------------------------

  it("error.message NEVER contains raw LLM content (no-object stage)", () => {
    const sentinel = "SECRET-INTERNAL-LLM-OUTPUT-AAAAAAAAAA";
    let caught: unknown = null;
    try {
      parseLLMJson(`Here is some prose with ${sentinel} in it`);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LLMJsonParseError);
    const err = caught as LLMJsonParseError;
    expect(err.message).not.toContain(sentinel);
    expect(err.message).toBe("LLM returned unparseable JSON");
  });

  it("error.message NEVER contains raw LLM content (extracted-invalid stage)", () => {
    const sentinel = "POISON-PAYLOAD-XYZ";
    // Valid `{...}` braces but invalid JSON inside (trailing comma) so the
    // extraction path runs but JSON.parse on the extracted slice fails.
    const input = `${sentinel} prefix\n{"key": "${sentinel}", "trailing": ,}`;
    let caught: unknown = null;
    try {
      parseLLMJson(input);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LLMJsonParseError);
    const err = caught as LLMJsonParseError;
    expect(err.message).not.toContain(sentinel);
    expect(err.message).toBe("LLM returned unparseable JSON");
  });

  it("rawSample is operator-visible and bounded to 500 chars", () => {
    const long = "A".repeat(2000);
    let caught: unknown = null;
    try {
      parseLLMJson(long);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LLMJsonParseError);
    const err = caught as LLMJsonParseError;
    expect(err.rawSample.length).toBe(500);
    expect(err.rawSample).toContain("AAA");
  });

  it("stage discriminates no-object vs extracted-invalid", () => {
    let stage1: unknown = null;
    try {
      parseLLMJson("plain prose without any braces at all");
    } catch (err) {
      stage1 = err;
    }
    expect((stage1 as LLMJsonParseError).stage).toBe("no-object");

    let stage2: unknown = null;
    try {
      parseLLMJson(`prefix {"oops": ,}`);
    } catch (err) {
      stage2 = err;
    }
    expect((stage2 as LLMJsonParseError).stage).toBe("extracted-invalid");
  });

  it("diagnosticDetail() is operator-only (separate from .message)", () => {
    const sentinel = "OPERATOR-ONLY-DETAIL";
    let caught: unknown = null;
    try {
      parseLLMJson(`${sentinel} not json`);
    } catch (err) {
      caught = err;
    }
    const err = caught as LLMJsonParseError;
    // diagnosticDetail() includes the rawSample for journalctl
    expect(err.diagnosticDetail()).toContain(sentinel);
    // .message remains generic
    expect(err.message).not.toContain(sentinel);
  });

  // Syntactic regression guard — protects against a future "let me just
  // include the raw content in the message for easier debugging" diff that
  // would re-introduce the leak. If anyone changes LLMJsonParseError to
  // embed rawSample in message, this trips.
  it("guards against re-introducing raw-content in error.message", () => {
    const tests = [
      "garbage prose 123",
      "{trailing comma,}",
      `prefix {"oops": "${"X".repeat(400)}"}` /* invalid wrap */,
    ];
    for (const input of tests) {
      let err: LLMJsonParseError | null = null;
      try {
        parseLLMJson(input);
      } catch (e) {
        if (e instanceof LLMJsonParseError) err = e;
      }
      if (err) {
        // The .message must be exactly the generic string. No append, no
        // suffix, no embedded sample. If it ever changes, the test author
        // must update both this assertion AND verify nothing user-facing
        // shows the change (router.ts:2321, dynamic.ts:574).
        expect(err.message).toBe("LLM returned unparseable JSON");
      }
    }
  });

  it("should extract JSON from CoT-prefixed prose (autoreason)", () => {
    const input =
      `Let me think step by step:\n` +
      `1. First I considered X.\n` +
      `2. Then Y.\n\n` +
      `{"met": true, "reasoning": "done"}`;
    const result = parseLLMJson<{ met: boolean; reasoning: string }>(input);
    expect(result.met).toBe(true);
    expect(result.reasoning).toBe("done");
  });

  it("should extract the LAST JSON object when multiple appear in prose", () => {
    const input =
      `Example output: {"met": false, "reasoning": "example"}\n\n` +
      `Actual verdict:\n{"met": true, "reasoning": "real"}`;
    const result = parseLLMJson<{ met: boolean; reasoning: string }>(input);
    expect(result.met).toBe(true);
    expect(result.reasoning).toBe("real");
  });

  it("should handle braces inside string literals correctly", () => {
    // The `}` inside the string must NOT close the outer object early.
    const input = `Reasoning: the output is fine.\n\n{"note": "looks like {stub}", "ok": true}`;
    const result = parseLLMJson<{ note: string; ok: boolean }>(input);
    expect(result.note).toBe("looks like {stub}");
    expect(result.ok).toBe(true);
  });

  it("should handle nested objects in CoT output", () => {
    const input = `After thinking:\n{"outer": {"inner": {"deep": 42}}, "flag": true}`;
    const result = parseLLMJson<{
      outer: { inner: { deep: number } };
      flag: boolean;
    }>(input);
    expect(result.outer.inner.deep).toBe(42);
    expect(result.flag).toBe(true);
  });
});

describe("defaultConfig", () => {
  it("should return sensible defaults", () => {
    const config = defaultConfig();
    expect(config.maxTurns).toBe(50);
    expect(config.maxReplans).toBe(3);
    expect(config.maxIterations).toBe(90);
    expect(config.timeoutMs).toBe(600_000);
    expect(config.goalTimeoutMs).toBe(120_000);
    expect(config.replanThresholds.toolFailureRate).toBe(0.5);
    expect(config.replanThresholds.goalBlocked).toBe(true);
    expect(config.replanThresholds.toolCallsPerGoal).toBe(10.0);
  });

  it("should accept overrides", () => {
    const config = defaultConfig({ maxTurns: 10 });
    expect(config.maxTurns).toBe(10);
    expect(config.maxReplans).toBe(3); // unchanged
  });
});

describe("convergenceScore (H1)", () => {
  it("returns score 0 for zero calls", () => {
    expect(convergenceScore(0, 0)).toEqual({ score: 0, looping: false });
  });

  it("detects looping when ratio exceeds 3.0", () => {
    const r = convergenceScore(10, 2);
    expect(r.score).toBe(5);
    expect(r.looping).toBe(true);
  });

  it("does not flag looping within threshold", () => {
    const r = convergenceScore(6, 3);
    expect(r.score).toBe(2);
    expect(r.looping).toBe(false);
  });

  it("handles single unique tool (worst case)", () => {
    expect(convergenceScore(15, 1).looping).toBe(true);
  });

  it("does not loop at exactly 3.0", () => {
    expect(convergenceScore(9, 3).looping).toBe(false);
  });
});
