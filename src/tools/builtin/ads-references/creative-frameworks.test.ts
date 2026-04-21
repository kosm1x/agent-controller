/**
 * Tests for renderFrameworkPrompt — placeholder substitution hardened
 * against the round-1 audit M3 `$`-substitution footgun.
 */

import { describe, it, expect } from "vitest";
import { renderFrameworkPrompt } from "./creative-frameworks.js";

describe("renderFrameworkPrompt", () => {
  it("substitutes brand / audience / objective / platform / offer", () => {
    const out = renderFrameworkPrompt("AIDA", {
      brand: "Crisp Co",
      audience: "solo founders",
      objective: "conversions",
      platform: "meta_feed",
      offer: "A dev-ops tool at $49/mo",
    });
    expect(out).toContain("Crisp Co");
    expect(out).toContain("solo founders");
    expect(out).toContain("conversions");
    expect(out).toContain("meta_feed");
    expect(out).toContain("A dev-ops tool at $49/mo");
  });

  it("preserves '$' sequences literally in the offer (round-1 audit M3)", () => {
    // String.prototype.replace(regex, string) interprets `$&`, `` $` ``,
    // `$'`, and `$1..$9` in the replacement. replaceAll(string, string)
    // does NOT — the replacement is taken literally.
    const out = renderFrameworkPrompt("AIDA", {
      brand: "b",
      audience: "a",
      objective: "o",
      platform: "p",
      offer: "$49/mo — save $10, price $1 $2 $&",
    });
    expect(out).toContain("$49/mo");
    expect(out).toContain("$10");
    expect(out).toContain("$1 $2 $&");
  });

  it("preserves '$' in the brand name too", () => {
    const out = renderFrameworkPrompt("PAS", {
      brand: "$uperBrand",
      audience: "a",
      objective: "o",
      platform: "p",
      offer: "thing",
    });
    expect(out).toContain("$uperBrand");
  });

  it("throws on unknown framework id", () => {
    // @ts-expect-error intentional invalid id
    expect(() =>
      renderFrameworkPrompt("NOPE", {
        brand: "b",
        audience: "a",
        objective: "o",
        platform: "p",
        offer: "x",
      }),
    ).toThrow(/Unknown framework/);
  });
});
