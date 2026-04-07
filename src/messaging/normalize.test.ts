/**
 * Tests for normalize — input normalization for scope matching.
 */

import { describe, it, expect } from "vitest";
import { normalizeForMatching, wasNormalized } from "./normalize.js";

describe("normalizeForMatching", () => {
  it("fixes common tool name typos", () => {
    expect(normalizeForMatching("revisa el whatspp")).toContain("whatsapp");
    expect(normalizeForMatching("publica en instragram")).toContain(
      "instagram",
    );
    expect(normalizeForMatching("abre nortstar")).toContain("northstar");
    expect(normalizeForMatching("push a githup")).toContain("github");
  });

  it("fixes Spanish verb typos", () => {
    expect(normalizeForMatching("actuliza la tarea")).toContain("actualiza");
    expect(normalizeForMatching("sincronisa con el server")).toContain(
      "sincroniza",
    );
  });

  it("fixes English typos", () => {
    expect(normalizeForMatching("serach for news")).toContain("search");
    expect(normalizeForMatching("delpoy the changes")).toContain("deploy");
    expect(normalizeForMatching("check stauts")).toContain("status");
  });

  it("preserves capitalization pattern", () => {
    const result = normalizeForMatching("Revisa Northstarr");
    expect(result).toContain("Northstar");
  });

  it("does not modify correct text", () => {
    const text = "Envía un correo a javier con el reporte de tareas";
    expect(normalizeForMatching(text)).toBe(text);
  });

  it("handles mixed correct and incorrect words", () => {
    const result = normalizeForMatching("haz comit y delpoy");
    expect(result).toContain("commit");
    expect(result).toContain("deploy");
  });
});

describe("wasNormalized", () => {
  it("returns true when text changed", () => {
    expect(wasNormalized("whatspp", "whatsapp")).toBe(true);
  });

  it("returns false when text unchanged", () => {
    expect(wasNormalized("hello", "hello")).toBe(false);
  });
});
