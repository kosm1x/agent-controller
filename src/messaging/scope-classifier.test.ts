/**
 * Tests for scope-classifier — CIRICD-based semantic scope classification.
 */

import { describe, it, expect } from "vitest";
import {
  parseScopeGroups,
  withDeterministicGroups,
} from "./scope-classifier.js";

describe("parseScopeGroups", () => {
  it("parses valid JSON array", () => {
    const result = parseScopeGroups('["northstar_read","google"]');
    expect(result).not.toBeNull();
    expect(result!.has("northstar_read")).toBe(true);
    expect(result!.has("google")).toBe(true);
    expect(result!.size).toBe(2);
  });

  it("parses empty array", () => {
    const result = parseScopeGroups("[]");
    expect(result).not.toBeNull();
    expect(result!.size).toBe(0);
  });

  it("filters invalid group names", () => {
    const result = parseScopeGroups('["coding","invalid_group","meta"]');
    expect(result).not.toBeNull();
    expect(result!.size).toBe(2);
    expect(result!.has("coding")).toBe(true);
    expect(result!.has("meta")).toBe(true);
  });

  it("handles markdown code fences", () => {
    const result = parseScopeGroups('```json\n["northstar_write"]\n```');
    expect(result).not.toBeNull();
    expect(result!.has("northstar_write")).toBe(true);
  });

  it("handles comma-separated format", () => {
    const result = parseScopeGroups("google, schedule, intel");
    expect(result).not.toBeNull();
    expect(result!.size).toBe(3);
  });

  it("returns null for unparseable input", () => {
    expect(parseScopeGroups("I think you need google tools")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseScopeGroups("")).toBeNull();
  });

  it("handles single group as plain text", () => {
    const result = parseScopeGroups("coding");
    expect(result).not.toBeNull();
    expect(result!.has("coding")).toBe(true);
  });

  it("accepts xpoz as a valid group", () => {
    const result = parseScopeGroups('["xpoz"]');
    expect(result).not.toBeNull();
    expect(result!.has("xpoz")).toBe(true);
    expect(result!.size).toBe(1);
  });
});

describe("finance routing (usability Phase 3.4)", () => {
  it("parses 'finance' as a valid group", () => {
    expect(parseScopeGroups('["finance","google"]')).toEqual(
      new Set(["finance", "google"]),
    );
  });

  it("unions finance on deterministic ticker / price signals, case-sensitive on the ticker", () => {
    const fire = [
      "cuál es el precio de BSX hoy?",
      "dame la cotización de $AAPL",
      "market cap de NVDA",
      "precio actual de SPY",
      "P/E de MSFT",
      "precio del bitcoin",
      "valuación de la acción de TSLA",
    ];
    for (const m of fire) {
      expect(
        withDeterministicGroups(m, new Set(["intel"])).has("finance"),
        m,
      ).toBe(true);
    }
    const quiet = [
      "hola, echo $PWD y $HOME/claude",
      "precio de IVA incluido y valuación de VPS",
      "precio de la acción de CTV en el plan",
      "capitalización de KB y precio de CRM",
      "precio de la campaña de Meta Ads",
      "cotización de la renta del local",
      "el precio de venta sugerido para el curso",
      "valuación de daños en la casa",
      "cuánto pagamos de luz",
    ];
    for (const m of quiet) {
      expect(
        withDeterministicGroups(m, new Set(["google"])).has("finance"),
        m,
      ).toBe(false);
    }
  });

  it("R1 W9: is pure, never widens an EMPTY or a destructive classification", () => {
    const input = new Set(["intel"]);
    const out = withDeterministicGroups("precio de BSX", input);
    expect(out.has("finance")).toBe(true);
    expect(input.has("finance")).toBe(false);
    expect(withDeterministicGroups("precio de BSX", new Set()).size).toBe(0);
    expect(
      withDeterministicGroups(
        "borra todo lo de $SPY y confirma",
        new Set(["destructive", "jarvis_write"]),
      ).has("finance"),
    ).toBe(false);
  });
});
