import { describe, it, expect } from "vitest";
import { extractDeliverableText, hasDeliverableField } from "./deliverable.js";

/**
 * Contract tests over the REAL output shapes every runner produces — the
 * delivery-bug class (meta-summary delivered instead of the agent's answer)
 * is unrepresentable only if these pins cover each producer.
 */
describe("extractDeliverableText — per-runner contract", () => {
  it("nanoclaw/heavy shape: finalAnswer (the agent's report) wins over content (reflector verdict)", () => {
    // Captured from task 7413 (2026-07-12) post-fix
    const out = {
      content:
        "Correctly scoped the task to the in-sandbox mission-control repo, located the .md mirror mechanism, and delivered a concrete response citing file paths.",
      score: 0.9,
      learnings: ["For KB mirror questions, jump directly to src/kb/"],
      finalAnswer:
        "El mirror funciona así: jarvis_files es la fuente de verdad y /root/claude/jarvis-kb/ es el espejo FS.",
    };
    expect(extractDeliverableText(out)).toContain("fuente de verdad");
    expect(extractDeliverableText(out)).not.toContain("Correctly scoped");
  });

  it("falls back to content when finalAnswer collection produced null/empty", () => {
    expect(
      extractDeliverableText({ content: "resumen", finalAnswer: null }),
    ).toBe("resumen");
    expect(
      extractDeliverableText({ content: "resumen", finalAnswer: "" }),
    ).toBe("resumen");
  });

  it("fast shape: text delivers", () => {
    expect(extractDeliverableText({ text: "OK", toolCalls: [] })).toBe("OK");
  });

  it("swarm shape: finalAnswer wins; extra fields (goalSummary) ignored", () => {
    expect(
      extractDeliverableText({
        content: "Completed 5/7 goals",
        score: 0.7,
        learnings: [],
        goalSummary: { completed: 5, total: 7 },
        finalAnswer: "Reporte real del enjambre.",
      }),
    ).toBe("Reporte real del enjambre.");
  });

  it("a2a shape: plain string is the deliverable", () => {
    expect(extractDeliverableText("respuesta directa")).toBe(
      "respuesta directa",
    );
  });

  it("JSON-encoded fast result string is parsed and extracted", () => {
    expect(extractDeliverableText('{"text":"hola","toolCalls":[]}')).toBe(
      "hola",
    );
  });

  it("JSON string with no usable field returns the raw string (honest fallback)", () => {
    expect(extractDeliverableText('{"score":1}')).toBe('{"score":1}');
  });

  it("returns null for empty/unusable results (caller owns the fallback)", () => {
    expect(extractDeliverableText(null)).toBeNull();
    expect(extractDeliverableText(undefined)).toBeNull();
    expect(extractDeliverableText({})).toBeNull();
    expect(extractDeliverableText({ score: 1, learnings: [] })).toBeNull();
    expect(extractDeliverableText("   ")).toBeNull();
  });

  it("preference order is finalAnswer > text > output > result > content", () => {
    expect(
      extractDeliverableText({
        content: "meta",
        result: "r",
        output: "o",
        text: "t",
        finalAnswer: "fa",
      }),
    ).toBe("fa");
    expect(
      extractDeliverableText({ content: "meta", result: "r", text: "t" }),
    ).toBe("t");
    expect(extractDeliverableText({ content: "meta", result: "r" })).toBe("r");
  });
});

describe("hasDeliverableField", () => {
  it("guards the router failure path: text-less objects never reach the operator as JSON", () => {
    expect(hasDeliverableField({ score: 1 })).toBe(false);
    expect(hasDeliverableField({ finalAnswer: "q" })).toBe(true);
    expect(hasDeliverableField("string")).toBe(true);
    expect(hasDeliverableField(null)).toBe(false);
  });
});
