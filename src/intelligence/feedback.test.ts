/**
 * Feedback signal detection tests.
 */

import { describe, it, expect } from "vitest";
import { detectFeedbackSignal, isFeedbackMessage } from "./feedback.js";

describe("feedback", () => {
  describe("detectFeedbackSignal", () => {
    it("should detect positive signals", () => {
      expect(detectFeedbackSignal("gracias")).toBe("positive");
      expect(detectFeedbackSignal("Perfecto")).toBe("positive");
      expect(detectFeedbackSignal("exacto, eso")).toBe("positive");
      expect(detectFeedbackSignal("ok")).toBe("positive");
      expect(detectFeedbackSignal("listo")).toBe("positive");
      expect(detectFeedbackSignal("genial")).toBe("positive");
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
      expect(isFeedbackMessage("gracias")).toBe(true);
      expect(isFeedbackMessage("perfecto")).toBe(true);
      expect(isFeedbackMessage("no")).toBe(true);
      expect(isFeedbackMessage("ok")).toBe(true);
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
});
