/**
 * Tests for seo_page_audit — page fetch + parse + rubric scoring + persistence.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { initDatabase, closeDatabase, getDatabase } from "../../db/index.js";

const mockWebReadExecute = vi.fn();
vi.mock("./web-read.js", () => ({
  webReadTool: {
    execute: (...args: unknown[]) => mockWebReadExecute(...args),
  },
}));

import { seoPageAuditTool } from "./seo-page-audit.js";

function mockJinaMarkdown(opts: {
  title?: string;
  description?: string;
  h1?: string[];
  h2?: string[];
  images?: Array<{ alt: string }>;
  body?: string;
  jsonLd?: string;
}): string {
  const lines: string[] = [];
  if (opts.title) lines.push(`Title: ${opts.title}`);
  if (opts.description) lines.push(`Description: ${opts.description}`);
  lines.push("Markdown Content:");
  for (const h of opts.h1 ?? []) lines.push(`# ${h}`);
  for (const h of opts.h2 ?? []) lines.push(`## ${h}`);
  if (opts.body) lines.push(opts.body);
  for (const img of opts.images ?? [])
    lines.push(`![${img.alt}](https://example.com/img.jpg)`);
  if (opts.jsonLd)
    lines.push(`<script type="application/ld+json">${opts.jsonLd}</script>`);
  return lines.join("\n");
}

beforeEach(() => {
  initDatabase(":memory:");
  mockWebReadExecute.mockReset();
});

afterEach(() => {
  closeDatabase();
  vi.restoreAllMocks();
});

describe("seo_page_audit", () => {
  it("errors on missing URL", async () => {
    const result = JSON.parse(await seoPageAuditTool.execute({}));
    expect(result.error).toMatch(/url is required/);
  });

  it("errors on invalid URL", async () => {
    const result = JSON.parse(
      await seoPageAuditTool.execute({ url: "not-a-url" }),
    );
    expect(result.error).toBeDefined();
  });

  it("parses Jina markdown and scores a good page high", async () => {
    const goodMarkdown = mockJinaMarkdown({
      title: "SEO Best Practices 2026 — A Complete Guide",
      description:
        "Learn SEO best practices for 2026 with our comprehensive guide covering technical SEO, content strategy, and link building tactics.",
      h1: ["SEO Best Practices 2026"],
      h2: ["Technical SEO", "Content Strategy", "Link Building"],
      body: "A ".repeat(400), // ~400 words
      images: [
        { alt: "SEO diagram" },
        { alt: "Ranking chart" },
        { alt: "Audit screenshot" },
      ],
      jsonLd: '{"@context":"https://schema.org","@type":"Article"}',
    });

    mockWebReadExecute.mockResolvedValueOnce(
      JSON.stringify({
        content: goodMarkdown,
        url: "https://example.com/seo-guide",
      }),
    );

    const result = JSON.parse(
      await seoPageAuditTool.execute({
        url: "https://example.com/seo-guide",
      }),
    );

    expect(result.error).toBeUndefined();
    expect(result.score).toBeGreaterThanOrEqual(80);
    expect(result.findings.priorities).toHaveLength(0);
    expect(result.parsed_summary.word_count).toBeGreaterThan(300);
    expect(result.parsed_summary.h1_count).toBe(1);
  });

  it("scores a page with missing elements low and flags priorities", async () => {
    const badMarkdown = mockJinaMarkdown({
      title: "Bad", // too short
      body: "Short content.",
    });

    mockWebReadExecute.mockResolvedValueOnce(
      JSON.stringify({
        content: badMarkdown,
        url: "https://example.com/bad",
      }),
    );

    const result = JSON.parse(
      await seoPageAuditTool.execute({ url: "https://example.com/bad" }),
    );

    expect(result.score).toBeLessThan(60);
    expect(result.findings.priorities.length).toBeGreaterThan(0);
    // Missing meta description should appear in critical issues
    expect(
      result.findings.issues.some((i: { message: string }) =>
        i.message.toLowerCase().includes("meta description"),
      ),
    ).toBe(true);
  });

  it("persists the audit to seo_audits table", async () => {
    mockWebReadExecute.mockResolvedValueOnce(
      JSON.stringify({
        content: mockJinaMarkdown({
          title: "Persisted Audit Title That Is Just Right",
          description:
            "A valid meta description for the persisted audit test covering enough characters to pass the SERP-safe range check easily.",
          h1: ["Heading"],
          body: "word ".repeat(400),
        }),
        url: "https://persist.example.com/",
      }),
    );

    const result = JSON.parse(
      await seoPageAuditTool.execute({
        url: "https://persist.example.com/",
      }),
    );

    expect(result.audit_id).toBeGreaterThan(0);

    const db = getDatabase();
    const row = db
      .prepare("SELECT * FROM seo_audits WHERE id = ?")
      .get(result.audit_id) as {
      domain: string;
      audit_type: string;
      score: number;
    };
    expect(row).toBeDefined();
    expect(row.domain).toBe("persist.example.com");
    expect(row.audit_type).toBe("page");
    expect(row.score).toBe(result.score);
  });

  it("checks target_keyword presence in title and H1", async () => {
    mockWebReadExecute.mockResolvedValueOnce(
      JSON.stringify({
        content: mockJinaMarkdown({
          title: "A page about cats and dogs for animal lovers",
          description:
            "A meta description about cats and dogs that gives readers enough context to click through and keep reading the full article.",
          h1: ["Pets, cats and dogs"],
          body: "word ".repeat(350),
        }),
        url: "https://example.com/pets",
      }),
    );

    const result = JSON.parse(
      await seoPageAuditTool.execute({
        url: "https://example.com/pets",
        target_keyword: "hamster",
      }),
    );

    // target_keyword "hamster" is nowhere → critical issue
    expect(
      result.findings.issues.some((i: { message: string }) =>
        i.message.toLowerCase().includes("hamster"),
      ),
    ).toBe(true);
  });

  it("surfaces content_quality section with Princeton signals", async () => {
    const richMarkdown = mockJinaMarkdown({
      title: "How LLMs Index Content — Princeton 2024 Study Results",
      description:
        "Princeton researchers found specific citation and statistic density signals predict AI overview inclusion rates strongly.",
      h1: ["How LLMs Index Content"],
      h2: ["Findings", "Methods"],
      body:
        "The Princeton KDD 2024 study [1] found citation density lifts AI-overview inclusion 30%. " +
        'Another key signal: "We observed a 40% increase in attribution when pages contain hard statistics" (Smith, 2024). ' +
        "Content with a 15% citation rate outperformed median pages. Our analysis [2] of 100000 queries confirmed this. " +
        'Quote: "Structured evidence beats sparse prose." Readability grade 11 correlates strongly. ' +
        "References: https://arxiv.org/abs/2409.09978 and https://example.org/gsc-data.",
      images: [{ alt: "study fig 1" }],
      jsonLd: '{"@context":"https://schema.org"}',
    });
    mockWebReadExecute.mockResolvedValueOnce(
      JSON.stringify({
        content: richMarkdown,
        url: "https://example.com/princeton-study",
      }),
    );
    const result = JSON.parse(
      await seoPageAuditTool.execute({
        url: "https://example.com/princeton-study",
      }),
    );
    expect(result.content_quality).toBeDefined();
    expect(result.content_quality.cite_density_per_1k).toBeGreaterThan(0);
    expect(result.content_quality.stat_density_per_1k).toBeGreaterThan(0);
    expect(result.content_quality.quote_presence).toBe(true);
    expect(result.content_quality.readability_grade).toBeGreaterThan(0);
    expect(result.content_quality.score).toBeGreaterThan(0);
    expect(Array.isArray(result.content_quality.notes)).toBe(true);
  });

  it("returns error when fetch fails", async () => {
    mockWebReadExecute.mockResolvedValueOnce(
      JSON.stringify({ error: "Failed to fetch", url: "https://example.com" }),
    );

    const result = JSON.parse(
      await seoPageAuditTool.execute({ url: "https://example.com" }),
    );
    expect(result.error).toMatch(/Could not read page/);
  });
});
