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

  it("CCP10: should default to DONE when no status line present (tracked, not surfaced)", () => {
    const result = parseRunnerStatus("Just a regular response without status.");
    expect(result.status).toBe("DONE");
    expect(result.cleanContent).toBe("Just a regular response without status.");
    expect(result.concerns).toBeUndefined();
  });

  it("CCP10: should default to DONE for empty string", () => {
    const result = parseRunnerStatus("");
    expect(result.status).toBe("DONE");
    expect(result.cleanContent).toBe("");
    expect(result.concerns).toBeUndefined();
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

  it("classifies raw API-error output as BLOCKED", () => {
    // The real failure mode from 2026-04-17: the SDK wrapper returned the
    // Anthropic API's raw error body as `text`, and the runner was marking
    // it as status='completed' because there was no STATUS line to parse.
    const content =
      'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"The request body is not valid JSON: no low surrogate in string: line 1 column 68843 (char 68842)"},"request_id":"req_011Ca9mVnqF73cDQkRcknfqQ"}';
    const result = parseRunnerStatus(content);
    expect(result.status).toBe("BLOCKED");
    expect(result.concerns).toBeDefined();
    expect(result.concerns![0]).toContain("API Error: 400");
    expect(result.cleanContent).toBe(content);
  });

  it("classifies API Error 500/429 as BLOCKED", () => {
    const five = parseRunnerStatus("API Error: 500 internal server error");
    expect(five.status).toBe("BLOCKED");
    const rate = parseRunnerStatus("API Error: 429 rate_limit_error");
    expect(rate.status).toBe("BLOCKED");
  });

  it("does not misclassify a narrative mention of 'API Error' mid-response", () => {
    // Must anchor at line start so content that DISCUSSES an API error
    // (e.g. Jarvis explaining a failure to the user) is not demoted.
    const content = `The issue was that the Anthropic API Error: 400 rejected our body. I fixed it by...\nSTATUS: DONE`;
    const result = parseRunnerStatus(content);
    expect(result.status).toBe("DONE");
  });

  it("classifies leading-whitespace API-error variants as BLOCKED", () => {
    expect(parseRunnerStatus("  API Error: 400 body").status).toBe("BLOCKED");
    expect(parseRunnerStatus("\tAPI Error: 429 rate").status).toBe("BLOCKED");
  });

  it("classifies raw 'Error: 5xx' upstream shapes as BLOCKED", () => {
    // Broadened regex covers future SDK paths that return a raw upstream
    // error without the "API Error:" prefix.
    expect(parseRunnerStatus("Error: 503 Service Unavailable").status).toBe(
      "BLOCKED",
    );
    expect(parseRunnerStatus("Error: 529 overloaded").status).toBe("BLOCKED");
  });

  it("does not misclassify 4-digit non-HTTP numbers", () => {
    // "API Error: 4000" should NOT match because \d{3}\b requires a word
    // boundary after exactly 3 digits — the 4th digit is a \w char, so
    // the boundary fails. Locks the regex contract against drift.
    const result = parseRunnerStatus("API Error: 4000 custom code blah");
    expect(result.status).toBe("DONE");
  });
});
