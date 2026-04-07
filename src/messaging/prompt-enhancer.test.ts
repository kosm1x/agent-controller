/**
 * Tests for prompt-enhancer — shouldEnhance, CIRICD parsing, toggle commands.
 */

import { describe, it, expect } from "vitest";
import {
  shouldEnhance,
  checkToggle,
  parseCiricdResponse,
} from "./prompt-enhancer.js";

// ---------------------------------------------------------------------------
// shouldEnhance — pass-through detection
// ---------------------------------------------------------------------------

describe("shouldEnhance", () => {
  it("rejects short messages (< 40 chars)", () => {
    expect(shouldEnhance("Hola")).toBe(false);
    expect(shouldEnhance("Qué tal?")).toBe(false);
  });

  it("rejects greetings", () => {
    expect(shouldEnhance("hola buenos días cómo estás")).toBe(false);
    expect(shouldEnhance("buenas tardes, todo bien?")).toBe(false);
  });

  it("rejects confirmations", () => {
    expect(shouldEnhance("sí, dale, procede con todo eso ahora")).toBe(false);
  });

  it("rejects read-only verbs", () => {
    expect(
      shouldEnhance("lista todas las tareas pendientes del proyecto"),
    ).toBe(false);
    expect(shouldEnhance("muestra el estado del servidor principal")).toBe(
      false,
    );
  });

  it("rejects continuation commands", () => {
    expect(shouldEnhance("continúa con lo que estabas haciendo antes")).toBe(
      false,
    );
  });

  it("accepts long actionable messages", () => {
    expect(
      shouldEnhance(
        "Crea un reporte semanal de ventas y envíalo a javier@eurekamd.net con los datos del CRM",
      ),
    ).toBe(true);
  });

  it("rejects skip signals", () => {
    expect(shouldEnhance("hazlo ya sin preguntas por favor amigo")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkToggle
// ---------------------------------------------------------------------------

describe("checkToggle", () => {
  it("returns false for 'enhancer off'", () => {
    expect(checkToggle("enhancer off")).toBe(false);
  });

  it("returns true for 'enhancer on'", () => {
    expect(checkToggle("enhancer on")).toBe(true);
  });

  it("returns null for non-toggle messages", () => {
    expect(checkToggle("hola")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CIRICD response parsing (v6.4 PE1)
// ---------------------------------------------------------------------------

describe("parseCiricdResponse", () => {
  it("parses PASS decision", () => {
    const raw = `{"decision":"PASS","intent":"Buscar noticias","clarity":8,"risk":"low","impact":1,"context":"resolved","decompose":"ok"}`;
    const result = parseCiricdResponse(raw);
    expect(result).not.toBeNull();
    expect(result!.decision).toBe("PASS");
    expect(result!.clarity).toBe(8);
    expect(result!.risk).toBe("low");
    expect(result!.impact).toBe(1);
    expect(result!.context).toBe("resolved");
    expect(result!.decompose).toBe("ok");
    expect(result!.intent).toBe("Buscar noticias");
  });

  it("parses ASK decision with questions", () => {
    const raw = `{"decision":"ASK","intent":"Borrar archivos","clarity":2,"risk":"high","impact":5,"context":"unresolved","decompose":"ok","questions":["¿Qué archivos quieres borrar?","¿Del directorio projects/ o knowledge/?"]}`;
    const result = parseCiricdResponse(raw);
    expect(result).not.toBeNull();
    expect(result!.decision).toBe("ASK");
    expect(result!.risk).toBe("high");
    expect(result!.questions).toHaveLength(2);
    expect(result!.questions![0]).toContain("archivos");
  });

  it("parses SPLIT decision with plan", () => {
    const raw = `{"decision":"SPLIT","intent":"Migrar 23 archivos","clarity":7,"risk":"low","impact":23,"context":"resolved","decompose":"split","split_plan":"Sugiero dividir en 3 bloques:\\n1. Los 6 de X\\n2. Los 15 de Y"}`;
    const result = parseCiricdResponse(raw);
    expect(result).not.toBeNull();
    expect(result!.decision).toBe("SPLIT");
    expect(result!.decompose).toBe("split");
    expect(result!.splitPlan).toContain("dividir");
  });

  it("caps questions at 2", () => {
    const raw = `{"decision":"ASK","intent":"test","clarity":1,"risk":"high","impact":1,"context":"unresolved","decompose":"ok","questions":["Q1","Q2","Q3","Q4"]}`;
    const result = parseCiricdResponse(raw);
    expect(result!.questions).toHaveLength(2);
  });

  it("returns null for invalid JSON", () => {
    expect(parseCiricdResponse("not json at all")).toBeNull();
  });

  it("returns null for JSON without decision field", () => {
    expect(parseCiricdResponse('{"foo": "bar"}')).toBeNull();
  });

  it("extracts JSON from markdown code fence", () => {
    const raw =
      '```json\n{"decision":"PASS","intent":"test","clarity":9,"risk":"low","impact":1,"context":"resolved","decompose":"ok"}\n```';
    const result = parseCiricdResponse(raw);
    expect(result).not.toBeNull();
    expect(result!.decision).toBe("PASS");
  });

  it("normalizes decision to uppercase", () => {
    const raw = `{"decision":"pass","intent":"test","clarity":10,"risk":"low","impact":1,"context":"resolved","decompose":"ok"}`;
    const result = parseCiricdResponse(raw);
    expect(result!.decision).toBe("PASS");
  });

  it("defaults missing numeric fields", () => {
    const raw = `{"decision":"PASS","intent":"test"}`;
    const result = parseCiricdResponse(raw);
    expect(result!.clarity).toBe(5);
    expect(result!.impact).toBe(1);
    expect(result!.risk).toBe("low");
    expect(result!.context).toBe("resolved");
    expect(result!.decompose).toBe("ok");
  });
});
