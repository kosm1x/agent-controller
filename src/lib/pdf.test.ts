import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @opendataloader/pdf before importing the module under test
const mockConvert = vi.fn();
vi.mock("@opendataloader/pdf", () => ({
  convert: mockConvert,
}));

// Mock fs/promises partially — keep real mkdtemp/rm, mock readdir/readFile for control
const { extractPdfToMarkdown, extractPdfFromUrl } = await import("./pdf.js");

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  mockConvert.mockReset();
  mockFetch.mockReset();
});

describe("extractPdfToMarkdown", () => {
  it("calls convert with correct args and returns content", async () => {
    mockConvert.mockImplementation(
      async (_paths: string[], opts: { outputDir: string }) => {
        // Simulate writing a .md file to the output dir
        const { writeFile } = await import("fs/promises");
        const { join } = await import("path");
        await writeFile(
          join(opts.outputDir, "download.md"),
          "# Hello\n\nExtracted content from PDF.",
        );
      },
    );

    const result = await extractPdfToMarkdown("/tmp/test.pdf");

    expect(mockConvert).toHaveBeenCalledOnce();
    const [paths, opts] = mockConvert.mock.calls[0];
    expect(paths).toEqual(["/tmp/test.pdf"]);
    expect(opts.format).toBe("markdown");
    expect(opts.imageOutput).toBe("off");
    expect(opts.quiet).toBe(true);
    expect(result).toContain("# Hello");
    expect(result).toContain("Extracted content from PDF.");
  });

  it("passes pages option when provided", async () => {
    mockConvert.mockImplementation(
      async (_paths: string[], opts: { outputDir: string }) => {
        const { writeFile } = await import("fs/promises");
        const { join } = await import("path");
        await writeFile(join(opts.outputDir, "test.md"), "Page 3 content");
      },
    );

    await extractPdfToMarkdown("/tmp/test.pdf", { pages: "3" });

    const [, opts] = mockConvert.mock.calls[0];
    expect(opts.pages).toBe("3");
  });

  it("truncates content exceeding maxChars", async () => {
    const longContent = "x".repeat(1000);
    mockConvert.mockImplementation(
      async (_paths: string[], opts: { outputDir: string }) => {
        const { writeFile } = await import("fs/promises");
        const { join } = await import("path");
        await writeFile(join(opts.outputDir, "doc.md"), longContent);
      },
    );

    const result = await extractPdfToMarkdown("/tmp/big.pdf", {
      maxChars: 100,
    });

    expect(result.length).toBeLessThan(longContent.length);
    expect(result).toContain("...(truncated, 1000 total chars)");
  });

  it("throws when convert produces no .md file", async () => {
    mockConvert.mockResolvedValue(undefined);

    await expect(extractPdfToMarkdown("/tmp/empty.pdf")).rejects.toThrow(
      "no Markdown output",
    );
  });

  it("propagates convert errors", async () => {
    mockConvert.mockRejectedValue(new Error("'java' command not found"));

    await expect(extractPdfToMarkdown("/tmp/test.pdf")).rejects.toThrow("java");
  });
});

describe("extractPdfFromUrl", () => {
  it("downloads PDF and extracts content", async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF header
    mockFetch.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => pdfBytes.buffer,
    });

    mockConvert.mockImplementation(
      async (_paths: string[], opts: { outputDir: string }) => {
        const { writeFile } = await import("fs/promises");
        const { join } = await import("path");
        await writeFile(join(opts.outputDir, "download.md"), "# PDF Content");
      },
    );

    const result = await extractPdfFromUrl("https://example.com/doc.pdf");

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(result).toContain("# PDF Content");
  });

  it("throws on HTTP error", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: "Not Found",
    });

    await expect(
      extractPdfFromUrl("https://example.com/missing.pdf"),
    ).rejects.toThrow("404");
  });

  it("throws on fetch error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network timeout"));

    await expect(
      extractPdfFromUrl("https://example.com/slow.pdf"),
    ).rejects.toThrow("network timeout");
  });
});
