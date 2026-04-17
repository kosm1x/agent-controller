/**
 * v7.13 structured PDF ingest tests.
 * Operate on the pure transform (`structureMarkdown`) with inline markdown
 * fixtures so tests stay hermetic — no actual PDF parsing in unit tests.
 */

import { describe, it, expect } from "vitest";
import {
  structureMarkdown,
  sectionizeAndExtract,
  chunkText,
  looksLikeTableStart,
  slugify,
} from "./pdf-structured-ingest.js";

// ---------------------------------------------------------------------------
// sectionizeAndExtract
// ---------------------------------------------------------------------------

describe("sectionizeAndExtract", () => {
  it("tracks 1-4 heading depths with section_path", () => {
    const md = [
      "# Top",
      "intro text",
      "## Sub",
      "sub text",
      "### Deep",
      "deep text",
      "#### Deeper",
      "deeper text",
    ].join("\n");
    const blocks = sectionizeAndExtract(md);
    expect(blocks).toHaveLength(4);
    expect(blocks[0].sectionPath).toEqual(["Top"]);
    expect(blocks[1].sectionPath).toEqual(["Top", "Sub"]);
    expect(blocks[2].sectionPath).toEqual(["Top", "Sub", "Deep"]);
    expect(blocks[3].sectionPath).toEqual(["Top", "Sub", "Deep", "Deeper"]);
  });

  it("pops stack correctly on heading level decrease", () => {
    const md = [
      "# A",
      "text A",
      "## A-1",
      "text A1",
      "## A-2",
      "text A2",
      "# B",
      "text B",
    ].join("\n");
    const blocks = sectionizeAndExtract(md);
    expect(blocks.map((b) => b.sectionPath)).toEqual([
      ["A"],
      ["A", "A-1"],
      ["A", "A-2"],
      ["B"],
    ]);
  });

  it("emits chunks with correct modality", () => {
    const md = [
      "# Intro",
      "some text",
      "",
      "| col1 | col2 |",
      "| ---- | ---- |",
      "| a    | b    |",
      "| c    | d    |",
      "",
      "more text after",
    ].join("\n");
    const blocks = sectionizeAndExtract(md);
    const kinds = blocks.map((b) => b.kind);
    expect(kinds).toContain("table");
    expect(kinds).toContain("text");
  });

  it("tolerates malformed heading skips (h1 → h4) without crashing", () => {
    const md = ["# Top", "text", "#### Skip", "skipped text"].join("\n");
    expect(() => sectionizeAndExtract(md)).not.toThrow();
  });

  it("empty markdown returns no blocks", () => {
    expect(sectionizeAndExtract("")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Table detection
// ---------------------------------------------------------------------------

describe("looksLikeTableStart", () => {
  it("matches pipe-format with separator row", () => {
    const lines = ["| col | col |", "| --- | --- |", "| a   | b   |"];
    expect(looksLikeTableStart(lines, 0)).toBe(true);
  });

  it("rejects single pipe row without separator", () => {
    const lines = ["| just | one |", "text below"];
    expect(looksLikeTableStart(lines, 0)).toBe(false);
  });

  it("rejects inline-pipe prose (no separator row)", () => {
    const lines = [
      "This sentence | has a pipe | inside.",
      "But it | is not | a table.",
      "And neither | is this | one.",
    ];
    expect(looksLikeTableStart(lines, 0)).toBe(false);
  });

  it("requires at least 3 rows", () => {
    const lines = ["| a | b |", "| - | - |"];
    expect(looksLikeTableStart(lines, 0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// chunkText
// ---------------------------------------------------------------------------

describe("chunkText", () => {
  it("returns single chunk when under limit", () => {
    expect(chunkText("short text", 1500)).toEqual(["short text"]);
  });

  it("splits at paragraph boundaries", () => {
    const p1 = "A".repeat(800);
    const p2 = "B".repeat(800);
    const md = `${p1}\n\n${p2}`;
    const out = chunkText(md, 1000);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatch(/^A+$/);
    expect(out[1]).toMatch(/^B+$/);
  });

  it("sentence-splits a paragraph longer than limit", () => {
    const para =
      "First sentence is reasonably long and just below the halfway mark. Second sentence takes us past the limit easily. Third sentence is here too for more content. Fourth sentence closes it out.";
    // limit=80 forces a split; every sentence ~50-70 chars.
    const out = chunkText(para, 80);
    expect(out.length).toBeGreaterThan(1);
    for (const piece of out) expect(piece.length).toBeLessThanOrEqual(200);
  });
});

// ---------------------------------------------------------------------------
// slugify
// ---------------------------------------------------------------------------

describe("slugify", () => {
  it("lowercases and collapses non-alphanumerics", () => {
    expect(slugify("Hello World 2026!")).toBe("hello-world-2026");
  });
  it("returns 'doc' for empty input", () => {
    expect(slugify("")).toBe("doc");
  });
  it("caps length at 60 chars", () => {
    expect(slugify("x".repeat(200)).length).toBeLessThanOrEqual(60);
  });
});

// ---------------------------------------------------------------------------
// structureMarkdown — end-to-end pure transform
// ---------------------------------------------------------------------------

describe("structureMarkdown", () => {
  const sampleMd = [
    "# Annual Report 2026",
    "Introductory paragraph about the year.",
    "",
    "## Financial Highlights",
    "Revenue grew 12%.",
    "",
    "| Metric     | 2025 | 2026 |",
    "| ---------- | ---- | ---- |",
    "| Revenue    | 100  | 112  |",
    "| Net Income | 15   | 20   |",
    "",
    "### Notes",
    "All figures in millions.",
    "",
    "## Outlook",
    "Positive outlook for next year.",
  ].join("\n");

  it("builds chunks with parentDocId, section_path, chunk_position", () => {
    const out = structureMarkdown(sampleMd, "/tmp/report.pdf");
    expect(out.parentDocId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(out.docTitle).toBe("report");
    expect(out.chunks.length).toBeGreaterThan(0);
    // Every chunk has parent_doc_id propagated
    for (const c of out.chunks) {
      expect(c.parent_doc_id).toBe(out.parentDocId);
      expect(c.section_path).toBeDefined();
      expect(typeof c.chunk_position).toBe("number");
    }
    // Positions are sequential
    for (let i = 0; i < out.chunks.length; i++) {
      expect(out.chunks[i].chunk_position).toBe(i);
    }
  });

  it("tags the table chunk with modality='table'", () => {
    const out = structureMarkdown(sampleMd, "/tmp/report.pdf");
    const tables = out.chunks.filter((c) => c.modality === "table");
    expect(tables.length).toBe(1);
    expect(tables[0].content).toContain("Revenue");
    expect(tables[0].section_path).toEqual([
      "Annual Report 2026",
      "Financial Highlights",
    ]);
  });

  it("counts by modality match chunk totals", () => {
    const out = structureMarkdown(sampleMd, "/tmp/report.pdf");
    expect(out.counts.text + out.counts.table).toBe(out.chunks.length);
    expect(out.counts.sections).toBeGreaterThan(0);
  });

  it("uses override parentDocId when provided", () => {
    const fixed = "11111111-2222-3333-4444-555555555555";
    const out = structureMarkdown(sampleMd, "/tmp/report.pdf", {
      parentDocId: fixed,
    });
    expect(out.parentDocId).toBe(fixed);
    for (const c of out.chunks) expect(c.parent_doc_id).toBe(fixed);
  });

  it("applies tags to every chunk", () => {
    const out = structureMarkdown(sampleMd, "/tmp/report.pdf", {
      tags: ["custom-tag"],
    });
    for (const c of out.chunks) {
      expect(c.tags).toContain("custom-tag");
      expect(c.tags).toContain("pdf");
    }
  });

  it("honors max_chunks cap and flags truncated", () => {
    // Build a very chunky input: 20 sections with 2k+ chars each
    const bigSections: string[] = [];
    for (let i = 0; i < 20; i++) {
      bigSections.push(`## Section ${i}`);
      bigSections.push("A".repeat(2000));
      bigSections.push("");
    }
    const md = bigSections.join("\n");
    const out = structureMarkdown(md, "/tmp/big.pdf", { maxChunks: 5 });
    expect(out.chunks.length).toBeLessThanOrEqual(5);
    expect(out.counts.truncated).toBe(true);
  });

  it("namespace appears in chunk paths", () => {
    const out = structureMarkdown(sampleMd, "/tmp/report.pdf", {
      namespace: "finance",
    });
    for (const c of out.chunks) {
      expect(c.path.startsWith("finance/")).toBe(true);
    }
  });

  it("chunk paths are unique", () => {
    const out = structureMarkdown(sampleMd, "/tmp/report.pdf");
    const paths = out.chunks.map((c) => c.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("largestTable is populated when a table exists", () => {
    const out = structureMarkdown(sampleMd, "/tmp/report.pdf");
    expect(out.largestTable).toBeDefined();
    expect(out.largestTable!.chars).toBeGreaterThan(0);
  });

  it("empty markdown produces empty result (no crash)", () => {
    const out = structureMarkdown("", "/tmp/empty.pdf");
    expect(out.chunks).toHaveLength(0);
    expect(out.counts.text).toBe(0);
    expect(out.counts.table).toBe(0);
  });
});
