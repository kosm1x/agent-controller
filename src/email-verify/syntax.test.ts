import { describe, it, expect } from "vitest";
import { checkSyntax, levenshtein, suggestDomain } from "./syntax.js";

describe("checkSyntax", () => {
  it("accepts a plain address and lowercases the domain", () => {
    const r = checkSyntax("  Dr.Perez+x@Hospital-ABC.com.MX ");
    expect(r.isValid).toBe(true);
    expect(r.domain).toBe("hospital-abc.com.mx");
    expect(r.localPart).toBe("dr.perez+x");
    expect(r.normalized).toBe("dr.perez+x@hospital-abc.com.mx");
  });

  it.each([
    ["", "empty"],
    ["foo", "missing @"],
    ["foo@bar", "no TLD"],
    ["@bar.com", "empty local"],
    ["foo@", "empty domain"],
    ["a@b@c.com", "multiple @"],
    [".foo@bar.com", "dot placement"],
    ["foo..bar@bar.com", "dot placement"],
    ["foo.@bar.com", "dot placement"],
    ["foo bar@bar.com", "whitespace"],
    ["foo@bar.c0m", "TLD"],
    ["foo@-bar.com", "label"],
    ["josé@bar.com", "non-ASCII"],
    ["\"quoted\"@bar.com", "forbidden"],
    ["foo@bar.com\r\nRCPT TO:<x@y.z>", "whitespace or forbidden"],
  ])("rejects %j", (input, reasonFragment) => {
    const r = checkSyntax(input);
    expect(r.isValid).toBe(false);
    expect(r.normalized).toBeNull();
    expect(r.reason ?? "").toContain(reasonFragment);
  });

  it("enforces length limits", () => {
    expect(checkSyntax(`${"a".repeat(65)}@x.com`).isValid).toBe(false);
    expect(checkSyntax(`${"a".repeat(64)}@x.com`).isValid).toBe(true);
    expect(checkSyntax(`a@${"b".repeat(64)}.com`).isValid).toBe(false);
  });
});

describe("suggestDomain", () => {
  it("computes levenshtein", () => {
    expect(levenshtein("gmail.com", "gmial.com")).toBe(2);
    expect(levenshtein("", "abc")).toBe(3);
  });
  it("suggests a nearby provider", () => {
    expect(suggestDomain("ana", "gmial.com")).toBe("ana@gmail.com");
    expect(suggestDomain("ana", "hotmal.com")).toBe("ana@hotmail.com");
  });
  it("returns null for the provider itself or a distant domain", () => {
    expect(suggestDomain("ana", "gmail.com")).toBeNull();
    expect(suggestDomain("ana", "hospitalangeles.com")).toBeNull();
  });
});
