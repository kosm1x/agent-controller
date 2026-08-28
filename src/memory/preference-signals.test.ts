/**
 * Preference signals — regex tagger over operator turns (memory plan v2.0,
 * Track 2). Pure module: every kind fires on the operator's real Spanish
 * phrasing (plurals + clitics included), plain messages never fire, long
 * turns are briefs and never fire, explicit statements win over the
 * format/length words they contain, snippets are capped.
 */

import { describe, it, expect } from "vitest";
import {
  detectPreferenceSignal,
  signalSnippet,
  SIGNAL_SNIPPET_MAX,
  SIGNAL_MAX_TURN_CHARS,
  PREFERENCE_SIGNAL_KINDS,
} from "./preference-signals.js";

describe("detectPreferenceSignal", () => {
  it.each([
    ["Está muy largo, resúmelo", "length"],
    ["están muy largos, hazlos más cortos", "length"],
    ["más corto por favor", "length"],
    ["Resúmemelo", "length"],
    ["Resume.", "length"],
    ["sé breve", "length"],
    ["That's too long, make it shorter", "length"],
    ["tl;dr?", "length"],
    ["dame la tabla", "format"],
    ["dame una lista", "format"],
    ["haz una lista con eso", "format"],
    ["Ponlo en una tabla comparativa", "format"],
    ["en formato tabla", "format"],
    ["sin bullets, en prosa", "format"],
    ["Give it to me as a table", "format"],
    ["profundiza en el punto 2", "depth"],
    ["profundízalo", "depth"],
    ["necesito más detalle sobre Kustodia", "depth"],
    ["más detalles", "depth"],
    ["expande el punto 3", "depth"],
    ["go deeper on the pricing", "depth"],
    ["prefiero tablas comparativas para competencia", "explicit"],
    ["de ahora en adelante siempre dame el hallazgo clave primero", "explicit"],
    ["From now on always give me the bear case", "explicit"],
  ] as const)("%s → %s", (text, kind) => {
    expect(detectPreferenceSignal(text)).toBe(kind);
  });

  it("explicit statements win over the format words they contain (pattern order)", () => {
    // Matches BOTH explicit ("prefiero") and format ("en una tabla") —
    // reversing the pattern order would return "format".
    expect(detectPreferenceSignal("prefiero que me lo des en una tabla")).toBe(
      "explicit",
    );
    expect(detectPreferenceSignal("siempre dame la tabla, más corto")).toBe(
      "explicit",
    );
  });

  it.each([
    "¿Cuál es el estado del proyecto Pulso?",
    "Revisa el PR de Jarvis y dime si está bien",
    "Hola Jarvis",
    "The deploy finished, check the logs",
    // 'resumen' (noun) is not a length correction
    "Mándame el resumen del día",
    // Corpus replay false positive: Fede GIVING context is not a depth ask
    "Voy a darte más contexto al momento, para que confirmes los ajustes",
    "Let me give you more context on the client",
    "resume the deploy when the tests pass",
    "un análisis detallado de la cuenta",
  ])("plain message never fires: %s", (text) => {
    expect(detectPreferenceSignal(text)).toBeNull();
  });

  it("a long turn is a brief, never a correction — even when it contains the words", () => {
    // A real-shaped brief (the 08-27 PR instruction, abridged): 'prefiero'
    // sits at char ~200 of a multi-paragraph task, not in a correction.
    const brief =
      "Revisé el PR #34 (WORD_CAP 700→1400). No lo mergeo. Ciérralo y rehazlo así: " +
      "DIAGNÓSTICO CORRECTO: la reflexión de las 12:00 difirió por push-cap+word-cap, " +
      "no solo por palabras. CAMBIO: PUSH_CAP 4→5 y WORD_CAP 700→1400 en delivery-policy.ts. " +
      "[alternativa si prefiero no subir pushes: en vez de PUSH_CAP, deja 4 y sube solo palabras]. " +
      "Tests con números absolutos que fallen en el valor viejo. Rama desde origin/main, no apilada.";
    expect(brief.length).toBeGreaterThan(SIGNAL_MAX_TURN_CHARS);
    expect(detectPreferenceSignal(brief)).toBeNull();
    // The short opener the R1 audit flagged still fires by vocabulary alone —
    // the follow-up window in writeEpisodic is the second discriminator.
    expect(
      detectPreferenceSignal(
        "Haz un deep search y busca todo lo que se sabe acerca de GTA VI. Resumelo.",
      ),
    ).toBe("length");
    // The same correction at the cap still fires
    const atCap = "Resúmelo. " + "x".repeat(SIGNAL_MAX_TURN_CHARS - 10);
    expect(atCap.length).toBe(SIGNAL_MAX_TURN_CHARS);
    expect(detectPreferenceSignal(atCap)).toBe("length");
  });

  it("exports the same kind list the jme_signals CHECK constraint uses", () => {
    expect([...PREFERENCE_SIGNAL_KINDS]).toEqual([
      "length",
      "format",
      "depth",
      "explicit",
    ]);
  });
});

describe("signalSnippet", () => {
  it("trims and caps at SIGNAL_SNIPPET_MAX", () => {
    const long = `  ${"x".repeat(SIGNAL_SNIPPET_MAX + 50)}  `;
    const snippet = signalSnippet(long);
    expect(snippet).toHaveLength(SIGNAL_SNIPPET_MAX);
    expect(snippet.startsWith("x")).toBe(true);
  });

  it("returns short turns unchanged", () => {
    expect(signalSnippet("dame la tabla")).toBe("dame la tabla");
  });
});
