import { describe, it, expect, vi, beforeEach , afterEach } from "vitest";

// Mock @opendataloader/pdf before importing the module under test
const mockConvert = vi.fn();
vi.mock("@opendataloader/pdf", () => ({
  convert: mockConvert,
}));

// pdf.ts calls promisify(execFile); the real execFile's promisify.custom
// resolves { stdout, stderr }, so the mock hangs a controllable fn there.
const { mockPdftotext } = vi.hoisted(() => ({ mockPdftotext: vi.fn() }));
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  return {
    execFile: Object.assign(vi.fn(), { [promisify.custom]: mockPdftotext }),
  };
});

// Mock fs/promises partially — keep real mkdtemp/rm, mock readdir/readFile for control
const { extractPdfToMarkdown, extractPdfFromUrl } = await import("./pdf.js");

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  mockConvert.mockReset();
  mockFetch.mockReset();
});

describe("extractPdfToMarkdown", () => {
  afterEach(() => { vi.restoreAllMocks(); });
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

  describe("tiny-text fallback (Type 3 fonts)", () => {
    // Writes the first pass's output, then the second pass's (if any).
    function convertWrites(...outputs: string[]) {
      for (const text of outputs) {
        mockConvert.mockImplementationOnce(
          async (_paths: string[], opts: { outputDir: string }) => {
            const { writeFile } = await import("fs/promises");
            const { join } = await import("path");
            await writeFile(join(opts.outputDir, "doc.md"), text);
          },
        );
      }
    }

    // Default: pdftotext is not installed, so the ODL "tiny" pass is used.
    beforeEach(() => {
      mockPdftotext.mockReset();
      mockPdftotext.mockRejectedValue(
        Object.assign(new Error("spawn pdftotext ENOENT"), { code: "ENOENT" }),
      );
    });

    async function dirsRemoved() {
      const { existsSync } = await import("fs");
      for (const call of mockConvert.mock.calls) {
        expect(existsSync(call[1].outputDir)).toBe(false);
      }
    }

    describe("pdftotext before the tiny pass", () => {
      const pdftotextReturns = (...outputs: string[]) => {
        for (const stdout of outputs) {
          mockPdftotext.mockResolvedValueOnce({ stdout, stderr: "" });
        }
      };

      it("ODL empty + pdftotext text → pdftotext text, one ODL call, argv array, no shell", async () => {
        convertWrites("", "tiny text must not be used");
        pdftotextReturns("Clean text\f");

        const result = await extractPdfToMarkdown("/tmp/deck.pdf");

        expect(result).toBe("Clean text\f");
        expect(mockConvert).toHaveBeenCalledOnce();
        expect(mockPdftotext).toHaveBeenCalledOnce();
        const [file, args, execOpts] = mockPdftotext.mock.calls[0];
        expect(file).toBe("pdftotext");
        expect(args).toEqual([
          "-q",
          "-enc",
          "UTF-8",
          "--",
          "/tmp/deck.pdf",
          "-",
        ]);
        expect(execOpts.shell).toBeUndefined();
        expect(execOpts.timeout).toBe(30_000);
        expect(execOpts.maxBuffer).toBe(64 * 1024 * 1024);
        await dirsRemoved();
      });

      it("ODL non-empty → pdftotext never called", async () => {
        convertWrites("Real text");

        await extractPdfToMarkdown("/tmp/text.pdf");

        expect(mockPdftotext).not.toHaveBeenCalled();
      });

      it("pdftotext ENOENT → tiny pass used", async () => {
        convertWrites("", "Tiny text");

        const result = await extractPdfToMarkdown("/tmp/deck.pdf");

        expect(mockPdftotext).toHaveBeenCalledOnce();
        expect(mockConvert.mock.calls[1][1].contentSafetyOff).toBe("tiny");
        expect(result).toBe("Tiny text");
      });

      it("pdftotext returns whitespace → tiny pass used", async () => {
        convertWrites("", "Tiny text");
        pdftotextReturns(" \n\f\n");

        const result = await extractPdfToMarkdown("/tmp/deck.pdf");

        expect(mockConvert).toHaveBeenCalledTimes(2);
        expect(result).toBe("Tiny text");
        await dirsRemoved();
      });

      it("pdftotext times out and the tiny pass rejects → resolves empty", async () => {
        convertWrites("");
        mockConvert.mockRejectedValueOnce(new Error("java crashed"));
        mockPdftotext.mockRejectedValueOnce(
          Object.assign(new Error("timed out"), {
            killed: true,
            signal: "SIGTERM",
          }),
        );

        const result = await extractPdfToMarkdown("/tmp/deck.pdf");

        expect(result).toBe("");
        expect(mockConvert).toHaveBeenCalledTimes(2);
        await dirsRemoved();
      });

      it("pages '1,3,5-7' → one pdftotext call per range, output in order", async () => {
        convertWrites("");
        pdftotextReturns("one\f", "three\f", "five-seven\f");

        const result = await extractPdfToMarkdown("/tmp/deck.pdf", {
          pages: "1,3,5-7",
        });

        expect(result).toBe("one\fthree\ffive-seven\f");
        const argv = (f: string, l: string) => [
          "-q",
          "-enc",
          "UTF-8",
          "-f",
          f,
          "-l",
          l,
          "--",
          "/tmp/deck.pdf",
          "-",
        ];
        expect(mockPdftotext.mock.calls.map((c) => c[1])).toEqual([
          argv("1", "1"),
          argv("3", "3"),
          argv("5", "7"),
        ]);
        expect(mockConvert).toHaveBeenCalledOnce();
      });

      it("invalid pages → pdftotext not called, tiny pass gets the pages", async () => {
        convertWrites("", "Tiny text");
        pdftotextReturns("must not be used");

        const result = await extractPdfToMarkdown("/tmp/deck.pdf", {
          pages: "1;rm",
        });

        expect(mockPdftotext).not.toHaveBeenCalled();
        expect(mockConvert.mock.calls[1][1].contentSafetyOff).toBe("tiny");
        expect(mockConvert.mock.calls[1][1].pages).toBe("1;rm");
        expect(result).toBe("Tiny text");
      });

      it.each(["5-", "1-2-3"])(
        "invalid pages %s → pdftotext not called",
        async (pages) => {
          convertWrites("", "Tiny text");

          const result = await extractPdfToMarkdown("/tmp/deck.pdf", { pages });

          expect(mockPdftotext).not.toHaveBeenCalled();
          expect(result).toBe("Tiny text");
        },
      );

      it("pages '1, 3' → parts trimmed, two calls 1/1 and 3/3", async () => {
        convertWrites("");
        pdftotextReturns("one", "three");

        const result = await extractPdfToMarkdown("/tmp/deck.pdf", {
          pages: "1, 3",
        });

        expect(result).toBe("onethree");
        expect(mockPdftotext.mock.calls.map((c) => c[1].slice(3, 7))).toEqual([
          ["-f", "1", "-l", "1"],
          ["-f", "3", "-l", "3"],
        ]);
      });

      it("20 page parts → 20 pdftotext calls", async () => {
        convertWrites("");
        mockPdftotext.mockResolvedValue({ stdout: "p", stderr: "" });
        const pages = Array.from({ length: 20 }, (_, i) => i + 1).join(",");

        const result = await extractPdfToMarkdown("/tmp/deck.pdf", { pages });

        expect(mockPdftotext).toHaveBeenCalledTimes(20);
        expect(result).toBe("p".repeat(20));
      });

      it("21 page parts → pdftotext not called, tiny pass used", async () => {
        convertWrites("", "Tiny text");
        mockPdftotext.mockResolvedValue({ stdout: "p", stderr: "" });
        const pages = Array.from({ length: 21 }, (_, i) => i + 1).join(",");

        const result = await extractPdfToMarkdown("/tmp/deck.pdf", { pages });

        expect(mockPdftotext).not.toHaveBeenCalled();
        expect(mockConvert.mock.calls[1][1].contentSafetyOff).toBe("tiny");
        expect(result).toBe("Tiny text");
      });

      it("applies maxChars truncation to pdftotext output", async () => {
        convertWrites("");
        pdftotextReturns("z".repeat(300));

        const result = await extractPdfToMarkdown("/tmp/deck.pdf", {
          maxChars: 40,
        });

        expect(result).toBe(
          "z".repeat(40) + "\n\n...(truncated, 300 total chars)",
        );
      });
    });

    it("empty first pass → retries with contentSafetyOff 'tiny' and returns that text", async () => {
      convertWrites("  \n\n ", "# Slide 1\n\nRecovered text.");

      const result = await extractPdfToMarkdown("/tmp/deck.pdf");

      expect(mockConvert).toHaveBeenCalledTimes(2);
      expect(mockConvert.mock.calls[0][1].contentSafetyOff).toBeUndefined();
      const second = mockConvert.mock.calls[1][1];
      expect(second.contentSafetyOff).toBe("tiny");
      expect(second.format).toBe("markdown");
      expect(second.imageOutput).toBe("off");
      expect(second.quiet).toBe(true);
      expect(mockConvert.mock.calls[1][0]).toEqual(["/tmp/deck.pdf"]);
      expect(result).toBe("# Slide 1\n\nRecovered text.");
    });

    it("non-empty first pass → exactly one call, no contentSafetyOff", async () => {
      convertWrites("Real text", "should not be used");

      const result = await extractPdfToMarkdown("/tmp/text.pdf");

      expect(mockConvert).toHaveBeenCalledOnce();
      expect(mockConvert.mock.calls[0][1].contentSafetyOff).toBeUndefined();
      expect(result).toBe("Real text");
    });

    it("both passes empty → returns empty string, two calls, temp dirs removed", async () => {
      convertWrites("", "  ");

      const result = await extractPdfToMarkdown("/tmp/scan.pdf");

      expect(result.trim()).toBe("");
      expect(mockConvert).toHaveBeenCalledTimes(2);
      const { existsSync } = await import("fs");
      for (const call of mockConvert.mock.calls) {
        expect(existsSync(call[1].outputDir)).toBe(false);
      }
    });

    it("pass 2 throws → keeps pass 1's empty result, both dirs removed", async () => {
      convertWrites("");
      mockConvert.mockRejectedValueOnce(new Error("java crashed"));

      const result = await extractPdfToMarkdown("/tmp/deck.pdf");

      expect(result).toBe("");
      expect(mockConvert).toHaveBeenCalledTimes(2);
      const { existsSync } = await import("fs");
      for (const call of mockConvert.mock.calls) {
        expect(existsSync(call[1].outputDir)).toBe(false);
      }
    });

    it("pass 1 throws → rejects, its dir removed, no second pass", async () => {
      mockConvert.mockRejectedValueOnce(new Error("java crashed"));

      await expect(extractPdfToMarkdown("/tmp/deck.pdf")).rejects.toThrow(
        "java crashed",
      );

      expect(mockConvert).toHaveBeenCalledOnce();
      const { existsSync } = await import("fs");
      expect(existsSync(mockConvert.mock.calls[0][1].outputDir)).toBe(false);
    });

    it("forwards the pages option to both passes", async () => {
      convertWrites("", "Page 2 text");

      await extractPdfToMarkdown("/tmp/deck.pdf", { pages: "2-4" });

      expect(mockConvert.mock.calls[0][1].pages).toBe("2-4");
      expect(mockConvert.mock.calls[1][1].pages).toBe("2-4");
    });

    it("applies maxChars truncation to the fallback result", async () => {
      convertWrites("", "y".repeat(500));

      const result = await extractPdfToMarkdown("/tmp/deck.pdf", {
        maxChars: 50,
      });

      expect(result).toBe(
        "y".repeat(50) + "\n\n...(truncated, 500 total chars)",
      );
    });
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
