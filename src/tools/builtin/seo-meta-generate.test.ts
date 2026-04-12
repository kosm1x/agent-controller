/**
 * Tests for seo_meta_generate — template + LLM meta tag generator.
 */

import { describe, it, expect, afterEach, vi } from "vitest";

const mockInfer = vi.fn();
vi.mock("../../inference/adapter.js", () => ({
  infer: (...args: unknown[]) => mockInfer(...args),
}));

const mockWebReadExecute = vi.fn();
vi.mock("./web-read.js", () => ({
  webReadTool: {
    execute: (...args: unknown[]) => mockWebReadExecute(...args),
  },
}));

import { seoMetaGenerateTool } from "./seo-meta-generate.js";

afterEach(() => {
  vi.restoreAllMocks();
  mockInfer.mockReset();
  mockWebReadExecute.mockReset();
});

function llmResponse(variants: unknown[]): { content: string; usage: unknown } {
  return {
    content: JSON.stringify({ variants }),
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  };
}

describe("seo_meta_generate", () => {
  it("returns error if content is missing", async () => {
    const result = JSON.parse(
      await seoMetaGenerateTool.execute({ target_keyword: "keyword" }),
    );
    expect(result.error).toMatch(/content is required/);
  });

  it("returns error if target_keyword is missing", async () => {
    const result = JSON.parse(
      await seoMetaGenerateTool.execute({ content: "Some content here" }),
    );
    expect(result.error).toMatch(/target_keyword is required/);
  });

  it("generates 3 variants under character limits", async () => {
    mockInfer.mockResolvedValueOnce(
      llmResponse([
        {
          title: "SEO Keyword Guide: Best Practices in 2026",
          description:
            "Learn SEO keyword research with real examples and actionable tips. Step-by-step guide covering intent, volume, and competition.",
          og_title: "SEO Keyword Guide: Best Practices in 2026",
          og_description:
            "Learn SEO keyword research with real examples and actionable tips. Step-by-step guide covering intent, volume, and competition.",
          twitter_title: "SEO Keyword Guide: Best Practices in 2026",
          twitter_description:
            "Learn SEO keyword research with real examples and actionable tips. Step-by-step guide covering intent, volume, and competition.",
        },
        {
          title: "Master SEO Keyword Research — Complete 2026 Tutorial",
          description:
            "Discover how to find high-value SEO keywords in 2026. Intent classification, GEO scoring, and topic clustering all explained.",
          og_title: "Master SEO Keyword Research — Complete 2026 Tutorial",
          og_description:
            "Discover how to find high-value SEO keywords in 2026. Intent classification, GEO scoring, and topic clustering all explained.",
          twitter_title: "Master SEO Keyword Research Tutorial",
          twitter_description:
            "Discover how to find high-value SEO keywords in 2026. Intent classification, GEO scoring, and topic clustering all explained.",
        },
        {
          title: "The Essential SEO Keyword Research Playbook (2026)",
          description:
            "Get the essential SEO keyword research framework. Covers seed expansion, intent analysis, GEO signals, and topic clustering.",
          og_title: "The Essential SEO Keyword Research Playbook (2026)",
          og_description:
            "Get the essential SEO keyword research framework. Covers seed expansion, intent analysis, GEO signals, and topic clustering.",
          twitter_title: "Essential SEO Keyword Research Playbook",
          twitter_description:
            "Get the essential SEO keyword research framework. Covers seed expansion, intent analysis, GEO signals, and topic clustering.",
        },
      ]),
    );

    const result = JSON.parse(
      await seoMetaGenerateTool.execute({
        content: "A blog post about SEO keyword research best practices",
        target_keyword: "SEO keyword research",
        content_type: "article",
      }),
    );

    expect(result.error).toBeUndefined();
    expect(result.variants).toHaveLength(3);
    for (const variant of result.variants) {
      expect(variant.title.length).toBeLessThanOrEqual(60);
      expect(variant.description.length).toBeLessThanOrEqual(155);
      expect(variant.description.length).toBeGreaterThanOrEqual(120);
    }
    expect(typeof result.best_variant_idx).toBe("number");
  });

  it("flags warnings when LLM exceeds limits", async () => {
    mockInfer.mockResolvedValueOnce(
      llmResponse([
        {
          title: "A".repeat(80), // too long
          description: "Short desc", // too short
          og_title: "A".repeat(80),
          og_description: "Short desc",
          twitter_title: "A".repeat(80),
          twitter_description: "Short desc",
        },
      ]),
    );

    const result = JSON.parse(
      await seoMetaGenerateTool.execute({
        content: "Test content",
        target_keyword: "test",
      }),
    );

    expect(result.variants).toHaveLength(1);
    expect(result.variants[0].warnings.length).toBeGreaterThan(0);
  });

  it("fetches content from a URL before generating", async () => {
    mockWebReadExecute.mockResolvedValueOnce(
      JSON.stringify({
        content: "# Page Title\n\nSome fetched content about widgets.",
        url: "https://example.com/page",
      }),
    );
    mockInfer.mockResolvedValueOnce(
      llmResponse([
        {
          title: "Premium Widgets for Pro Users | Acme Store 2026",
          description:
            "Shop Acme's premium widgets collection. Built for pro users, free shipping on orders over $50. 30-day return guarantee included.",
          og_title: "Premium Widgets for Pro Users | Acme",
          og_description:
            "Shop Acme's premium widgets collection. Built for pro users, free shipping on orders over $50. 30-day return guarantee included.",
          twitter_title: "Premium Widgets for Pro Users",
          twitter_description:
            "Shop Acme's premium widgets collection. Built for pro users, free shipping on orders over $50. 30-day return guarantee included.",
        },
      ]),
    );

    const result = JSON.parse(
      await seoMetaGenerateTool.execute({
        content: "https://example.com/page",
        target_keyword: "premium widgets",
        content_type: "product",
      }),
    );

    expect(mockWebReadExecute).toHaveBeenCalledWith({
      url: "https://example.com/page",
    });
    expect(result.source_url).toBe("https://example.com/page");
    expect(result.variants).toHaveLength(1);
  });

  it("prefers variants where title contains the target keyword", async () => {
    mockInfer.mockResolvedValueOnce(
      llmResponse([
        {
          title: "Something totally unrelated here for content readers",
          description:
            "A useful description that fits the character range perfectly for all of our SERP rendering tests and checks today.",
          og_title: "Something totally unrelated here for content readers",
          og_description:
            "A useful description that fits the character range perfectly for all of our SERP rendering tests and checks today.",
          twitter_title: "Something totally unrelated",
          twitter_description:
            "A useful description that fits the character range perfectly for all of our SERP rendering tests and checks today.",
        },
        {
          title: "Keyword Research Made Simple — A Quick Guide 2026",
          description:
            "Keyword research explained simply. Get the practical framework our team uses for intent, volume, and topic clustering analysis.",
          og_title: "Keyword Research Made Simple — A Quick Guide 2026",
          og_description:
            "Keyword research explained simply. Get the practical framework our team uses for intent, volume, and topic clustering analysis.",
          twitter_title: "Keyword Research Made Simple Guide",
          twitter_description:
            "Keyword research explained simply. Get the practical framework our team uses for intent, volume, and topic clustering analysis.",
        },
      ]),
    );

    const result = JSON.parse(
      await seoMetaGenerateTool.execute({
        content: "Keyword research tutorial",
        target_keyword: "keyword research",
      }),
    );

    // Best variant should contain the target keyword in title
    expect(
      result.variants[result.best_variant_idx].title.toLowerCase(),
    ).toContain("keyword research");
  });

  it("handles non-JSON LLM response gracefully", async () => {
    mockInfer.mockResolvedValueOnce({
      content: "I cannot generate that right now.",
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    });

    const result = JSON.parse(
      await seoMetaGenerateTool.execute({
        content: "Test content",
        target_keyword: "test",
      }),
    );

    expect(result.error).toBeDefined();
  });
});
