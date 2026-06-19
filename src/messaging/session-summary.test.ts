import { describe, it, expect } from "vitest";
import {
  parseDayLogEntries,
  hasRecentSessionEnd,
  buildSessionSummary,
  type SessionEntry,
} from "./session-summary.js";

// ---------------------------------------------------------------------------
// parseDayLogEntries
// ---------------------------------------------------------------------------

describe("parseDayLogEntries", () => {
  it("parses valid USER and JARVIS lines", () => {
    const content = [
      "# Day Log: 2026-06-19",
      "",
      "- [10:00:00] **USER**: Hola, qué haces",
      "- [10:00:05] **JARVIS**: Aquí estoy, listo",
      "- [10:05:00] **USER**: Describe el repo agent-controller",
      "- [10:05:30] **JARVIS**: El repo tiene 230 commits...",
    ].join("\n");

    const entries = parseDayLogEntries(content);
    expect(entries).toHaveLength(4);
    expect(entries[0]).toEqual({ time: "10:00:00", role: "USER", text: "Hola, qué haces" });
    expect(entries[1]).toEqual({ time: "10:00:05", role: "JARVIS", text: "Aquí estoy, listo" });
  });

  it("ignores header lines and blank lines", () => {
    const content = "# Day Log: 2026-06-19\n\n- [10:00:00] **USER**: test\n";
    expect(parseDayLogEntries(content)).toHaveLength(1);
  });

  it("returns empty array for empty content", () => {
    expect(parseDayLogEntries("")).toHaveLength(0);
    expect(parseDayLogEntries("# Day Log: 2026-06-19\n")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// hasRecentSessionEnd
// ---------------------------------------------------------------------------

describe("hasRecentSessionEnd", () => {
  it("returns true when no USER entries exist", () => {
    const entries: SessionEntry[] = [
      { role: "JARVIS", time: "10:00:00", text: "Morning brief delivered" },
    ];
    expect(hasRecentSessionEnd(entries)).toBe(true);
  });

  it("returns false when USER exists but no SESSION_END after it", () => {
    const entries: SessionEntry[] = [
      { role: "USER", time: "10:00:00", text: "Describe el repo" },
      { role: "JARVIS", time: "10:00:30", text: "El repo tiene 230 commits" },
    ];
    expect(hasRecentSessionEnd(entries)).toBe(false);
  });

  it("returns true when SESSION_END exists after the last USER", () => {
    const entries: SessionEntry[] = [
      { role: "USER", time: "10:00:00", text: "Describe el repo" },
      { role: "JARVIS", time: "10:00:30", text: "El repo tiene 230 commits" },
      { role: "JARVIS", time: "10:20:00", text: "[SESSION_END] 1 interacción · temas: describe repo · completado" },
    ];
    expect(hasRecentSessionEnd(entries)).toBe(true);
  });

  it("returns false when SESSION_END exists but new USER messages arrived after it", () => {
    const entries: SessionEntry[] = [
      { role: "USER", time: "10:00:00", text: "Primera pregunta" },
      { role: "JARVIS", time: "10:00:30", text: "Respuesta 1" },
      { role: "JARVIS", time: "10:20:00", text: "[SESSION_END] 1 interacción · completado" },
      { role: "USER", time: "11:00:00", text: "Nueva pregunta" },
      { role: "JARVIS", time: "11:00:30", text: "Respuesta 2" },
    ];
    expect(hasRecentSessionEnd(entries)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildSessionSummary
// ---------------------------------------------------------------------------

describe("buildSessionSummary", () => {
  it("returns null when no USER entries exist", () => {
    const entries: SessionEntry[] = [
      { role: "JARVIS", time: "06:00:00", text: "Morning brief delivered" },
    ];
    expect(buildSessionSummary(entries, "2026-06-19")).toBeNull();
  });

  it("returns null when SESSION_END already written", () => {
    const entries: SessionEntry[] = [
      { role: "USER", time: "10:00:00", text: "Describe el repo" },
      { role: "JARVIS", time: "10:00:30", text: "El repo tiene 230 commits" },
      { role: "JARVIS", time: "10:20:00", text: "[SESSION_END] 1 interacción · completado" },
    ];
    expect(buildSessionSummary(entries, "2026-06-19")).toBeNull();
  });

  it("builds a summary with interaction count", () => {
    const entries: SessionEntry[] = [
      { role: "USER", time: "10:00:00", text: "Describe el repo agent controller" },
      { role: "JARVIS", time: "10:00:30", text: "El repo tiene 230 commits..." },
      { role: "USER", time: "10:05:00", text: "Actualiza la knowledge base" },
      { role: "JARVIS", time: "10:05:30", text: "KB actualizado." },
    ];
    const summary = buildSessionSummary(entries, "2026-06-19");
    expect(summary).not.toBeNull();
    expect(summary).toContain("[SESSION_END]");
    expect(summary).toContain("2 interacciones");
    expect(summary).toContain("completado");
  });

  it("uses singular form for exactly 1 interaction", () => {
    const entries: SessionEntry[] = [
      { role: "USER", time: "10:00:00", text: "Qué hora es" },
      { role: "JARVIS", time: "10:00:05", text: "Son las 10:00" },
    ];
    const summary = buildSessionSummary(entries, "2026-06-19");
    expect(summary).toContain("1 interacción ·");
  });

  it("only counts interactions in current block (after last SESSION_END)", () => {
    const entries: SessionEntry[] = [
      { role: "USER", time: "09:00:00", text: "Primera sesión" },
      { role: "JARVIS", time: "09:00:30", text: "Respuesta" },
      { role: "JARVIS", time: "09:20:00", text: "[SESSION_END] 1 interacción · completado" },
      { role: "USER", time: "10:00:00", text: "Segunda sesión nueva pregunta" },
      { role: "JARVIS", time: "10:00:30", text: "Respuesta nueva" },
    ];
    const summary = buildSessionSummary(entries, "2026-06-19");
    expect(summary).toContain("1 interacción ·"); // only the new block
  });
});
