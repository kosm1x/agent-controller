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

  it("normalizes NFD (decomposed) accents to NFC so scope regex char classes match", () => {
    // NFD form: "i" (U+0069) + combining acute U+0301 → displays as "í"
    // Some mobile keyboards / autocorrect deliver NFD; our scope regexes use
    // character classes like `art[ií]culo` that only match single-codepoint
    // NFC. Without this normalization, "el artículo 546" in NFD form fails
    // to activate the wordpress scope group.
    const nfd = "art\u0069\u0301culo 546";
    const nfc = normalizeForMatching(nfd);
    expect(nfc).toContain("art\u00EDculo");
    // NFC form is one codepoint shorter than NFD.
    expect(nfc.length).toBeLessThan(nfd.length);
  });

  it("leaves already-NFC text unchanged (idempotent)", () => {
    const nfc = "artículo 546";
    expect(normalizeForMatching(nfc)).toBe(nfc);
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
