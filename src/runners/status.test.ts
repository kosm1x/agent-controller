/**
 * Status parsing tests.
 */

import { describe, it, expect } from "vitest";
import { parseRunnerStatus } from "./status.js";

describe("parseRunnerStatus", () => {
  it("should parse STATUS: DONE", () => {
    const result = parseRunnerStatus(
      "Task completed successfully.\nSTATUS: DONE",
    );
    expect(result.status).toBe("DONE");
    expect(result.cleanContent).toBe("Task completed successfully.");
    expect(result.concerns).toBeUndefined();
  });

  it("should parse STATUS: DONE_WITH_CONCERNS with detail", () => {
    const result = parseRunnerStatus(
      "Implemented the feature.\nSTATUS: DONE_WITH_CONCERNS — might be incomplete for edge cases",
    );
    expect(result.status).toBe("DONE_WITH_CONCERNS");
    expect(result.cleanContent).toBe("Implemented the feature.");
    expect(result.concerns).toEqual(["might be incomplete for edge cases"]);
  });

  it("should parse STATUS: DONE_WITH_CONCERNS without detail", () => {
    const result = parseRunnerStatus("Result.\nSTATUS: DONE_WITH_CONCERNS");
    expect(result.status).toBe("DONE_WITH_CONCERNS");
    expect(result.concerns).toBeUndefined();
  });

  it("should parse STATUS: NEEDS_CONTEXT", () => {
    const result = parseRunnerStatus(
      "I need more info.\nSTATUS: NEEDS_CONTEXT — missing API documentation",
    );
    expect(result.status).toBe("NEEDS_CONTEXT");
    expect(result.cleanContent).toBe("I need more info.");
  });

  it("should parse STATUS: BLOCKED", () => {
    const result = parseRunnerStatus(
      "Cannot proceed.\nSTATUS: BLOCKED — dependency not installed",
    );
    expect(result.status).toBe("BLOCKED");
    expect(result.cleanContent).toBe("Cannot proceed.");
  });

  it("CCP10: should default to DONE_WITH_CONCERNS when no status line present", () => {
    const result = parseRunnerStatus("Just a regular response without status.");
    expect(result.status).toBe("DONE_WITH_CONCERNS");
    expect(result.cleanContent).toBe("Just a regular response without status.");
    expect(result.concerns).toEqual(["LLM omitted required status line"]);
  });

  it("CCP10: should default to DONE_WITH_CONCERNS for empty string", () => {
    const result = parseRunnerStatus("");
    expect(result.status).toBe("DONE_WITH_CONCERNS");
    expect(result.cleanContent).toBe("");
    expect(result.concerns).toEqual(["LLM omitted required status line"]);
  });

  it("should handle multiline content with status at end", () => {
    const content = "Line 1\nLine 2\nLine 3\nSTATUS: DONE";
    const result = parseRunnerStatus(content);
    expect(result.status).toBe("DONE");
    expect(result.cleanContent).toBe("Line 1\nLine 2\nLine 3");
  });

  it("should handle em-dash separator", () => {
    const result = parseRunnerStatus("Result.\nSTATUS: BLOCKED — no access");
    expect(result.status).toBe("BLOCKED");
    expect(result.cleanContent).toBe("Result.");
  });

  it("should handle hyphen separator", () => {
    const result = parseRunnerStatus("Result.\nSTATUS: BLOCKED - no access");
    expect(result.status).toBe("BLOCKED");
    expect(result.cleanContent).toBe("Result.");
  });
});
