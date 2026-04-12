/**
 * Tests for seo_content_brief — E-E-A-T + LLM content brief generator.
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

import { seoContentBriefTool } from "./seo-content-brief.js";

afterEach(() => {
  vi.restoreAllMocks();
  mockInfer.mockReset();
  mockWebReadExecute.mockReset();
});

function mockLlmBrief(data: Record<string, unknown>) {
  return {
    content: JSON.stringify(data),
    usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 },
  };
}

describe("seo_content_brief", () => {
  it("errors on missing topic", async () => {
    const result = JSON.parse(
      await seoContentBriefTool.execute({ intent: "informational" }),
    );
    expect(result.error).toMatch(/topic is required/);
  });

  it("errors on missing intent", async () => {
    const result = JSON.parse(
      await seoContentBriefTool.execute({ topic: "test" }),
    );
    expect(result.error).toMatch(/intent is required/);
  });

  it("returns structured brief with all expected fields", async () => {
    mockInfer.mockResolvedValueOnce(
      mockLlmBrief({
        title_options: [
          "How to Choose an EHR — A Clinic's 2026 Guide",
          "EHR Selection for Small Clinics (2026)",
          "Your Clinic's EHR Buying Guide 2026",
          "Choosing the Right EHR: Clinic Perspective",
          "EHR for Clinics: Complete 2026 Guide",
        ],
        outline: [
          {
            heading: "H2: What Is an EHR?",
            subheadings: ["H3: Core components", "H3: EMR vs EHR"],
          },
          {
            heading: "H2: Key selection criteria",
            subheadings: ["H3: Compliance", "H3: Integrations"],
          },
        ],
        keywords_to_include: [
          "EHR",
          "electronic health records",
          "clinic software",
          "HIPAA",
          "interoperability",
        ],
        key_questions: [
          "How long does EHR implementation take?",
          "What does an EHR cost?",
        ],
      }),
    );

    const result = JSON.parse(
      await seoContentBriefTool.execute({
        topic: "choosing an EHR for small clinics",
        target_keywords: ["EHR selection", "clinic software"],
        intent: "commercial",
        format: "how_to",
        audience: "clinic administrators",
      }),
    );

    expect(result.error).toBeUndefined();
    expect(result.brief).toBeDefined();
    expect(result.brief.title_options.length).toBeGreaterThan(0);
    expect(result.brief.outline.length).toBeGreaterThan(0);
    expect(result.brief.word_count_target.min).toBeGreaterThan(0);
    expect(result.brief.word_count_target.max).toBeGreaterThan(
      result.brief.word_count_target.min,
    );
  });

  it("includes E-E-A-T signals tailored to format + intent", async () => {
    mockInfer.mockResolvedValueOnce(
      mockLlmBrief({
        title_options: ["A title"],
        outline: [{ heading: "H2: Section", subheadings: [] }],
        keywords_to_include: ["kw"],
        key_questions: [],
      }),
    );

    const result = JSON.parse(
      await seoContentBriefTool.execute({
        topic: "product review",
        intent: "commercial",
        format: "review",
      }),
    );

    expect(result.brief.eeat_signals.length).toBeGreaterThan(0);
    // Reviews should surface experience signals
    expect(
      result.brief.eeat_signals.some(
        (s: { category: string }) => s.category === "experience",
      ),
    ).toBe(true);
  });

  it("includes GEO tactics (more for strong GEO formats)", async () => {
    mockInfer.mockResolvedValueOnce(
      mockLlmBrief({
        title_options: [],
        outline: [],
        keywords_to_include: [],
        key_questions: [],
      }),
    );

    const result = JSON.parse(
      await seoContentBriefTool.execute({
        topic: "how to write unit tests",
        intent: "informational",
        format: "how_to",
      }),
    );

    // how_to is a strong GEO format — should receive ≥ 8 tactics
    expect(result.brief.geo_tactics.length).toBeGreaterThanOrEqual(8);
  });

  it("fetches existing URL when provided for refresh brief", async () => {
    mockWebReadExecute.mockResolvedValueOnce(
      JSON.stringify({
        content: "# Existing Post\nSome old content about SEO.",
        url: "https://example.com/old-post",
      }),
    );
    mockInfer.mockResolvedValueOnce(
      mockLlmBrief({
        title_options: ["Refreshed Title"],
        outline: [],
        keywords_to_include: [],
        key_questions: [],
      }),
    );

    const result = JSON.parse(
      await seoContentBriefTool.execute({
        topic: "SEO updates",
        intent: "informational",
        existing_url: "https://example.com/old-post",
      }),
    );

    expect(mockWebReadExecute).toHaveBeenCalledWith({
      url: "https://example.com/old-post",
    });
    expect(result.refresh_of).toBe("https://example.com/old-post");
  });
});
