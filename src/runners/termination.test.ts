import { describe, it, expect } from "vitest";
import {
  TERMINATION_REASONS,
  terminationFromExit,
  terminationFromTaskStatus,
} from "./termination.js";

describe("terminationFromExit", () => {
  it("passes every known non-natural exit string through unchanged", () => {
    for (const r of TERMINATION_REASONS) {
      if (r === "completed" || r === "needs_context" || r === "blocked") continue;
      expect(terminationFromExit(r, "DONE", true)).toBe(r);
    }
  });

  it("resolves a natural stop through the structured status", () => {
    expect(terminationFromExit("natural", "DONE", true)).toBe("completed");
    expect(terminationFromExit("natural", "DONE_WITH_CONCERNS", true)).toBe("completed");
    expect(terminationFromExit("natural", "NEEDS_CONTEXT", false)).toBe("needs_context");
    expect(terminationFromExit("natural", "BLOCKED", false)).toBe("blocked");
    expect(terminationFromExit("natural", "FAILED", false)).toBe("error");
    expect(terminationFromExit(undefined, undefined, true)).toBe("completed");
    // claude-sdk spells its natural stop "stop"
    expect(terminationFromExit("stop", "DONE", true)).toBe("completed");
    expect(terminationFromExit("stop", "NEEDS_CONTEXT", false)).toBe("needs_context");
  });

  it("carries the openai adapter's capacity stops and the startup-reconcile class verbatim", () => {
    for (const r of ["compaction_exhausted", "think_exhaustion", "escalation_wrapup", "escalation_abort", "orphaned_restart"]) {
      expect(terminationFromExit(r, "FAILED", false)).toBe(r);
    }
  });

  it("the set is exactly this list (qa-audit C W-4: membership pinned literally, not self-referentially)", () => {
    expect([...TERMINATION_REASONS]).toEqual([
      "completed", "needs_context", "blocked", "max_rounds", "token_budget",
      "budget_exhausted", "compaction_exhausted", "think_exhaustion",
      "escalation_wrapup", "escalation_abort", "orphaned_restart", "timeout",
      "provider_failure", "wrapup_failed", "aborted", "required_tools_missing", "error",
    ]);
  });

  it("folds an unknown exit string to error so the set stays closed", () => {
    expect(terminationFromExit("something_new", "DONE", true)).toBe("error");
  });

  it("a budget stop stays a budget stop even when the task was promoted", () => {
    expect(terminationFromExit("timeout", "DONE_WITH_CONCERNS", true)).toBe("timeout");
  });
});

describe("terminationFromTaskStatus", () => {
  it("maps the dispatcher's task status", () => {
    expect(terminationFromTaskStatus("completed", true)).toBe("completed");
    expect(terminationFromTaskStatus("needs_context", false)).toBe("needs_context");
    expect(terminationFromTaskStatus("blocked", false)).toBe("blocked");
    expect(terminationFromTaskStatus("failed", false)).toBe("error");
  });
});
