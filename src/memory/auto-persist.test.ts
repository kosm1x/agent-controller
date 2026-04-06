import { describe, it, expect, vi, afterEach } from "vitest";
import { shouldAutoPersist, deriveTopicSlug } from "./auto-persist.js";
import type { AutoPersistInput } from "./auto-persist.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function input(overrides: Partial<AutoPersistInput> = {}): AutoPersistInput {
  return {
    userText: "test message",
    responseText: "short response",
    toolCalls: [],
    channel: "telegram-123",
    taskId: "task-1",
    ...overrides,
  };
}

describe("shouldAutoPersist", () => {
  it("returns false for short simple exchanges", () => {
    expect(shouldAutoPersist(input())).toBe(false);
  });

  it("returns true for response >2K + >3 tools", () => {
    expect(
      shouldAutoPersist(
        input({
          responseText: "x".repeat(2001),
          toolCalls: ["a", "b", "c", "d"],
        }),
      ),
    ).toBe(true);
  });

  it("returns false for response >2K but only 3 tools (not >3)", () => {
    expect(
      shouldAutoPersist(
        input({
          responseText: "x".repeat(2001),
          toolCalls: ["a", "b", "c"],
        }),
      ),
    ).toBe(false);
  });

  it("returns true for Playwright tool", () => {
    expect(
      shouldAutoPersist(
        input({
          toolCalls: ["web_search", "playwright__goto", "playwright__click"],
        }),
      ),
    ).toBe(true);
  });

  it("returns true for browser_ prefixed tool", () => {
    expect(
      shouldAutoPersist(
        input({
          toolCalls: ["browser_goto"],
        }),
      ),
    ).toBe(true);
  });

  it("returns true for question + response >1K", () => {
    expect(
      shouldAutoPersist(
        input({
          userText: "How does the scope system work?",
          responseText: "x".repeat(1001),
        }),
      ),
    ).toBe(true);
  });

  it("returns true for Spanish question + response >1K", () => {
    expect(
      shouldAutoPersist(
        input({
          userText: "Cómo funciona el sistema de scope?",
          responseText: "x".repeat(1001),
        }),
      ),
    ).toBe(true);
  });

  it("returns true for message ending with ? + response >1K", () => {
    expect(
      shouldAutoPersist(
        input({
          userText: "tell me about the budget system?",
          responseText: "x".repeat(1001),
        }),
      ),
    ).toBe(true);
  });

  it("returns false for question + short response", () => {
    expect(
      shouldAutoPersist(
        input({
          userText: "How does it work?",
          responseText: "It works fine.",
        }),
      ),
    ).toBe(false);
  });
});

describe("deriveTopicSlug (v6.2 S4)", () => {
  it("extracts first 3 significant words", () => {
    // "dame" is not a stop word, "un" is too short, "resumen" "del" filtered, "pipeline" kept
    expect(deriveTopicSlug("Dame un resumen del pipeline de ventas")).toBe(
      "dame-resumen-pipeline",
    );
  });

  it("filters stop words", () => {
    expect(deriveTopicSlug("Cómo es el sistema de scope?")).toBe(
      "sistema-scope",
    );
  });

  it("returns 'misc' for empty/stop-word-only input", () => {
    expect(deriveTopicSlug("")).toBe("misc");
    expect(deriveTopicSlug("el la los")).toBe("misc");
  });

  it("handles English text", () => {
    expect(deriveTopicSlug("Show me the dashboard for revenue")).toBe(
      "show-dashboard-revenue",
    );
  });

  it("strips special characters", () => {
    // "qué" is stop word, "hay" is 3 chars (filtered by >2), "el" is stop
    // → "misc" because no significant words remain
    expect(deriveTopicSlug("¿Qué hay en el KB?")).toBe("misc");
  });

  it("lowercases output", () => {
    expect(deriveTopicSlug("ANÁLISIS del PIPELINE")).toBe("análisis-pipeline");
  });
});
