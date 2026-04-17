/**
 * kb_ingest_pdf_structured + kb_batch_insert tool tests.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — set up before the tool imports
// ---------------------------------------------------------------------------

const mockIngestPdf = vi.fn();
vi.mock("../../kb/pdf-structured-ingest.js", () => ({
  ingestPdf: (...args: unknown[]) => mockIngestPdf(...args),
}));

const mockEmbed = vi.fn();
vi.mock("../../memory/embeddings.js", () => ({
  embed: (text: string) => mockEmbed(text),
}));

const mockIsPgvectorEnabled = vi.fn();
const mockPgBatchUpsert = vi.fn();
vi.mock("../../db/pgvector.js", async () => {
  const actual = await vi.importActual<typeof import("../../db/pgvector.js")>(
    "../../db/pgvector.js",
  );
  return {
    ...actual,
    isPgvectorEnabled: () => mockIsPgvectorEnabled(),
    pgBatchUpsert: (...args: unknown[]) => mockPgBatchUpsert(...args),
  };
});

import { kbIngestPdfStructuredTool, kbBatchInsertTool } from "./kb-ingest.js";

// ---------------------------------------------------------------------------
// kb_ingest_pdf_structured
// ---------------------------------------------------------------------------

describe("kbIngestPdfStructuredTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsPgvectorEnabled.mockReturnValue(true);
    mockEmbed.mockResolvedValue(new Float32Array(1536).fill(0.1));
    mockPgBatchUpsert.mockResolvedValue({
      success: 2,
      failed: 0,
      rejected: 0,
    });
  });

  it("returns error when pdf_path missing", async () => {
    const out = await kbIngestPdfStructuredTool.execute({});
    expect(JSON.parse(out as string).error).toMatch(/pdf_path/);
  });

  it("returns graceful message when pgvector disabled", async () => {
    mockIsPgvectorEnabled.mockReturnValue(false);
    const out = (await kbIngestPdfStructuredTool.execute({
      pdf_path: "/tmp/test.pdf",
    })) as string;
    expect(out).toMatch(/pgvector is not configured/);
  });

  it("handles extractor errors gracefully", async () => {
    mockIngestPdf.mockRejectedValue(new Error("file not found"));
    const out = (await kbIngestPdfStructuredTool.execute({
      pdf_path: "/tmp/missing.pdf",
    })) as string;
    expect(out).toMatch(/failed to parse/);
    expect(out).toMatch(/file not found/);
  });

  it("happy path: embeds + persists + summary includes breakdown", async () => {
    mockIngestPdf.mockResolvedValue({
      parentDocId: "11111111-2222-3333-4444-555555555555",
      docTitle: "test-doc",
      chunks: [
        {
          path: "pdf-ingest/test-doc/intro/0000",
          title: "test-doc — Intro",
          content: "first paragraph",
          modality: "text",
          parent_doc_id: "11111111-2222-3333-4444-555555555555",
          section_path: ["Intro"],
          chunk_position: 0,
          tags: ["pdf", "text"],
        },
        {
          path: "pdf-ingest/test-doc/intro/0001",
          title: "test-doc — Intro (table)",
          content: "| a | b |\n| - | - |\n| 1 | 2 |",
          modality: "table",
          parent_doc_id: "11111111-2222-3333-4444-555555555555",
          section_path: ["Intro"],
          chunk_position: 1,
          tags: ["pdf", "table"],
        },
      ],
      counts: { text: 1, table: 1, sections: 1, truncated: false },
      largestTable: { chars: 30, sectionPath: ["Intro"] },
    });
    const out = (await kbIngestPdfStructuredTool.execute({
      pdf_path: "/tmp/test.pdf",
    })) as string;
    expect(mockEmbed).toHaveBeenCalledTimes(2);
    expect(mockPgBatchUpsert).toHaveBeenCalled();
    expect(out).toContain("11111111-2222-3333-4444-555555555555");
    expect(out).toContain("Chunks: 2");
    expect(out).toContain("text 1");
    expect(out).toContain("table 1");
    expect(out).toContain("Inserted: 2");
    expect(out).toContain("Largest table: 30 chars at Intro");
  });

  it("passes namespace + tags + parent_doc_id through to ingester", async () => {
    const fixedUuid = "11111111-2222-3333-4444-555555555555";
    mockIngestPdf.mockResolvedValue({
      parentDocId: fixedUuid,
      docTitle: "t",
      chunks: [],
      counts: { text: 0, table: 0, sections: 0, truncated: false },
    });
    await kbIngestPdfStructuredTool.execute({
      pdf_path: "/tmp/t.pdf",
      namespace: "finance",
      parent_doc_id: fixedUuid,
      tags: ["10k", "aapl"],
      max_chunks: 50,
    });
    const call = mockIngestPdf.mock.calls[0];
    expect(call[0]).toBe("/tmp/t.pdf");
    expect(call[1]).toEqual({
      namespace: "finance",
      parentDocId: fixedUuid,
      tags: ["10k", "aapl"],
      maxChunks: 50,
    });
  });

  it("rejects non-UUID parent_doc_id (audit W3)", async () => {
    const out = (await kbIngestPdfStructuredTool.execute({
      pdf_path: "/tmp/t.pdf",
      parent_doc_id: "not-a-uuid",
    })) as string;
    expect(out).toMatch(/parent_doc_id must be a UUID/);
    expect(mockIngestPdf).not.toHaveBeenCalled();
  });

  it("reports embedding failures in summary", async () => {
    mockEmbed.mockResolvedValue(null); // simulate embed unavailable
    mockIngestPdf.mockResolvedValue({
      parentDocId: "p",
      docTitle: "t",
      chunks: [
        {
          path: "p/t/s/0000",
          title: "t",
          content: "x",
          modality: "text",
          parent_doc_id: "p",
          section_path: ["s"],
          chunk_position: 0,
        },
      ],
      counts: { text: 1, table: 0, sections: 1, truncated: false },
    });
    const out = (await kbIngestPdfStructuredTool.execute({
      pdf_path: "/tmp/t.pdf",
    })) as string;
    expect(out).toMatch(/Embedding failures: 1/);
  });

  it("surfaces truncated flag in summary", async () => {
    mockIngestPdf.mockResolvedValue({
      parentDocId: "p",
      docTitle: "t",
      chunks: [],
      counts: { text: 500, table: 0, sections: 50, truncated: true },
    });
    const out = (await kbIngestPdfStructuredTool.execute({
      pdf_path: "/tmp/big.pdf",
    })) as string;
    expect(out).toMatch(/TRUNCATED/);
  });
});

// ---------------------------------------------------------------------------
// kb_batch_insert
// ---------------------------------------------------------------------------

describe("kbBatchInsertTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsPgvectorEnabled.mockReturnValue(true);
    mockEmbed.mockResolvedValue(new Float32Array(1536).fill(0.1));
    mockPgBatchUpsert.mockResolvedValue({
      success: 1,
      failed: 0,
      rejected: 0,
    });
  });

  it("empty entries → explicit message", async () => {
    const out = (await kbBatchInsertTool.execute({ entries: [] })) as string;
    expect(out).toMatch(/no entries provided/);
  });

  it("pgvector disabled → graceful", async () => {
    mockIsPgvectorEnabled.mockReturnValue(false);
    const out = (await kbBatchInsertTool.execute({
      entries: [{ path: "p", title: "t", content: "c" }],
    })) as string;
    expect(out).toMatch(/not configured/);
  });

  it("embeds each entry then calls pgBatchUpsert", async () => {
    await kbBatchInsertTool.execute({
      entries: [
        { path: "a", title: "A", content: "alpha" },
        { path: "b", title: "B", content: "beta" },
      ],
    });
    expect(mockEmbed).toHaveBeenCalledTimes(2);
    expect(mockPgBatchUpsert).toHaveBeenCalled();
  });

  it("skips embedding when entry already has one", async () => {
    await kbBatchInsertTool.execute({
      entries: [
        {
          path: "a",
          title: "A",
          content: "alpha",
          embedding: Array.from(new Float32Array(1536).fill(0.5)),
        },
      ],
    });
    expect(mockEmbed).not.toHaveBeenCalled();
  });

  it("reports rejection counts from pgBatchUpsert", async () => {
    mockPgBatchUpsert.mockResolvedValue({
      success: 3,
      failed: 0,
      rejected: 2,
    });
    const out = (await kbBatchInsertTool.execute({
      entries: [
        { path: "a", title: "A", content: "c1" },
        { path: "b", title: "B", content: "c2" },
        { path: "c", title: "C", content: "c3" },
        { path: "d", title: "D", content: "c4" },
        { path: "e", title: "E", content: "c5" },
      ],
    })) as string;
    expect(out).toMatch(/Inserted: 3/);
    expect(out).toMatch(/Rejected \(validation\): 2/);
  });

  it("passes modality + parent_doc_id through to pgBatchUpsert", async () => {
    await kbBatchInsertTool.execute({
      entries: [
        {
          path: "x",
          title: "X",
          content: "c",
          modality: "table",
          parent_doc_id: "doc-1",
        },
      ],
    });
    const call = mockPgBatchUpsert.mock.calls[0];
    expect(call[0][0].modality).toBe("table");
    expect(call[0][0].parent_doc_id).toBe("doc-1");
  });
});
