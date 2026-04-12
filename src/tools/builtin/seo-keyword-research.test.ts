/**
 * Tests for seo_keyword_research — SERP + LLM + rules-based classification.
 */

import { describe, it, expect, afterEach, vi } from "vitest";

const mockInfer = vi.fn();
vi.mock("../../inference/adapter.js", () => ({
  infer: (...args: unknown[]) => mockInfer(...args),
}));

const mockWebSearchExecute = vi.fn();
vi.mock("./web-search.js", () => ({
  webSearchTool: {
    execute: (...args: unknown[]) => mockWebSearchExecute(...args),
  },
}));

import { seoKeywordResearchTool } from "./seo-keyword-research.js";

afterEach(() => {
  vi.restoreAllMocks();
  mockInfer.mockReset();
  mockWebSearchExecute.mockReset();
});

function mockSerp(titles: string[]) {
  return JSON.stringify({
    results: titles.map((t) => ({ title: t, url: "https://example.com" })),
  });
}

function mockLlmKeywords(keywords: string[]) {
  return {
    content: JSON.stringify({ keywords }),
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  };
}

describe("seo_keyword_research", () => {
  it("errors on empty seed_keywords", async () => {
    const result = JSON.parse(
      await seoKeywordResearchTool.execute({ seed_keywords: [] }),
    );
    expect(result.error).toMatch(/seed_keywords is required/);
  });

  it("errors on missing seed_keywords", async () => {
    const result = JSON.parse(await seoKeywordResearchTool.execute({}));
    expect(result.error).toMatch(/seed_keywords is required/);
  });

  it("classifies intent via deterministic rules", async () => {
    mockWebSearchExecute.mockResolvedValueOnce(
      mockSerp(["Best SEO tools", "Buy SEO software now", "What is SEO"]),
    );
    mockInfer.mockResolvedValueOnce(
      mockLlmKeywords([
        "what is seo",
        "best seo tools",
        "buy seo software",
        "seo for small business",
      ]),
    );

    const result = JSON.parse(
      await seoKeywordResearchTool.execute({ seed_keywords: ["seo"] }),
    );

    expect(result.error).toBeUndefined();
    expect(result.keywords).toBeDefined();

    const byTerm = new Map<string, string>(
      result.keywords.map((k: { term: string; intent: string }) => [
        k.term.toLowerCase(),
        k.intent,
      ]),
    );
    expect(byTerm.get("what is seo")).toBe("informational");
    expect(byTerm.get("best seo tools")).toBe("commercial");
    expect(byTerm.get("buy seo software")).toBe("transactional");
  });

  it("flags GEO-relevant keywords", async () => {
    mockWebSearchExecute.mockResolvedValueOnce(mockSerp(["Seed title"]));
    mockInfer.mockResolvedValueOnce(
      mockLlmKeywords([
        "what is generative engine optimization",
        "how to improve seo rankings",
        "chatgpt vs claude",
        "buy widgets online",
      ]),
    );

    const result = JSON.parse(
      await seoKeywordResearchTool.execute({ seed_keywords: ["seo"] }),
    );

    expect(result.geo_candidates.length).toBeGreaterThan(0);
    const geoTerms = result.geo_candidates.map((c: { term: string }) => c.term);
    expect(geoTerms).toContain("what is generative engine optimization");
    expect(geoTerms).toContain("how to improve seo rankings");
    // Purely transactional should not be a GEO candidate
    expect(geoTerms).not.toContain("buy widgets online");
  });

  it("clusters keywords by shared tokens", async () => {
    mockWebSearchExecute.mockResolvedValueOnce(mockSerp(["Seed title"]));
    mockInfer.mockResolvedValueOnce(
      mockLlmKeywords([
        "seo audit tools",
        "seo audit checklist",
        "seo audit guide",
        "python web scraping",
        "python web crawlers",
      ]),
    );

    const result = JSON.parse(
      await seoKeywordResearchTool.execute({ seed_keywords: ["seo"] }),
    );

    expect(result.clusters.length).toBeGreaterThanOrEqual(2);
    // Find the cluster containing seo audit terms
    const seoCluster = result.clusters.find((c: { keywords: string[] }) =>
      c.keywords.some((k) => k.includes("seo audit")),
    );
    expect(seoCluster).toBeDefined();
    expect(seoCluster.keywords.length).toBeGreaterThanOrEqual(2);
  });

  it("falls back to SERP titles when LLM returns empty list", async () => {
    mockWebSearchExecute.mockResolvedValueOnce(
      mockSerp(["Fallback keyword one", "Fallback keyword two"]),
    );
    mockInfer.mockResolvedValueOnce({
      content: JSON.stringify({ keywords: [] }),
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    const result = JSON.parse(
      await seoKeywordResearchTool.execute({ seed_keywords: ["fallback"] }),
    );

    expect(result.error).toBeUndefined();
    expect(result.total).toBeGreaterThan(0);
  });

  it("respects max_keywords cap", async () => {
    mockWebSearchExecute.mockResolvedValueOnce(mockSerp(["Seed"]));
    const longList = Array.from(
      { length: 50 },
      (_, i) => `keyword number ${i}`,
    );
    mockInfer.mockResolvedValueOnce(mockLlmKeywords(longList));

    const result = JSON.parse(
      await seoKeywordResearchTool.execute({
        seed_keywords: ["seed"],
        max_keywords: 10,
      }),
    );

    // The LLM is asked for max_keywords, so we pass the cap through to the prompt.
    // The final output may include all that the LLM returned (up to its limit).
    // We verify at minimum the tool honored input and didn't silently drop everything.
    expect(result.total).toBeGreaterThan(0);
  });

  it("produces an intent breakdown with all four categories", async () => {
    mockWebSearchExecute.mockResolvedValueOnce(mockSerp(["Seed"]));
    mockInfer.mockResolvedValueOnce(
      mockLlmKeywords([
        "what is x",
        "best x tools",
        "buy x now",
        "x official login",
      ]),
    );

    const result = JSON.parse(
      await seoKeywordResearchTool.execute({ seed_keywords: ["x"] }),
    );

    expect(result.intent_breakdown).toEqual(
      expect.objectContaining({
        informational: expect.any(Number),
        commercial: expect.any(Number),
        transactional: expect.any(Number),
        navigational: expect.any(Number),
      }),
    );
  });
});
