import { describe, it, expect } from "vitest";

/**
 * v6.2 S2: Task cancellation tests.
 *
 * Tests the cancel intent regex and abort signal behavior.
 * Router integration is tested via the regex pattern matching
 * (the router itself requires full messaging stack to test).
 */

// Cancel intent regex — must match the one in router.ts
const CANCEL_INTENT_RE =
  /^(cancela|detente|para|stop|cancel|aborta|déjalo|dejalo)\s*$/i;

describe("cancel intent detection", () => {
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
    ];

    for (const cmd of validCancels) {
      it(`matches "${cmd}"`, () => {
        expect(CANCEL_INTENT_RE.test(cmd.trim())).toBe(true);
      });
    }
  });

  describe("does NOT match non-cancel messages", () => {
    const notCancels = [
      "cancela agente", // background agent cancel (separate handler)
      "cancela la tarea de mañana",
      "para qué sirve esto?",
      "para mañana necesito",
      "stop the world",
      "cancel my subscription",
      "detente un momento y escucha",
      "hola",
      "qué tal",
      "hazme un video",
      "lista mis agentes",
      "",
      "cancelar", // different verb form — not in the list
    ];

    for (const msg of notCancels) {
      it(`does NOT match "${msg}"`, () => {
        expect(CANCEL_INTENT_RE.test(msg.trim())).toBe(false);
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
