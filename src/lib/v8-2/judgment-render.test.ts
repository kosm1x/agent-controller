/**
 * V8.2 strategic-section renderer tests (spec §9 drop-vs-surface).
 *
 * Pure function — no DB. Builds `JudgmentRow` literals directly and asserts the
 * delivery-time filter: green/yellow surface (with options); red OR
 * critic-`unfixable` surface only via the at_risk/recurring_blocker carve-out
 * (optionless heads-up); everything else drops.
 */

import { describe, expect, it } from "vitest";
import { renderStrategicSection } from "./judgment-render.js";
import type { JudgmentRow } from "./judgments-store.js";

function row(over: Partial<JudgmentRow> = {}): JudgmentRow {
  return {
    id: 1,
    briefingId: "b-1",
    subject: "denue-data-analysis",
    posture: "noted",
    prose: "La cobertura de campos subió a 36/39 esta semana.",
    confidence: "green",
    signalKind: "stalled_task",
    signalLastSeenAt: null,
    createdAt: "2026-06-25T12:00:00.000Z",
    evidenceRefsJson: null,
    proposedOptionsJson: null,
    strategicVoicePrincipleId: null,
    concessionKind: null,
    triggeringEvidenceText: null,
    confidenceBasisJson: null,
    criticTrailJson: null,
    ...over,
  };
}

const OPTS = JSON.stringify([
  {
    label: "A",
    summary: "Priorizar Datatur",
    tradeoffs: [],
    rank: 1,
    generated_by_role: "synthesizer",
  },
  {
    label: "B",
    summary: "Cerrar los 3 campos faltantes",
    tradeoffs: [],
    rank: 2,
    generated_by_role: "analyst",
  },
  {
    label: "C",
    summary: "Pausar y validar en prod",
    tradeoffs: [],
    rank: 3,
    generated_by_role: "seeker",
  },
]);

const unfixable = JSON.stringify({ verdict: "unfixable", iterations: 2 });

describe("renderStrategicSection — §9 delivery-time filter", () => {
  it("returns null for an empty list", () => {
    expect(renderStrategicSection([])).toBeNull();
  });

  it("surfaces a green judgment with its A/B/C options under the section header", () => {
    const out = renderStrategicSection([
      row({ confidence: "green", proposedOptionsJson: OPTS }),
    ]);
    expect(out).toContain("Lectura estratégica");
    expect(out).toContain("denue-data-analysis");
    expect(out).toContain("Opciones:");
    expect(out).toContain("Priorizar Datatur");
  });

  it("surfaces a yellow judgment with its confidence dot", () => {
    const out = renderStrategicSection([row({ confidence: "yellow" })]);
    expect(out).not.toBeNull();
    expect(out).toContain("🟡");
  });

  it("drops a red judgment that is neither at_risk nor recurring_blocker", () => {
    expect(
      renderStrategicSection([
        row({
          confidence: "red",
          posture: "momentum",
          signalKind: "stalled_task",
        }),
      ]),
    ).toBeNull();
  });

  it("surfaces a red at_risk judgment as an optionless heads-up", () => {
    const out = renderStrategicSection([
      row({ confidence: "red", posture: "at_risk", proposedOptionsJson: OPTS }),
    ]);
    expect(out).not.toBeNull();
    expect(out).toContain("Señal temprana");
    // §9: optionless even though proposed_options exist on the row.
    expect(out).not.toContain("Opciones:");
  });

  it("surfaces a red judgment via the recurring_blocker kind carve-out", () => {
    const out = renderStrategicSection([
      row({
        confidence: "red",
        posture: "noted",
        signalKind: "recurring_blocker",
      }),
    ]);
    expect(out).not.toBeNull();
    expect(out).toContain("Señal temprana");
  });

  it("drops a critic-unfixable judgment outside the carve-out (even at green color)", () => {
    expect(
      renderStrategicSection([
        row({
          confidence: "green",
          posture: "momentum",
          criticTrailJson: unfixable,
        }),
      ]),
    ).toBeNull();
  });

  it("surfaces a critic-unfixable at_risk judgment as a heads-up", () => {
    const out = renderStrategicSection([
      row({
        confidence: "yellow",
        posture: "at_risk",
        criticTrailJson: unfixable,
      }),
    ]);
    expect(out).not.toBeNull();
    expect(out).toContain("Señal temprana");
  });

  it("orders highest_leverage before noted", () => {
    const out = renderStrategicSection([
      row({ id: 1, posture: "noted", subject: "later-item" }),
      row({ id: 2, posture: "highest_leverage", subject: "lead-item" }),
    ])!;
    expect(out.indexOf("lead-item")).toBeLessThan(out.indexOf("later-item"));
  });

  it("drops a null-confidence (un-finalized) judgment outside the carve-out", () => {
    expect(
      renderStrategicSection([row({ confidence: null, posture: "noted" })]),
    ).toBeNull();
  });

  it("surfaces a null-confidence at_risk judgment as an optionless heads-up with a neutral dot", () => {
    const out = renderStrategicSection([
      row({ confidence: null, posture: "at_risk", proposedOptionsJson: OPTS }),
    ]);
    expect(out).not.toBeNull();
    expect(out).toContain("⚪");
    expect(out).toContain("Señal temprana");
    // un-vetted (null confidence) never reaches the options tier.
    expect(out).not.toContain("Opciones:");
  });

  it("surfaces a critic-unfixable recurring_blocker judgment as a heads-up", () => {
    const out = renderStrategicSection([
      row({
        confidence: "yellow",
        posture: "noted",
        signalKind: "recurring_blocker",
        criticTrailJson: unfixable,
      }),
    ]);
    expect(out).not.toBeNull();
    expect(out).toContain("Señal temprana");
  });

  it("degrades to no options on malformed proposed_options JSON", () => {
    const out = renderStrategicSection([
      row({ confidence: "green", proposedOptionsJson: "{not valid" }),
    ]);
    expect(out).not.toBeNull();
    expect(out).not.toContain("Opciones:");
  });

  it("keeps deliverables and drops non-deliverables from a mixed batch", () => {
    const out = renderStrategicSection([
      row({ id: 1, confidence: "green", subject: "keep-green" }),
      row({
        id: 2,
        confidence: "red",
        posture: "momentum",
        subject: "drop-red",
      }),
      row({
        id: 3,
        confidence: "red",
        posture: "at_risk",
        subject: "keep-atrisk",
      }),
    ])!;
    expect(out).toContain("keep-green");
    expect(out).toContain("keep-atrisk");
    expect(out).not.toContain("drop-red");
  });
});
