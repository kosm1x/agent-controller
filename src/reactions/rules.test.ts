/**
 * Tests for reaction rules.
 */

import { describe, it, expect } from "vitest";
import {
  suppressionRule,
  transientRetryRule,
  adjustedRetryRule,
  escalateRule,
  evaluateRules,
  DEFAULT_RULES,
} from "./rules.js";
import type { ReactionContext } from "./types.js";
import type { TaskRow } from "../dispatch/dispatcher.js";

function makeContext(
  overrides: Partial<ReactionContext> = {},
): ReactionContext {
  return {
    task: {
      id: 1,
      task_id: "t-1",
      parent_task_id: null,
      spawn_type: "root",
      title: "Test task",
      description: "Do something",
      priority: "medium",
      status: "failed",
      agent_type: "fast",
      classification: null,
      assigned_to: null,
      input: null,
      output: null,
      error: "Something went wrong",
      progress: 0,
      metadata: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    } as TaskRow,
    error: "Something went wrong",
    previousAttempts: 0,
    classificationFailures24h: 0,
    ...overrides,
  };
}

describe("reaction rules", () => {
  describe("suppressionRule", () => {
    it("suppresses when 3+ classification failures in 24h", () => {
      const ctx = makeContext({ classificationFailures24h: 3 });
      const result = suppressionRule.evaluate(ctx);
      expect(result).not.toBeNull();
      expect(result!.action).toBe("suppress");
    });

    it("does not suppress when fewer than 3 failures", () => {
      const ctx = makeContext({ classificationFailures24h: 2 });
      expect(suppressionRule.evaluate(ctx)).toBeNull();
    });
  });

  describe("transientRetryRule", () => {
    const transientErrors = [
      "Request timeout after 30s",
      "ECONNRESET: connection reset",
      "ECONNREFUSED: connection refused",
      "ETIMEDOUT: timed out",
      "rate limit exceeded (429)",
      "503 Service Unavailable",
      "ENOTFOUND: DNS lookup failed",
      "socket hang up",
      "write EPIPE",
      // Regression: the original /timeout/ pattern missed "timed out" with a
      // space, letting container timeouts fall through to adjustedRetryRule
      // and bypass the MAX_RETRIES cap. All three spellings must match.
      "Container timed out after 300000ms",
      "Request time out after 45s",
      "Task timedout during execution",
    ];

    for (const error of transientErrors) {
      it(`retries on transient error: "${error}"`, () => {
        const ctx = makeContext({ error, previousAttempts: 0 });
        const result = transientRetryRule.evaluate(ctx);
        expect(result).not.toBeNull();
        expect(result!.action).toBe("retry");
      });
    }

    it("does not retry when attempts exhausted", () => {
      const ctx = makeContext({
        error: "Request timeout",
        previousAttempts: 2,
      });
      expect(transientRetryRule.evaluate(ctx)).toBeNull();
    });

    it("does not retry non-transient errors", () => {
      const ctx = makeContext({ error: "Tool xyz not found" });
      expect(transientRetryRule.evaluate(ctx)).toBeNull();
    });

    it("does not retry when error is null", () => {
      const ctx = makeContext({ error: null });
      expect(transientRetryRule.evaluate(ctx)).toBeNull();
    });
  });

  describe("adjustedRetryRule", () => {
    it("triggers adjusted retry on first non-transient failure", () => {
      const ctx = makeContext({
        error: "Tool xyz not found",
        previousAttempts: 0,
      });
      const result = adjustedRetryRule.evaluate(ctx);
      expect(result).not.toBeNull();
      expect(result!.action).toBe("retry_adjusted");
    });

    it("does not trigger when previousAttempts > 0", () => {
      const ctx = makeContext({
        error: "Tool xyz not found",
        previousAttempts: 1,
      });
      expect(adjustedRetryRule.evaluate(ctx)).toBeNull();
    });

    it("does not trigger for transient errors (those are caught earlier)", () => {
      const ctx = makeContext({
        error: "ECONNRESET: connection reset",
        previousAttempts: 0,
      });
      expect(adjustedRetryRule.evaluate(ctx)).toBeNull();
    });
  });

  describe("escalateRule", () => {
    it("escalates when retries exhausted (2+)", () => {
      const ctx = makeContext({ previousAttempts: 2 });
      const result = escalateRule.evaluate(ctx);
      expect(result).not.toBeNull();
      expect(result!.action).toBe("escalate");
    });

    it("does not escalate when retries remain", () => {
      const ctx = makeContext({ previousAttempts: 1 });
      expect(escalateRule.evaluate(ctx)).toBeNull();
    });
  });

  describe("evaluateRules (ordering)", () => {
    it("suppression takes priority over everything", () => {
      const ctx = makeContext({
        classificationFailures24h: 5,
        previousAttempts: 0,
        error: "timeout",
      });
      const result = evaluateRules(DEFAULT_RULES, ctx);
      expect(result).not.toBeNull();
      expect(result!.rule.name).toBe("suppression");
      expect(result!.decision.action).toBe("suppress");
    });

    it("transient retry takes priority over adjusted retry", () => {
      const ctx = makeContext({
        error: "ECONNRESET",
        previousAttempts: 0,
      });
      const result = evaluateRules(DEFAULT_RULES, ctx);
      expect(result).not.toBeNull();
      expect(result!.rule.name).toBe("transient_retry");
    });

    it("adjusted retry fires for first non-transient failure", () => {
      const ctx = makeContext({
        error: "Unknown tool: foo",
        previousAttempts: 0,
      });
      const result = evaluateRules(DEFAULT_RULES, ctx);
      expect(result).not.toBeNull();
      expect(result!.rule.name).toBe("adjusted_retry");
    });

    it("escalation fires when all retries exhausted with non-transient error", () => {
      const ctx = makeContext({
        error: "Unknown tool: foo",
        previousAttempts: 2,
      });
      const result = evaluateRules(DEFAULT_RULES, ctx);
      expect(result).not.toBeNull();
      expect(result!.rule.name).toBe("escalate");
    });
  });
});
