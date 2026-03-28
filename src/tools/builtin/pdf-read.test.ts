import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the PDF extraction lib
const mockExtractFromUrl = vi.fn();
const mockExtractToMarkdown = vi.fn();
vi.mock("../../lib/pdf.js", () => ({
  extractPdfFromUrl: (...args: unknown[]) => mockExtractFromUrl(...args),
  extractPdfToMarkdown: (...args: unknown[]) => mockExtractToMarkdown(...args),
}));

// Mock fs for existsSync and writeFile
vi.mock("fs", () => ({
  existsSync: vi.fn(() => true),
}));

vi.mock("fs/promises", () => ({
  writeFile: vi.fn(async () => {}),
}));

const { pdfReadTool } = await import("./pdf-read.js");

import { afterEach } from "vitest";

beforeEach(() => {
  mockExtractFromUrl.mockReset();
  mockExtractToMarkdown.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pdf_read tool", () => {
  it("returns error when source is missing", async () => {
    const result = JSON.parse(await pdfReadTool.execute({}));
    expect(result.error).toBe("source is required");
  });

  it("returns inline content for short PDFs from URL", async () => {
    mockExtractFromUrl.mockResolvedValueOnce(
      "# Short PDF\n\nSome content here.",
    );

    const result = JSON.parse(
      await pdfReadTool.execute({ source: "https://example.com/doc.pdf" }),
    );

    expect(result.content).toContain("# Short PDF");
    expect(result.chars).toBeLessThanOrEqual(10_000);
    expect(result.truncated).toBe(false);
    expect(result.file).toBeUndefined();
  });

  it("returns inline content for short PDFs from local path", async () => {
    mockExtractToMarkdown.mockResolvedValueOnce("# Local PDF");

    const result = JSON.parse(
      await pdfReadTool.execute({ source: "/tmp/test.pdf" }),
    );

    expect(result.content).toBe("# Local PDF");
    expect(mockExtractToMarkdown).toHaveBeenCalledOnce();
  });

  it("saves long PDFs to file and returns preview", async () => {
    const longContent = "# Introduction\n\n" + "paragraph text. ".repeat(1000);
    mockExtractFromUrl.mockResolvedValueOnce(longContent);

    const result = JSON.parse(
      await pdfReadTool.execute({ source: "https://example.com/big.pdf" }),
    );

    expect(result.file).toBeDefined();
    expect(result.file).toMatch(/^\/tmp\/pdf-/);
    expect(result.chars).toBeGreaterThan(10_000);
    expect(result.content.length).toBeLessThanOrEqual(2_100); // preview ~2K
    expect(result.note).toContain("file_read");
  });

  it("searches content when query is provided", async () => {
    const content = [
      "# Chapter 1\n\nThe economy grew by 5% in 2024.",
      "# Chapter 2\n\nPopulation trends show urban migration.",
      "# Chapter 3\n\nThe economy contracted in early 2025 due to trade policy.",
      "# Chapter 4\n\nTechnology sector saw record investment.",
    ].join("\n\n");
    // Total is well under 10K but we need > INLINE_THRESHOLD for query to matter
    const longContent = content + "\n\n" + "filler paragraph. ".repeat(800);
    mockExtractFromUrl.mockResolvedValueOnce(longContent);

    const result = JSON.parse(
      await pdfReadTool.execute({
        source: "https://example.com/report.pdf",
        query: "economy",
      }),
    );

    expect(result.matches).toBeGreaterThan(0);
    expect(result.content).toContain("economy");
    expect(result.file).toBeDefined();
  });

  it("returns preview when query has no matches", async () => {
    const longContent = "generic content. ".repeat(1000);
    mockExtractFromUrl.mockResolvedValueOnce(longContent);

    const result = JSON.parse(
      await pdfReadTool.execute({
        source: "https://example.com/doc.pdf",
        query: "quantum entanglement",
      }),
    );

    expect(result.matches).toBe(0);
    expect(result.content).toBeDefined(); // preview fallback
    expect(result.note).toContain("No matches");
  });

  it("passes pages parameter through to extractor", async () => {
    mockExtractFromUrl.mockResolvedValueOnce("Page 3 content");

    await pdfReadTool.execute({
      source: "https://example.com/doc.pdf",
      pages: "3",
    });

    expect(mockExtractFromUrl).toHaveBeenCalledWith(
      "https://example.com/doc.pdf",
      expect.objectContaining({ pages: "3" }),
    );
  });

  it("handles extraction errors gracefully", async () => {
    mockExtractFromUrl.mockRejectedValueOnce(
      new Error("'java' command not found"),
    );

    const result = JSON.parse(
      await pdfReadTool.execute({ source: "https://example.com/doc.pdf" }),
    );

    expect(result.error).toContain("java");
  });

  it("checks file existence for local paths", async () => {
    const { existsSync } = await import("fs");
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);

    const result = JSON.parse(
      await pdfReadTool.execute({ source: "/tmp/nonexistent.pdf" }),
    );

    expect(result.error).toContain("File not found");
  });

  it("has correct tool definition", () => {
    expect(pdfReadTool.name).toBe("pdf_read");
    const fn = pdfReadTool.definition.function;
    expect(fn.parameters.required).toContain("source");
    expect(fn.parameters.properties).toHaveProperty("source");
    expect(fn.parameters.properties).toHaveProperty("pages");
    expect(fn.parameters.properties).toHaveProperty("query");
  });
});
