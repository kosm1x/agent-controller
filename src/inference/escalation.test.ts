import { describe, it, expect } from "vitest";
import {
  createEscalationState,
  escalate,
  detectPhantomActions,
} from "./escalation.js";

describe("Escalation ladder", () => {
  it("starts at level 1 (RETRY_DIFFERENT)", () => {
    const state = createEscalationState();
    const action = escalate(state);
    expect(action.level).toBe(1);
    expect(action.action).toBe("RETRY_DIFFERENT");
  });

  it("progresses to level 2 (ESCALATE_MODEL) on second trigger", () => {
    const state = createEscalationState();
    escalate(state); // trigger 1 → level 1
    const action = escalate(state); // trigger 2 → level 2
    expect(action.level).toBe(2);
    expect(action.action).toBe("ESCALATE_MODEL");
  });

  it("progresses to level 3 (FORCE_WRAPUP) on third trigger", () => {
    const state = createEscalationState();
    escalate(state);
    escalate(state);
    const action = escalate(state);
    expect(action.level).toBe(3);
    expect(action.action).toBe("FORCE_WRAPUP");
  });

  it("progresses to level 4 (ABORT) on fourth trigger", () => {
    const state = createEscalationState();
    escalate(state);
    escalate(state);
    escalate(state);
    const action = escalate(state);
    expect(action.level).toBe(4);
    expect(action.action).toBe("ABORT");
  });

  it("stays at level 4 on subsequent triggers", () => {
    const state = createEscalationState();
    for (let i = 0; i < 6; i++) escalate(state);
    expect(state.currentLevel).toBe(4);
    expect(state.triggerCount).toBe(6);
  });

  it("includes a message at every level", () => {
    const state = createEscalationState();
    for (let i = 0; i < 4; i++) {
      const action = escalate(state);
      expect(action.message.length).toBeGreaterThan(10);
    }
  });
});

describe("Phantom action detection", () => {
  it("detects Spanish 'envié' + 'email' without gmail_send", () => {
    const phantoms = detectPhantomActions(
      "Listo Fede, envié el correo con el reporte adjunto.",
      ["web_search"],
    );
    expect(phantoms.length).toBeGreaterThan(0);
    expect(phantoms[0].verb).toBe("envié");
    expect(phantoms[0].channel).toBe("correo");
  });

  it("detects English 'sent' + 'email' without gmail_send", () => {
    const phantoms = detectPhantomActions(
      "I sent the email with the report attached.",
      ["web_read"],
    );
    expect(phantoms.length).toBeGreaterThan(0);
  });

  it("does NOT fire when gmail_send was actually called", () => {
    const phantoms = detectPhantomActions("Envié el correo con el reporte.", [
      "gmail_send",
    ]);
    expect(phantoms).toHaveLength(0);
  });

  it("does NOT fire when no action verb present", () => {
    const phantoms = detectPhantomActions(
      "Aquí está el resumen del análisis que pediste.",
      ["web_search"],
    );
    expect(phantoms).toHaveLength(0);
  });

  it("does NOT fire on empty or very short text", () => {
    expect(detectPhantomActions("", ["web_search"])).toHaveLength(0);
    expect(detectPhantomActions("ok", ["web_search"])).toHaveLength(0);
  });

  it("detects 'publiqué' + 'wordpress' without wp_publish", () => {
    const phantoms = detectPhantomActions(
      "Ya publiqué el artículo en WordPress.",
      ["web_read"],
    );
    expect(phantoms.length).toBeGreaterThan(0);
    expect(phantoms[0].channel).toBe("wordpress");
  });

  it("does NOT fire when wp_publish was called", () => {
    const phantoms = detectPhantomActions(
      "Ya publiqué el artículo en WordPress.",
      ["wp_publish"],
    );
    expect(phantoms).toHaveLength(0);
  });

  it("detects 'updated' + 'calendar' without calendar_update", () => {
    const phantoms = detectPhantomActions(
      "I updated the calendar event for tomorrow.",
      ["web_search"],
    );
    expect(phantoms.length).toBeGreaterThan(0);
  });
});
