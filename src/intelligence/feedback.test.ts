/**
 * Feedback signal detection tests.
 */

import { describe, it, expect } from "vitest";
import {
  detectFeedbackSignal,
  detectImplicitFeedback,
  isFeedbackMessage,
} from "./feedback.js";

describe("feedback", () => {
  describe("detectFeedbackSignal", () => {
    it("should detect positive signals", () => {
      expect(detectFeedbackSignal("excelente")).toBe("positive");
      expect(detectFeedbackSignal("Excelente")).toBe("positive");
      expect(detectFeedbackSignal("excelente, eso")).toBe("positive");
    });

    it("should NOT treat common words as positive feedback", () => {
      expect(detectFeedbackSignal("gracias")).toBe("neutral");
      expect(detectFeedbackSignal("ok")).toBe("neutral");
      expect(detectFeedbackSignal("sí")).toBe("neutral");
      expect(detectFeedbackSignal("perfecto")).toBe("neutral");
    });

    it("should detect negative signals", () => {
      expect(detectFeedbackSignal("no, eso no es")).toBe("negative");
      expect(detectFeedbackSignal("incorrecto")).toBe("negative");
      expect(detectFeedbackSignal("mal, intenta de nuevo")).toBe("negative");
      expect(detectFeedbackSignal("otra vez")).toBe("negative");
      expect(detectFeedbackSignal("no")).toBe("negative");
    });

    it("should return neutral for regular messages", () => {
      expect(detectFeedbackSignal("muéstrame las tareas")).toBe("neutral");
      expect(detectFeedbackSignal("crea una nueva meta")).toBe("neutral");
      expect(detectFeedbackSignal("qué objetivos tengo")).toBe("neutral");
    });

    it("should detect rephrase when previous message provided", () => {
      const prev = "muéstrame las tareas pendientes de esta semana";
      const curr = "dame las tareas pendientes de esta semana por favor";
      expect(detectFeedbackSignal(curr, prev)).toBe("rephrase");
    });

    it("should not detect rephrase for unrelated messages", () => {
      const prev = "muéstrame las tareas pendientes";
      const curr = "crea una nueva meta para el CRM";
      expect(detectFeedbackSignal(curr, prev)).toBe("neutral");
    });
  });

  describe("isFeedbackMessage", () => {
    it("should identify short feedback messages", () => {
      expect(isFeedbackMessage("excelente")).toBe(true);
      expect(isFeedbackMessage("no")).toBe(true);
    });

    it("should not intercept long messages", () => {
      expect(
        isFeedbackMessage(
          "gracias por eso, ahora muéstrame las tareas de la próxima semana con detalle",
        ),
      ).toBe(false);
    });

    it("should not intercept neutral messages", () => {
      expect(isFeedbackMessage("muéstrame las tareas")).toBe(false);
    });
  });

  describe("detectImplicitFeedback", () => {
    it("returns positive when scope groups have no overlap (topic change)", () => {
      expect(
        detectImplicitFeedback(
          new Set(["google"]),
          new Set(["northstar_read"]),
          "Busca en gmail",
          "Lista tareas",
        ),
      ).toBe("positive");
    });

    it("returns neutral when scope groups overlap (same topic)", () => {
      expect(
        detectImplicitFeedback(
          new Set(["northstar_read", "google"]),
          new Set(["northstar_read"]),
          "Lista objetivos y busca en gmail",
          "Lista tareas",
        ),
      ).toBe("neutral");
    });

    it("returns rephrase when message is a rephrase", () => {
      expect(
        detectImplicitFeedback(
          new Set(["northstar_read"]),
          new Set(["northstar_read"]),
          "Busca los correos de Javier del martes pasado",
          "Busca los correos de Javier de ayer por favor",
        ),
      ).toBe("rephrase");
    });

    it("returns neutral when current groups are empty", () => {
      expect(
        detectImplicitFeedback(
          new Set(),
          new Set(["northstar_read"]),
          "Hola",
          "Lista tareas",
        ),
      ).toBe("neutral");
    });

    it("returns neutral when previous groups are empty", () => {
      expect(
        detectImplicitFeedback(
          new Set(["google"]),
          new Set(),
          "Busca en gmail",
          "Hola",
        ),
      ).toBe("neutral");
    });

    it("returns neutral when both groups are empty", () => {
      expect(detectImplicitFeedback(new Set(), new Set(), "Hola", "Hey")).toBe(
        "neutral",
      );
    });
  });
});
