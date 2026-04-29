/**
 * Unit tests for the file-slicing helpers used by file_read /
 * jarvis_file_read (Session 114, Tier B large-file fix).
 */

import { describe, it, expect } from "vitest";
import {
  parseLineRanges,
  extractLineRanges,
  buildOutline,
  countLines,
} from "./file-slicing.js";

describe("parseLineRanges", () => {
  it("parses single 'N-M' range", () => {
    expect(parseLineRanges("1-200")).toEqual([{ start: 1, end: 200 }]);
  });

  it("parses single line 'N' as a single-element range", () => {
    expect(parseLineRanges("42")).toEqual([{ start: 42, end: 42 }]);
  });

  it("parses comma-separated multi-range with whitespace tolerance", () => {
    expect(parseLineRanges("1-50, 200-250")).toEqual([
      { start: 1, end: 50 },
      { start: 200, end: 250 },
    ]);
  });

  it("rejects empty string", () => {
    expect(() => parseLineRanges("")).toThrow(/non-empty/);
  });

  it("rejects non-numeric input", () => {
    expect(() => parseLineRanges("garbage")).toThrow(/'N-M' or 'N'/);
  });

  it("rejects zero / negative line numbers", () => {
    expect(() => parseLineRanges("0-10")).toThrow(/>= 1/);
  });

  it("rejects end < start", () => {
    expect(() => parseLineRanges("100-50")).toThrow(/end < start/);
  });
});

describe("extractLineRanges", () => {
  const sample = "L1\nL2\nL3\nL4\nL5";

  it("returns the requested slice", () => {
    const r = extractLineRanges(sample, [{ start: 2, end: 4 }]);
    expect(r.slice).toBe("L2\nL3\nL4");
    expect(r.totalLines).toBe(5);
    expect(r.sliceLines).toBe(3);
    expect(r.clamped).toBe(false);
  });

  it("dedupes overlapping ranges", () => {
    const r = extractLineRanges(sample, [
      { start: 1, end: 3 },
      { start: 2, end: 4 },
    ]);
    expect(r.slice).toBe("L1\nL2\nL3\nL4");
    expect(r.sliceLines).toBe(4);
  });

  it("clamps out-of-range end to total line count", () => {
    const r = extractLineRanges(sample, [{ start: 1, end: 999 }]);
    expect(r.slice).toBe("L1\nL2\nL3\nL4\nL5");
    expect(r.clamped).toBe(true);
  });

  it("returns empty string when start > totalLines", () => {
    const r = extractLineRanges(sample, [{ start: 100, end: 200 }]);
    expect(r.slice).toBe("");
    expect(r.sliceLines).toBe(0);
  });

  it("caps at MAX_LINES_PER_REQUEST and signals via lineCapped (qa W7)", () => {
    const big = Array.from({ length: 3000 }, (_, i) => `L${i + 1}`).join("\n");
    const r = extractLineRanges(big, [{ start: 1, end: 3000 }]);
    expect(r.sliceLines).toBe(2000);
    expect(r.lineCapped).toBe(true);
    expect(r.clamped).toBe(false); // 3000 didn't exceed totalLines (also 3000)
  });

  it("distinguishes lineCapped from clamped (qa W7)", () => {
    const r = extractLineRanges(sample, [{ start: 1, end: 99999 }]);
    expect(r.clamped).toBe(true);
    expect(r.lineCapped).toBe(false);
  });

  it("normalizes CRLF in extracted slices (qa W4)", () => {
    const crlf = "L1\r\nL2\r\nL3\r\n";
    const r = extractLineRanges(crlf, [{ start: 1, end: 2 }]);
    // \r should not survive in the slice
    expect(r.slice).toBe("L1\nL2");
    expect(r.slice).not.toMatch(/\r/);
  });
});

describe("buildOutline", () => {
  it("collects markdown headings with 1-indexed line numbers", () => {
    const md = [
      "# Title",
      "",
      "intro",
      "",
      "## Section A",
      "body a",
      "",
      "### Subsection",
      "",
      "## Section B",
    ].join("\n");
    expect(buildOutline(md)).toEqual([
      "L1: # Title",
      "L5: ## Section A",
      "L8: ### Subsection",
      "L10: ## Section B",
    ]);
  });

  it("ignores non-heading hash patterns", () => {
    const md = "# Real heading\n#nope (no space)\n##also-no-space";
    expect(buildOutline(md)).toEqual(["L1: # Real heading"]);
  });

  it("caps at 30 headings", () => {
    const md = Array.from({ length: 50 }, (_, i) => `# H${i}`).join("\n");
    expect(buildOutline(md).length).toBe(30);
  });

  it("returns empty array when no headings", () => {
    expect(buildOutline("just plain text\nno headings")).toEqual([]);
  });

  it("ignores heading-shaped lines inside fenced code blocks (qa W1)", () => {
    const md = [
      "# Real heading",
      "",
      "```bash",
      "# this is a shell comment, not a heading",
      "## also not a heading",
      "```",
      "",
      "## Real subheading",
      "",
      "~~~",
      "### inside tilde fence — not a heading",
      "~~~",
    ].join("\n");
    const out = buildOutline(md);
    expect(out).toEqual(["L1: # Real heading", "L8: ## Real subheading"]);
  });

  it("strips trailing CR from heading text (qa W4)", () => {
    const crlf = "# Title\r\n## Section A\r\n";
    const out = buildOutline(crlf);
    expect(out).toEqual(["L1: # Title", "L2: ## Section A"]);
    expect(out.every((h) => !h.includes("\r"))).toBe(true);
  });
});

describe("countLines", () => {
  it("counts lines (trailing newline does not double-count)", () => {
    expect(countLines("a\nb\nc")).toBe(3);
    expect(countLines("a\nb\nc\n")).toBe(4); // empty trailing line
  });

  it("treats empty string as 1 line", () => {
    expect(countLines("")).toBe(1);
  });
});
