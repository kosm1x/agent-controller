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
