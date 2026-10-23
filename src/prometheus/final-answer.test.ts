import { describe, it, expect, vi, afterEach } from "vitest";
import { collectFinalAnswer, extractDeliverable } from "./final-answer.js";
import type { ExecutionResult, GoalResult } from "./types.js";

function goal(partial: Partial<GoalResult>): GoalResult {
  return {
    goalId: "g",
    ok: true,
    durationMs: 0,
    toolCalls: 0,
    toolNames: [],
    toolFailures: 0,
    tokenUsage: { promptTokens: 0, completionTokens: 0 },
    ...partial,
  };
}

function execResults(goalResults: Record<string, GoalResult>): ExecutionResult {
  return {
    goalResults,
    summary: {},
    totalToolCalls: 0,
    totalToolNames: [],
    totalToolFailures: 0,
    tokenUsage: { promptTokens: 0, completionTokens: 0 },
    toolRepairs: [],
  };
}

describe("collectFinalAnswer", () => {
  it("joins per-goal answers in order — the real agent report, not the reflector summary", () => {
    const out = collectFinalAnswer(
      execResults({
        "g-1": goal({ goalId: "g-1", result: "data retrieved" }),
        "g-2": goal({ goalId: "g-2", result: "EVOLUTION REPORT — patterns…" }),
      }),
    );
    expect(out).toBe("data retrieved\n\nEVOLUTION REPORT — patterns…");
  });

  it("skips goals with no/empty text", () => {
    const out = collectFinalAnswer(
      execResults({
        "g-1": goal({ goalId: "g-1", result: "   " }),
        "g-2": goal({ goalId: "g-2", result: "the report" }),
        "g-3": goal({ goalId: "g-3" }), // no result field
      }),
    );
    expect(out).toBe("the report");
  });

  it("returns null when no goal produced text (avoids storing junk)", () => {
    expect(
      collectFinalAnswer(execResults({ "g-1": goal({ result: undefined }) })),
    ).toBeNull();
    expect(collectFinalAnswer(execResults({}))).toBeNull();
  });
});

describe("extractDeliverable", () => {
  /** Every output path: no marker may reach chat. */
  const run = (text: string) => {
    const out = extractDeliverable(text);
    expect(out.text.toLowerCase()).not.toContain("<deliverable");
    expect(out.text.toLowerCase()).not.toContain("</deliverable");
    return out;
  };

  it("extracts the delimited block, trimmed", () => {
    expect(
      run(
        "I have verified evidence from three fetches.\n<deliverable>\n  Respuesta final.  \n</deliverable>\nDone.",
      ),
    ).toEqual({ text: "Respuesta final.", delimited: true });
  });

  it("the LAST block wins", () => {
    expect(
      run("<deliverable>borrador</deliverable> retry… <deliverable>versión final</deliverable>"),
    ).toEqual({ text: "versión final", delimited: true });
  });

  it("an empty LAST block falls through to the earlier non-empty one", () => {
    expect(
      run("<deliverable>real</deliverable> retry… <deliverable>  \n </deliverable>"),
    ).toEqual({ text: "real", delimited: true });
  });

  it("no block → the full text unchanged", () => {
    const text = "  Resumen sin marcadores.\nSegunda línea.  ";
    expect(run(text)).toEqual({ text, delimited: false });
  });

  it("only an empty block → the full text, markers stripped", () => {
    expect(run("Narración previa.\n<deliverable>  \n </deliverable>")).toEqual({
      text: "Narración previa.\n  \n ",
      delimited: false,
    });
  });

  it("an unclosed block → the full text, marker stripped", () => {
    expect(run("Narración.\n<deliverable>Respuesta")).toEqual({
      text: "Narración.\nRespuesta",
      delimited: false,
    });
  });

  it("stray markers are stripped case-insensitively on the fallback path", () => {
    expect(run("Narración.\n<Deliverable>Respuesta <DELIVERABLE lang=\"es\">")).toEqual({
      text: "Narración.\nRespuesta ",
      delimited: false,
    });
  });

  it("attributes on the open tag are accepted", () => {
    expect(run('<deliverable lang="es">Hola</deliverable>')).toEqual({
      text: "Hola",
      delimited: true,
    });
  });

  it("markers match case-insensitively", () => {
    expect(run("narración <Deliverable>Hola</DELIVERABLE>")).toEqual({
      text: "Hola",
      delimited: true,
    });
  });

  it("nested blocks → the outer body up to the first close, inner markers stripped", () => {
    expect(
      run("x <deliverable>uno <deliverable>dos</deliverable> tres</deliverable>"),
    ).toEqual({ text: "uno dos", delimited: true });
  });
});

describe("collectFinalAnswer — <deliverable> boundary", () => {
  afterEach(() => vi.restoreAllMocks());

  it("joins only the deliverables of delimited goals + the full text of the rest, and logs counts only", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const out = collectFinalAnswer(
      execResults({
        "g-1": goal({
          goalId: "g-1",
          result:
            "All the evidence I need is already captured.\n<deliverable>Parte uno.</deliverable>",
        }),
        "g-2": goal({ goalId: "g-2", result: "Parte dos, sin marcadores." }),
        "g-3": goal({
          goalId: "g-3",
          result:
            "Qué pasó en el reintento: nada.\n<deliverable>\nParte tres.\n</deliverable>\ntrailing note",
        }),
      }),
    );
    expect(out).toBe("Parte uno.\n\nParte dos, sin marcadores.\n\nParte tres.");
    expect(out).not.toContain("<deliverable");
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith("[final-answer] goals=3 delimited=2");
  });

  // Queue 3p readout 2026-10-23: the swarm root joins children whose markers
  // their own run already stripped; its line must not read as delimited=0.
  it("source=swarm-root logs the children line, never a delimited count; extraction unchanged", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const results = execResults({
      "c-1": goal({ goalId: "c-1", result: "Reporte uno." }),
      "c-2": goal({ goalId: "c-2", result: "Reporte dos.</deliverable>" }),
      "c-3": goal({ goalId: "c-3", result: "   " }),
    });
    const out = collectFinalAnswer(results, { source: "swarm-root" });
    expect(out).toBe("Reporte uno.\n\nReporte dos.");
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      "[final-answer] source=swarm-root goals=2 (children, already extracted)",
    );
    for (const call of info.mock.calls) {
      expect(String(call[0])).not.toContain("delimited=");
    }
    // Same input without the option: the adoption line, byte for byte.
    info.mockClear();
    expect(collectFinalAnswer(results)).toBe(out);
    expect(info).toHaveBeenCalledWith("[final-answer] goals=2 delimited=0");
  });
});
