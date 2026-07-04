import { describe, it, expect } from "vitest";
import { classifyConcernReason } from "./concern-reason.js";

describe("classifyConcernReason", () => {
  it("detects max_turns from the truncation marker (task 7059 class)", () => {
    const out = JSON.stringify({
      text: "[error_max_turns — Reached maximum number of turns (35)] Partial response below",
    });
    expect(classifyConcernReason("completed_with_concerns", out, null)).toBe(
      "max_turns",
    );
  });

  it("detects tool_scope_block from the withheld-tool phrasing (5905/7060 class)", () => {
    const out = JSON.stringify({
      text: "No tengo jarvis_file_write en este scope. Uso file_write. Necesito shell_exec para ejecutar el seed.",
    });
    expect(classifyConcernReason("completed_with_concerns", out, null)).toBe(
      "tool_scope_block",
    );
  });

  it("falls back to partial for a concern with no recognized defect", () => {
    const out = JSON.stringify({ text: "Corrección importante al modelo…" });
    expect(classifyConcernReason("completed_with_concerns", out, null)).toBe(
      "partial",
    );
  });

  it("returns none for a clean completed task", () => {
    const out = JSON.stringify({ text: "## BD de VLCRM — SQLite, 4 tablas" });
    expect(classifyConcernReason("completed", out, null)).toBe("none");
  });

  it("returns none for a plain failure (carries its own error)", () => {
    expect(classifyConcernReason("failed", null, "Service shutdown")).toBe(
      "none",
    );
  });

  it("does not trip tool_scope_block on a benign tool mention", () => {
    const out = JSON.stringify({
      text: "Usé shell_exec y file_write para construir el script.",
    });
    expect(classifyConcernReason("completed", out, null)).toBe("none");
  });

  // qa 2026-07-04: natural-language phrasings must NOT tag a CLEAN success —
  // otherwise the reason metric Phase 0 exists to clean is itself polluted.
  it("does not tag a clean success that merely discusses 'maximum number of turns'", () => {
    for (const t of [
      "What is the maximum number of turns in chess?",
      "El juego permite un maximum number of turns de 10",
    ]) {
      expect(
        classifyConcernReason("completed", JSON.stringify({ text: t }), null),
      ).toBe("none");
    }
  });

  it("does not tag a clean success discussing scope / 'no tengo'", () => {
    for (const t of [
      "No tengo claro el scope de este sprint",
      "necesito vacaciones pero no tengo días disponibles",
    ]) {
      expect(
        classifyConcernReason("completed", JSON.stringify({ text: t }), null),
      ).toBe("none");
    }
  });

  it("still classifies the SAME phrasing when the task actually had concerns", () => {
    // The gated natural-language path activates only on a concern status.
    const t = JSON.stringify({ text: "Reached maximum number of turns" });
    expect(classifyConcernReason("completed_with_concerns", t, null)).toBe(
      "max_turns",
    );
  });
});
