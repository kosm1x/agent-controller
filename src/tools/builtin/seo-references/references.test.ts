/**
 * Tests for SEO reference libraries — pure data modules, no dependencies.
 */

import { describe, it, expect } from "vitest";
import { classifyIntent, classifyIntents } from "./intent-taxonomy.js";
import {
  scoreGeoPotential,
  filterGeoCandidates,
  GEO_TACTICS,
} from "./geo-signals.js";
import { validateMeta, getFormula, CHAR_LIMITS } from "./meta-formulas.js";
import { buildSchemaMarkup, validateSchemaInput } from "./schema-templates.js";
import { suggestEeatSignals, EEAT_SIGNALS } from "./eeat-framework.js";

describe("intent-taxonomy", () => {
  it("classifies informational questions", () => {
    const result = classifyIntent("what is SEO");
    expect(result.intent).toBe("informational");
    expect(result.confidence).toBeGreaterThan(0);
  });

  it("classifies commercial queries", () => {
    const result = classifyIntent("best SEO tools 2026");
    expect(result.intent).toBe("commercial");
  });

  it("classifies transactional queries", () => {
    const result = classifyIntent("buy SEO software now");
    expect(result.intent).toBe("transactional");
  });

  it("classifies Spanish queries correctly", () => {
    expect(classifyIntent("qué es SEO").intent).toBe("informational");
    expect(classifyIntent("mejor software SEO").intent).toBe("commercial");
    expect(classifyIntent("comprar software SEO").intent).toBe("transactional");
  });

  it("defaults to informational on ambiguous keywords", () => {
    const result = classifyIntent("random word");
    expect(result.intent).toBe("informational");
    expect(result.confidence).toBe(0);
  });

  it("classifies a batch at once", () => {
    const result = classifyIntents(["what is x", "buy x", "best x"]);
    expect(result).toHaveLength(3);
    expect(result[0].intent).toBe("informational");
    expect(result[1].intent).toBe("transactional");
    expect(result[2].intent).toBe("commercial");
  });
});

describe("geo-signals", () => {
  it("scores definitional queries high", () => {
    const result = scoreGeoPotential("what is quantum computing");
    expect(result.score).toBeGreaterThanOrEqual(30);
    expect(result.families).toContain("question");
  });

  it("scores comparison queries high", () => {
    const result = scoreGeoPotential("React vs Vue");
    expect(result.score).toBeGreaterThanOrEqual(30);
    expect(result.families).toContain("comparison");
  });

  it("scores how-to queries high", () => {
    const result = scoreGeoPotential("how to bake bread");
    expect(result.score).toBeGreaterThanOrEqual(30);
    expect(result.families).toContain("howto");
  });

  it("scores purely commercial queries low", () => {
    const result = scoreGeoPotential("Nike running shoes");
    expect(result.score).toBeLessThan(30);
  });

  it("filters GEO candidates above threshold", () => {
    const candidates = filterGeoCandidates(
      [
        "what is SEO",
        "buy running shoes",
        "how to optimize images",
        "Nike Air Max price",
      ],
      30,
    );
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    expect(candidates.some((c) => c.keyword === "buy running shoes")).toBe(
      false,
    );
  });

  it("exposes non-empty GEO_TACTICS list", () => {
    expect(GEO_TACTICS.length).toBeGreaterThan(0);
  });
});

describe("meta-formulas", () => {
  it("validates title within range", () => {
    const warnings = validateMeta({
      title: "A Good Title That Is Just About Right For Google SERP",
    });
    expect(warnings).toEqual([]);
  });

  it("flags title too short", () => {
    const warnings = validateMeta({ title: "Short" });
    expect(warnings.some((w) => w.includes("title"))).toBe(true);
  });

  it("flags description too long", () => {
    const warnings = validateMeta({ description: "A".repeat(200) });
    expect(warnings.some((w) => w.includes("description"))).toBe(true);
  });

  it("returns formula by content type", () => {
    const formula = getFormula("how_to");
    expect(formula.titles.length).toBeGreaterThan(0);
    expect(formula.descriptions.length).toBeGreaterThan(0);
  });

  it("falls back to article formula for unknown content type", () => {
    // Intentionally cast to force fallback path
    const formula = getFormula("nonexistent" as unknown as "article");
    expect(formula.titles.length).toBeGreaterThan(0);
  });

  it("exposes character limits for all tag types", () => {
    expect(CHAR_LIMITS.title.max).toBe(60);
    expect(CHAR_LIMITS.description.max).toBe(155);
  });
});

describe("schema-templates", () => {
  it("builds valid Article schema", () => {
    const result = buildSchemaMarkup("Article", {
      headline: "Test",
      author: "Jane Doe",
      datePublished: "2026-04-12",
    });
    expect(result.validation.valid).toBe(true);
    const parsed = JSON.parse(result.json_ld);
    expect(parsed["@type"]).toBe("Article");
  });

  it("reports missing required field for FAQPage", () => {
    const warnings = validateSchemaInput("FAQPage", {});
    expect(warnings.some((w) => w.includes("questions"))).toBe(true);
  });
});

describe("eeat-framework", () => {
  it("suggests experience signals for reviews", () => {
    const signals = suggestEeatSignals("review", "commercial");
    expect(signals.some((s) => s.category === "experience")).toBe(true);
  });

  it("suggests authoritativeness for informational pillar content", () => {
    const signals = suggestEeatSignals("pillar", "informational");
    expect(signals.some((s) => s.category === "authoritativeness")).toBe(true);
  });

  it("always includes trustworthiness baseline", () => {
    const signals = suggestEeatSignals("landing", "transactional");
    expect(signals.some((s) => s.category === "trustworthiness")).toBe(true);
  });

  it("exposes EEAT_SIGNALS constants", () => {
    expect(EEAT_SIGNALS.length).toBeGreaterThan(0);
  });
});
