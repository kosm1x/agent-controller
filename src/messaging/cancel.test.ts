import { describe, it, expect } from "vitest";

/**
 * v6.2 S2: Task cancellation tests.
 *
 * Tests the cancel intent regex and abort signal behavior.
 * Router integration is tested via the regex pattern matching
 * (the router itself requires full messaging stack to test).
 */

// Cancel intent regexes — must match the ones in router.ts (Phase 4.4)
const CANCEL_INTENT_RE =
  /^(cancela|detente|para|alto|stop|cancel|aborta|déjalo|dejalo)((\s+|,\s*)(ya|ahora|todo|todas?|eso|esto|la\s+tarea|las\s+tareas|todas\s+las\s+tareas|por\s+favor|porfa|please))*\s*[.!]*\s*$/i;
const CANCEL_LEADING_RE = /^detente\b[\s,.!—:-]|^alto\s*[,.!—:;-]/i;
const isCancel = (t: string): boolean =>
  CANCEL_INTENT_RE.test(t.trim()) || CANCEL_LEADING_RE.test(t.trim());

describe("cancel intent detection", () => {
  it("test regexes mirror the ones in router.ts (drift guard)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./router.ts", import.meta.url), "utf-8");
    expect(src).toContain(CANCEL_INTENT_RE.source);
    expect(src).toContain(CANCEL_LEADING_RE.source);
  });

  describe("matches valid cancel commands", () => {
    const validCancels = [
      "cancela",
      "Cancela",
      "CANCELA",
      "detente",
      "Detente",
      "para",
      "Para",
      "stop",
      "Stop",
      "STOP",
      "cancel",
      "Cancel",
      "aborta",
      "Aborta",
      "déjalo",
      "dejalo",
      "  cancela  ", // whitespace trimmed by router
      "DETENTE",
      // Phase 4.4: bounded qualifiers after the stop-verb
      "para ya",
      "Para ya!",
      "alto",
      "Alto!",
      "cancela todo",
      "Cancela todas las tareas",
      "detente ahora",
      "para, por favor",
      "aborta eso",
      // Phase 4.4: unambiguous leading stop-verbs with a free tail
      "Detente, cambio de plan",
      "detente un momento y escucha", // leading detente = stop (#11367–11369)
      "Alto — eso no era lo que pedí",
    ];

    for (const cmd of validCancels) {
      it(`matches "${cmd}"`, () => {
        expect(isCancel(cmd)).toBe(true);
      });
    }
  });

  describe("does NOT match non-cancel messages", () => {
    const notCancels = [
      "cancela agente", // background agent cancel (separate handler)
      "cancela la tarea de mañana",
      "Cancela la reunión del viernes", // calendar op, not a task stop
      "para qué sirve esto?",
      "para mañana necesito",
      "Para el viernes recuérdame el reporte",
      "alto rendimiento en ventas", // adjective, not a stop
      "stop the world",
      "cancel my subscription",
      "hola",
      "qué tal",
      "hazme un video",
      "lista mis agentes",
      "",
      "cancelar", // different verb form — not in the list
    ];

    for (const msg of notCancels) {
      it(`does NOT match "${msg}"`, () => {
        expect(isCancel(msg)).toBe(false);
      });
    }
  });
});

describe("AbortController signal behavior", () => {
  it("signal starts as not aborted", () => {
    const controller = new AbortController();
    expect(controller.signal.aborted).toBe(false);
  });

  it("abort() sets signal.aborted to true", () => {
    const controller = new AbortController();
    controller.abort();
    expect(controller.signal.aborted).toBe(true);
  });

  it("abort reason is available after abort", () => {
    const controller = new AbortController();
    controller.abort("user cancelled");
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBe("user cancelled");
  });

  it("multiple abort() calls are idempotent", () => {
    const controller = new AbortController();
    controller.abort();
    controller.abort(); // no-op
    expect(controller.signal.aborted).toBe(true);
  });
});
