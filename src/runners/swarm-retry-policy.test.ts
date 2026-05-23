/**
 * Tests for swarm-retry-policy classifier (queue #231).
 *
 * Pure-function tests. No DB, no inference, no swarm-runner integration.
 * The classifier's contract is what the swarm-runner code at
 * `attemptSubtaskRetry` decides on. These tests pin the failure-class
 * matrix (Q5 taxonomy from the design note) + the side-effect-taint veto.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the tool registry. The test sets per-name annotations via the map
// below. Tools not in the map → registry returns undefined → classifier
// treats them conservatively (vetoes retry, per the "unknown tool"
// branch in findSideEffectTaint).
type ToolAnn = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
};
const toolMap = new Map<string, ToolAnn>();

vi.mock("../tools/registry.js", () => ({
  toolRegistry: {
    get: (name: string) => {
      const ann = toolMap.get(name);
      if (!ann) return undefined;
      // Tool shape matches src/tools/types.ts:8 — name + the 4 optional hints.
      return { name, ...ann };
    },
  },
}));

import {
  classifyRetry,
  findSideEffectTaint,
  buildRetryDescription,
  HALLUCINATION_RECOVERY_ADDENDUM,
  MAX_RETRIES_PER_GOAL,
} from "./swarm-retry-policy.js";

beforeEach(() => {
  toolMap.clear();
});

// ---------------------------------------------------------------------------
// classifyError — failure-class matrix (Q5 taxonomy)
// ---------------------------------------------------------------------------

describe("classifyRetry — failure-class matrix", () => {
  describe("RETRYABLE classes", () => {
    it("classifies HTTP 429 as provider_transient (retry plain)", () => {
      const d = classifyRetry({
        error: "Provider returned 429 Too Many Requests",
        toolCalls: [],
        retryCount: 0,
      });
      expect(d.decision).toBe("retried");
      expect(d.reason).toBe("provider_transient");
      expect(d.recoveryMode).toBe("plain");
    });

    it("classifies 5xx as provider_transient", () => {
      const d = classifyRetry({
        error: "Upstream 503 Service Unavailable",
        toolCalls: [],
        retryCount: 0,
      });
      expect(d.decision).toBe("retried");
      expect(d.reason).toBe("provider_transient");
    });

    it("classifies generic timeout as provider_transient (NOT the [timeout after Ns] SDK marker)", () => {
      const d = classifyRetry({
        error: "Network timeout while contacting provider",
        toolCalls: [],
        retryCount: 0,
      });
      expect(d.decision).toBe("retried");
      expect(d.reason).toBe("provider_transient");
    });

    it("classifies ECONNRESET as provider_transient", () => {
      const d = classifyRetry({
        error: "fetch failed: ECONNRESET",
        toolCalls: [],
        retryCount: 0,
      });
      expect(d.reason).toBe("provider_transient");
      expect(d.decision).toBe("retried");
    });

    it("classifies circuit-open as provider_transient (breaker is transient by design)", () => {
      const d = classifyRetry({
        error: "claude-sdk circuit OPEN",
        toolCalls: [],
        retryCount: 0,
      });
      expect(d.reason).toBe("provider_transient");
      expect(d.decision).toBe("retried");
    });

    it("classifies hallucination guard fire as hallucination (retry with sterner prompt)", () => {
      const d = classifyRetry({
        error:
          "[hallucination guard] LLM narrated tool calls without invoking them",
        toolCalls: [],
        retryCount: 0,
      });
      expect(d.decision).toBe("retried");
      expect(d.reason).toBe("hallucination");
      expect(d.recoveryMode).toBe("hallucination");
    });
  });

  describe("TERMINAL classes", () => {
    it("tool ENOENT → tool_error → skipped_terminal", () => {
      const d = classifyRetry({
        error: "ENOENT: no such file or directory",
        toolCalls: [],
        retryCount: 0,
      });
      expect(d.decision).toBe("skipped_terminal");
      expect(d.reason).toBe("tool_error");
      expect(d.recoveryMode).toBe("none");
    });

    it("validation error → tool_error", () => {
      const d = classifyRetry({
        error: "Schema validation failed for argument",
        toolCalls: [],
        retryCount: 0,
      });
      expect(d.reason).toBe("tool_error");
      expect(d.decision).toBe("skipped_terminal");
    });

    it("required tools terminal (post-_isRequiredToolRetry) → tool_error", () => {
      // This is the dispatcher's terminal failure after BOTH attempts at
      // the required-tool retry. Swarm must NOT also retry.
      const d = classifyRetry({
        error: "Required tools not called after retry: gmail_send",
        toolCalls: [],
        retryCount: 1,
      });
      // Budget veto wins (retry_count >= 1) — order of vetoes is documented.
      expect(d.decision).toBe("skipped_budget");
    });

    it("max_rounds exhaustion → skipped_terminal", () => {
      const d = classifyRetry({
        error: "max_rounds exceeded",
        toolCalls: [],
        retryCount: 0,
      });
      expect(d.reason).toBe("max_rounds");
      expect(d.decision).toBe("skipped_terminal");
    });

    it("max_turns exhaustion → max_rounds (alias)", () => {
      const d = classifyRetry({
        error: "Reached maximum number of max_turns (20)",
        toolCalls: [],
        retryCount: 0,
      });
      expect(d.reason).toBe("max_rounds");
      expect(d.decision).toBe("skipped_terminal");
    });

    it("SDK [timeout after Ns] marker → max_rounds (NOT provider_transient)", () => {
      // The MAX_ROUNDS matcher must fire BEFORE the generic timeout matcher.
      // This is the specific SDK 15-min hard-timeout signal — same input
      // (same task) won't suddenly fit in 15min on replay.
      const d = classifyRetry({
        error: "[timeout after 900s — partial response below]",
        toolCalls: [],
        retryCount: 0,
      });
      expect(d.reason).toBe("max_rounds");
      expect(d.decision).toBe("skipped_terminal");
    });

    it("needs_context → skipped_terminal (waiting for user)", () => {
      const d = classifyRetry({
        error: "Sub-task needs additional user context",
        toolCalls: [],
        retryCount: 0,
      });
      expect(d.reason).toBe("needs_context");
      expect(d.decision).toBe("skipped_terminal");
    });

    it("cancelled (user-initiated) → skipped_terminal", () => {
      const d = classifyRetry({
        error: "Task cancelled by user",
        toolCalls: [],
        retryCount: 0,
      });
      expect(d.reason).toBe("cancelled");
      expect(d.decision).toBe("skipped_terminal");
    });

    it("Service shutdown (SIGTERM during mc restart) → cancelled (terminal)", () => {
      // [[check-inflight-tasks-before-restart]] documents this exact
      // failure mode. Retry shouldn't fire — the task was killed by mc
      // itself, replay loses the work that was in-flight.
      const d = classifyRetry({
        error: "Service shutdown",
        toolCalls: [],
        retryCount: 0,
      });
      expect(d.reason).toBe("cancelled");
      expect(d.decision).toBe("skipped_terminal");
    });

    it("empty error string → unknown_failure → skipped_terminal", () => {
      const d = classifyRetry({
        error: "",
        toolCalls: [],
        retryCount: 0,
      });
      expect(d.reason).toBe("unknown_failure");
      expect(d.decision).toBe("skipped_terminal");
    });

    it("null error → unknown_failure → skipped_terminal", () => {
      const d = classifyRetry({
        error: null,
        toolCalls: [],
        retryCount: 0,
      });
      expect(d.reason).toBe("unknown_failure");
      expect(d.decision).toBe("skipped_terminal");
    });
  });
});

// ---------------------------------------------------------------------------
// Side-effect taint veto
// ---------------------------------------------------------------------------

describe("classifyRetry — side-effect taint veto", () => {
  it("retries when ONLY read-only tools were called (jarvis_file_read)", () => {
    toolMap.set("jarvis_file_read", { readOnlyHint: true });
    toolMap.set("code_search", { readOnlyHint: true });
    const d = classifyRetry({
      error: "Provider 429",
      toolCalls: ["jarvis_file_read", "code_search"],
      retryCount: 0,
    });
    expect(d.decision).toBe("retried");
  });

  it("retries when ONLY idempotent tools were called", () => {
    // jarvis_file_write is idempotent (write-replace; same content twice → same end state)
    toolMap.set("jarvis_file_write", {
      idempotentHint: true,
      destructiveHint: true,
    });
    const d = classifyRetry({
      error: "Provider 429",
      toolCalls: ["jarvis_file_write"],
      retryCount: 0,
    });
    expect(d.decision).toBe("retried");
  });

  it("vetoes retry when a destructive non-idempotent tool was called (gmail_send)", () => {
    toolMap.set("gmail_send", {
      destructiveHint: true,
      idempotentHint: false,
      readOnlyHint: false,
    });
    toolMap.set("jarvis_file_read", { readOnlyHint: true });
    const d = classifyRetry({
      error: "Provider 429", // would normally retry
      toolCalls: ["jarvis_file_read", "gmail_send"],
      retryCount: 0,
    });
    expect(d.decision).toBe("skipped_side_effect");
    expect(d.reason).toBe("provider_transient"); // reason preserved even though decision vetoed
    expect(d.rationale).toContain("gmail_send");
  });

  it("vetoes retry when an UNKNOWN tool was called (conservative: assume destructive)", () => {
    // MCP bridge tools and other unannotated callers fall back to
    // conservative defaults per CLAUDE.md. Unknown name → veto.
    const d = classifyRetry({
      error: "Provider 429",
      toolCalls: ["mcp__playwright__browser_click"],
      retryCount: 0,
    });
    expect(d.decision).toBe("skipped_side_effect");
    expect(d.rationale).toContain("mcp__playwright__browser_click");
  });

  it("findSideEffectTaint returns null when no tools called", () => {
    expect(findSideEffectTaint([])).toBeNull();
  });

  it("findSideEffectTaint returns first tainting tool name (deterministic)", () => {
    toolMap.set("foo", { readOnlyHint: true });
    toolMap.set("bar", { destructiveHint: true, idempotentHint: false });
    toolMap.set("baz", { destructiveHint: true, idempotentHint: false });
    expect(findSideEffectTaint(["foo", "bar", "baz"])).toBe("bar");
  });

  // ---------------------------------------------------------------------
  // qa-audit C1 fold (2026-05-23): the original veto required
  // `destructiveHint:true`, which let three production tools through as
  // retry-safe even though they're non-idempotent + side-effecting:
  //   - jarvis_file_update (appends accumulate)
  //   - jarvis_file_move (rename — second call ENOENT)
  //   - submit-report (duplicate row on replay)
  // The corrected veto is: NOT readOnly AND NOT idempotent → veto,
  // regardless of destructiveHint. Each tool's actual production
  // annotations pin the regression here so a future loosening surfaces.
  // ---------------------------------------------------------------------

  it("C1 regression: jarvis_file_update (destructive:false, idempotent:false) MUST veto", () => {
    toolMap.set("jarvis_file_update", {
      readOnlyHint: false,
      destructiveHint: false, // matches production at jarvis-files.ts:360
      idempotentHint: false, // appends accumulate
    });
    const d = classifyRetry({
      error: "Provider 429",
      toolCalls: ["jarvis_file_update"],
      retryCount: 0,
    });
    expect(d.decision).toBe("skipped_side_effect");
    expect(d.rationale).toContain("jarvis_file_update");
  });

  it("C1 regression: jarvis_file_move (rename — destructive:false, idempotent:false) MUST veto", () => {
    toolMap.set("jarvis_file_move", {
      readOnlyHint: false,
      destructiveHint: false, // reversible — but second call ENOENTs
      idempotentHint: false,
    });
    const d = classifyRetry({
      error: "Network ECONNRESET",
      toolCalls: ["jarvis_file_move"],
      retryCount: 0,
    });
    expect(d.decision).toBe("skipped_side_effect");
    expect(d.rationale).toContain("jarvis_file_move");
  });

  it("C1 regression: submit_report (writes new row each call) MUST veto", () => {
    toolMap.set("submit_report", {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
    const d = classifyRetry({
      error: "Provider 503",
      toolCalls: ["submit_report"],
      retryCount: 0,
    });
    expect(d.decision).toBe("skipped_side_effect");
  });
});

// ---------------------------------------------------------------------------
// Budget cap (retry_count veto)
// ---------------------------------------------------------------------------

describe("classifyRetry — budget veto", () => {
  it("vetoes when retry_count >= MAX_RETRIES_PER_GOAL even on retryable class", () => {
    const d = classifyRetry({
      error: "Provider 429",
      toolCalls: [],
      retryCount: MAX_RETRIES_PER_GOAL, // == 1
    });
    expect(d.decision).toBe("skipped_budget");
    expect(d.reason).toBe("provider_transient"); // reason preserved
  });

  it("allows retry at retry_count = 0 (first attempt)", () => {
    const d = classifyRetry({
      error: "Provider 429",
      toolCalls: [],
      retryCount: 0,
    });
    expect(d.decision).toBe("retried");
  });

  it("budget veto fires BEFORE class veto (cheaper path, no error matching)", () => {
    const d = classifyRetry({
      error: "Provider 429",
      toolCalls: [],
      retryCount: 5, // way over cap
    });
    expect(d.decision).toBe("skipped_budget");
  });

  it("budget veto fires BEFORE side-effect veto", () => {
    toolMap.set("gmail_send", { destructiveHint: true });
    const d = classifyRetry({
      error: "Provider 429",
      toolCalls: ["gmail_send"],
      retryCount: 1,
    });
    // If budget hadn't fired we'd see skipped_side_effect. Budget order matters
    // because budget is dirt-cheap and side-effect requires registry lookup.
    expect(d.decision).toBe("skipped_budget");
  });

  it("MAX_RETRIES_PER_GOAL is 1 (locked from design note Q1)", () => {
    expect(MAX_RETRIES_PER_GOAL).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// buildRetryDescription — hallucination addendum
// ---------------------------------------------------------------------------

describe("buildRetryDescription", () => {
  it("returns original description unchanged for plain recovery", () => {
    const original = "Read the file and summarize it";
    expect(buildRetryDescription(original, "plain")).toBe(original);
  });

  it("prepends the Option A addendum for hallucination recovery", () => {
    const original = "Read the file and summarize it";
    const out = buildRetryDescription(original, "hallucination");
    expect(out.startsWith(HALLUCINATION_RECOVERY_ADDENDUM)).toBe(true);
    expect(out).toContain(original);
    // Addendum must precede original, separated by blank line so the LLM
    // sees the warning before the task body.
    expect(out.indexOf(HALLUCINATION_RECOVERY_ADDENDUM)).toBeLessThan(
      out.indexOf(original),
    );
  });

  it("addendum mentions the specific failure mode (queue #231 Option A wording)", () => {
    // Option A was chosen over reusing fast-runner's [hallucination guard]
    // rejection text. Pin the chosen wording so a future "let's simplify"
    // pass doesn't silently re-substitute (B) or invent a new variant.
    expect(HALLUCINATION_RECOVERY_ADDENDUM).toContain("narrated tool calls");
    expect(HALLUCINATION_RECOVERY_ADDENDUM).toContain("MUST call the tools");
  });

  it("plain recovery for unknown/none mode passes through (defensive)", () => {
    const original = "Read the file";
    expect(buildRetryDescription(original, "none")).toBe(original);
  });
});
