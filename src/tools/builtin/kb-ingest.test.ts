/**
 * kb_ingest_pdf_structured + kb_batch_insert tool tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
const mockPgUpsertLineageSource = vi.fn();
vi.mock("../../db/pgvector.js", async () => {
  const actual = await vi.importActual<typeof import("../../db/pgvector.js")>(
    "../../db/pgvector.js",
  );
  return {
    ...actual,
    isPgvectorEnabled: () => mockIsPgvectorEnabled(),
    pgBatchUpsert: (...args: unknown[]) => mockPgBatchUpsert(...args),
    pgUpsertLineageSource: (...args: unknown[]) =>
      mockPgUpsertLineageSource(...args),
  };
});

const MANIFEST = {
  path: "pdf-ingest/test-doc.manifest.md",
  title: "test-doc (manifest)",
  content: "docSlug: test-doc\nchunks: 2\nsha256: abc",
  type: "ingested",
  qualifier: "pdf",
  tags: ["pdf", "manifest"],
};

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
    mockPgUpsertLineageSource.mockResolvedValue("written");
  });

  it("returns error when pdf_path missing", async () => {
    const out = await kbIngestPdfStructuredTool.execute({});
    expect(JSON.parse(out as string).error).toMatch(/pdf_path/);
  });

  it("pgvector disabled → {error} naming the setting the check reads", async () => {
    mockIsPgvectorEnabled.mockReturnValue(false);
    const out = (await kbIngestPdfStructuredTool.execute({
      pdf_path: "/tmp/test.pdf",
    })) as string;
    expect(out.startsWith('{"error":')).toBe(true);
    expect(JSON.parse(out)).toEqual({
      error:
        "pgvector is not configured — cannot persist. Set COMMIT_DB_KEY to enable.",
    });
    expect(Object.keys(JSON.parse(out))).toEqual(["error"]);
    expect(mockIngestPdf).not.toHaveBeenCalled();
  });

  // A cap below 1 is refused before the document is read: nothing is parsed,
  // embedded or written, so an earlier ingest of the document is left as it is.
  // The sentence prints the argument exactly as the handler received it.
  it.each<[unknown, string]>([
    [0, "max_chunks must be 1 or more (got 0). Omit it to use the default."],
    [-1, "max_chunks must be 1 or more (got -1). Omit it to use the default."],
    [0.5, "max_chunks must be 1 or more (got 0.5). Omit it to use the default."],
    [null, "max_chunks must be 1 or more (got null). Omit it to use the default."],
    ["", 'max_chunks must be 1 or more (got ""). Omit it to use the default.'],
    [false, "max_chunks must be 1 or more (got false). Omit it to use the default."],
  ])("max_chunks %j given to the handler → {error} before the document is read", async (cap, error) => {
    // A readable document, so a missed refusal fails an assertion below
    // instead of crashing on an empty ingest result.
    mockIngestPdf.mockResolvedValue({
      parentDocId: "p",
      docTitle: "t",
      manifest: MANIFEST,
      chunks: [],
      counts: { text: 0, table: 0, sections: 0, truncated: false },
    });
    const out = (await kbIngestPdfStructuredTool.execute({
      pdf_path: "/tmp/t.pdf",
      max_chunks: cap,
    })) as string;
    expect(out.startsWith('{"error":')).toBe(true);
    expect(Object.keys(JSON.parse(out))).toEqual(["error"]);
    expect(JSON.parse(out).error).toBe(error);
    expect(mockIngestPdf).not.toHaveBeenCalled();
    expect(mockEmbed).not.toHaveBeenCalled();
    expect(mockPgUpsertLineageSource).not.toHaveBeenCalled();
    expect(mockPgBatchUpsert).not.toHaveBeenCalled();
  });

  it("max_chunks 1 is passed through; a missing one leaves the ingester's default", async () => {
    mockIngestPdf.mockResolvedValue({
      parentDocId: "p",
      docTitle: "t",
      manifest: MANIFEST,
      chunks: [],
      counts: { text: 0, table: 0, sections: 0, truncated: false },
    });
    await kbIngestPdfStructuredTool.execute({
      pdf_path: "/tmp/t.pdf",
      max_chunks: 1,
    });
    await kbIngestPdfStructuredTool.execute({ pdf_path: "/tmp/t.pdf" });
    expect(mockIngestPdf).toHaveBeenCalledTimes(2);
    expect(mockIngestPdf.mock.calls[0][1].maxChunks).toBe(1);
    expect(mockIngestPdf.mock.calls[1][1].maxChunks).toBeUndefined();
  });

  it("extractor error → {error} naming the parse failure", async () => {
    mockIngestPdf.mockRejectedValue(new Error("file not found"));
    const out = (await kbIngestPdfStructuredTool.execute({
      pdf_path: "/tmp/missing.pdf",
    })) as string;
    expect(JSON.parse(out).error).toBe(
      "failed to parse /tmp/missing.pdf — file not found",
    );
  });

  it("happy path: embeds + persists + summary includes breakdown", async () => {
    mockIngestPdf.mockResolvedValue({
      parentDocId: "11111111-2222-3333-4444-555555555555",
      docTitle: "test-doc",
      manifest: MANIFEST,
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
      manifest: MANIFEST,
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

  it("rejects non-UUID parent_doc_id with {error}", async () => {
    const out = (await kbIngestPdfStructuredTool.execute({
      pdf_path: "/tmp/t.pdf",
      parent_doc_id: "not-a-uuid",
    })) as string;
    expect(JSON.parse(out).error).toBe(
      "parent_doc_id must be a UUID (got 'not-a-uuid'). Omit it to auto-generate.",
    );
    expect(mockIngestPdf).not.toHaveBeenCalled();
  });

  it("reports embedding failures in summary", async () => {
    mockEmbed.mockResolvedValue(null); // simulate embed unavailable
    mockIngestPdf.mockResolvedValue({
      parentDocId: "p",
      docTitle: "t",
      manifest: MANIFEST,
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

  it("a truncated run is a failure whose summary keeps the TRUNCATED line", async () => {
    mockIngestPdf.mockResolvedValue({
      parentDocId: "p",
      docTitle: "t",
      manifest: MANIFEST,
      chunks: [],
      counts: { text: 500, table: 0, sections: 50, truncated: true },
    });
    const out = (await kbIngestPdfStructuredTool.execute({
      pdf_path: "/tmp/big.pdf",
    })) as string;
    const parsed = JSON.parse(out);
    expect(parsed.error).toContain("cut off at the chunk cap");
    expect(parsed.summary).toMatch(/TRUNCATED/);
  });

  // 4o lineage: the manifest goes first through pgUpsertLineageSource.
  it("upserts the manifest as a lineage source before the chunks", async () => {
    mockIngestPdf.mockResolvedValue({
      parentDocId: "p",
      docTitle: "t",
      manifest: MANIFEST,
      chunks: [],
      counts: { text: 0, table: 0, sections: 0, truncated: false },
    });
    const out = (await kbIngestPdfStructuredTool.execute({
      pdf_path: "/tmp/t.pdf",
    })) as string;
    expect(mockPgUpsertLineageSource).toHaveBeenCalledWith(MANIFEST);
    expect(mockPgUpsertLineageSource.mock.invocationCallOrder[0]).toBeLessThan(
      mockPgBatchUpsert.mock.invocationCallOrder[0],
    );
    expect(out).toContain("Manifest: pdf-ingest/test-doc.manifest.md");
  });

  it("a failed manifest upsert is a failure whose summary flags it", async () => {
    mockPgUpsertLineageSource.mockResolvedValue("failed");
    mockIngestPdf.mockResolvedValue({
      parentDocId: "p",
      docTitle: "t",
      manifest: MANIFEST,
      chunks: [],
      counts: { text: 0, table: 0, sections: 0, truncated: false },
    });
    const out = (await kbIngestPdfStructuredTool.execute({
      pdf_path: "/tmp/t.pdf",
    })) as string;
    expect(JSON.parse(out).summary).toMatch(/upsert FAILED/);
  });

  // An approved ingest that was only partly carried out is a failure:
  // `{error: <one line with the counts>, summary: <the full plain summary>}`.
  // Everything else is a success in the plain summary text.
  describe("failure rule", () => {
    const DOC_ID = "11111111-2222-3333-4444-555555555555";
    type Batch = { success: number; failed: number; rejected: number };

    function seed(
      chunks: number,
      batch: Batch,
      manifest = "written",
      truncated = false,
    ) {
      mockIngestPdf.mockResolvedValue({
        parentDocId: DOC_ID,
        docTitle: "t",
        manifest: MANIFEST,
        chunks: Array.from({ length: chunks }, (_, i) => ({
          path: `pdf-ingest/test-doc/s/000${i}`,
          title: "t",
          content: `chunk ${i}`,
          modality: "text",
          parent_doc_id: DOC_ID,
          section_path: ["s"],
          chunk_position: i,
        })),
        counts: { text: chunks, table: 0, sections: 1, truncated },
      });
      mockPgBatchUpsert.mockResolvedValue(batch);
      mockPgUpsertLineageSource.mockResolvedValue(manifest);
    }

    /** The plain summary, byte for byte, for a document seeded by `seed`. */
    function plain(
      chunks: number,
      b: Batch,
      note: string,
      extra: string[] = [],
    ): string {
      return [
        "kb_ingest_pdf_structured: /tmp/t.pdf",
        `  parent_doc_id: ${DOC_ID}`,
        "  Doc title: t",
        `  Manifest: ${MANIFEST.path} (${note})`,
        `  Chunks: ${chunks} (text ${chunks}, table 0)`,
        "  Sections: 1",
        `  Inserted: ${b.success} | Rejected (noise): ${b.rejected} | Failed: ${b.failed}`,
        ...extra,
      ].join("\n");
    }

    const run = async () =>
      (await kbIngestPdfStructuredTool.execute({
        pdf_path: "/tmp/t.pdf",
      })) as string;

    const STALE = "changed: previous chunks marked stale";
    const TRUNCATED_LINE =
      "  TRUNCATED: exceeded max_chunks — some content not ingested";
    const CUT = "; cut off at the chunk cap, the rest of the document was not stored";
    const HINT =
      "  Hint: if this is the first v7.13 ingest, confirm the schema migration was applied (modality / parent_doc_id / section_path / chunk_position columns on kb_entries).";

    it.each([
      [
        "a chunk failed to be written",
        2,
        { success: 1, failed: 1, rejected: 0 },
        "written",
        "ingest incomplete: 1 of 2 chunks written, 1 failed, 0 rejected as noise",
        plain(2, { success: 1, failed: 1, rejected: 0 }, STALE),
      ],
      [
        "every chunk failed to be written",
        2,
        { success: 0, failed: 2, rejected: 0 },
        "written",
        "ingest incomplete: 0 of 2 chunks written, 2 failed, 0 rejected as noise",
        plain(2, { success: 0, failed: 2, rejected: 0 }, STALE, [HINT]),
      ],
      [
        "the manifest upsert failed",
        2,
        { success: 2, failed: 0, rejected: 0 },
        "failed",
        "ingest incomplete: 2 of 2 chunks written, 0 failed, 0 rejected as noise; manifest upsert FAILED: previous chunks not marked stale",
        plain(
          2,
          { success: 2, failed: 0, rejected: 0 },
          "upsert FAILED: previous chunks not marked stale",
        ),
      ],
      [
        "the manifest cascade failed",
        2,
        { success: 2, failed: 0, rejected: 0 },
        "cascade_failed",
        "ingest incomplete: 2 of 2 chunks written, 0 failed, 0 rejected as noise; manifest cascade FAILED, manifest not advanced: next ingest retries",
        plain(
          2,
          { success: 2, failed: 0, rejected: 0 },
          "cascade FAILED, manifest not advanced: next ingest retries",
        ),
      ],
      [
        "chunks were produced and none was written",
        2,
        { success: 0, failed: 0, rejected: 2 },
        "written",
        "ingest incomplete: 0 of 2 chunks written, 0 failed, 2 rejected as noise",
        plain(2, { success: 0, failed: 0, rejected: 2 }, STALE),
      ],
      [
        "a document that produced no chunks after a changed manifest",
        0,
        { success: 0, failed: 0, rejected: 0 },
        "written",
        "ingest incomplete: 0 of 0 chunks written, 0 failed, 0 rejected as noise",
        plain(0, { success: 0, failed: 0, rejected: 0 }, STALE),
      ],
      [
        "a document that produced no chunks with an unchanged manifest",
        0,
        { success: 0, failed: 0, rejected: 0 },
        "unchanged",
        "ingest incomplete: 0 of 0 chunks written, 0 failed, 0 rejected as noise",
        plain(0, { success: 0, failed: 0, rejected: 0 }, "unchanged"),
      ],
    ] as const)(
      "%s → {error, summary}",
      async (_case, chunks, batch, manifest, error, summary) => {
        seed(chunks, batch, manifest);
        const out = await run();
        expect(JSON.parse(out)).toEqual({ error, summary });
      },
    );

    it.each([
      [
        "all rows written beside rejected noise rows",
        3,
        { success: 2, failed: 0, rejected: 1 },
        "written",
        false,
        plain(3, { success: 2, failed: 0, rejected: 1 }, STALE),
      ],
      [
        "an unchanged manifest with every row written",
        2,
        { success: 2, failed: 0, rejected: 0 },
        "unchanged",
        false,
        plain(2, { success: 2, failed: 0, rejected: 0 }, "unchanged"),
      ],
      [
        "a document not cut off with every row written",
        3,
        { success: 3, failed: 0, rejected: 0 },
        "written",
        false,
        plain(3, { success: 3, failed: 0, rejected: 0 }, STALE),
      ],
    ] as const)(
      "%s → the plain summary",
      async (_case, chunks, batch, manifest, truncated, text) => {
        seed(chunks, batch, manifest, truncated);
        expect(await run()).toBe(text);
      },
    );

    // Cut off at the chunk cap: the part past the cap was never stored, so the
    // run failed even when every chunk up to the cap was written. Chunk counts
    // differ from the not-truncated failures above, so the clause is tied to
    // the flag, not to a count.
    it.each([
      [
        "cut off with every chunk up to the cap written",
        3,
        { success: 3, failed: 0, rejected: 0 },
        "written",
        `ingest incomplete: 3 of 3 chunks written, 0 failed, 0 rejected as noise${CUT}`,
        plain(3, { success: 3, failed: 0, rejected: 0 }, STALE, [
          TRUNCATED_LINE,
        ]),
      ],
      [
        "cut off and one chunk failed",
        4,
        { success: 3, failed: 1, rejected: 0 },
        "written",
        `ingest incomplete: 3 of 4 chunks written, 1 failed, 0 rejected as noise${CUT}`,
        plain(4, { success: 3, failed: 1, rejected: 0 }, STALE, [
          TRUNCATED_LINE,
        ]),
      ],
      [
        "cut off and the manifest cascade failed",
        3,
        { success: 3, failed: 0, rejected: 0 },
        "cascade_failed",
        `ingest incomplete: 3 of 3 chunks written, 0 failed, 0 rejected as noise${CUT}; manifest cascade FAILED, manifest not advanced: next ingest retries`,
        plain(
          3,
          { success: 3, failed: 0, rejected: 0 },
          "cascade FAILED, manifest not advanced: next ingest retries",
          [TRUNCATED_LINE],
        ),
      ],
    ] as const)(
      "%s → {error, summary}",
      async (_case, chunks, batch, manifest, error, summary) => {
        seed(chunks, batch, manifest, true);
        expect(JSON.parse(await run())).toEqual({ error, summary });
      },
    );

    it("embedding failures with every row written → the plain summary", async () => {
      seed(2, { success: 2, failed: 0, rejected: 0 });
      mockEmbed.mockResolvedValue(null);
      expect(await run()).toBe(
        plain(2, { success: 2, failed: 0, rejected: 0 }, STALE, [
          "  Embedding failures: 2 (chunks inserted with FTS-only retrieval)",
        ]),
      );
    });

    it("a failure result read by JSON.parse alone has a non-empty one-line error first", async () => {
      seed(3, { success: 1, failed: 1, rejected: 1 }, "cascade_failed", true);
      const out = await run();
      expect(out.startsWith('{"error":')).toBe(true);
      const { error } = JSON.parse(out) as { error: unknown };
      expect(typeof error).toBe("string");
      expect((error as string).length).toBeGreaterThan(0);
      expect(error).not.toMatch(/[\r\n]/);
      expect(error).not.toContain("/tmp/t.pdf");
    });
  });

  describe("fetch order with the real pgUpsertLineageSource + pgBatchUpsert", () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const origKey = process.env.COMMIT_DB_KEY;
    const chunk = {
      path: "pdf-ingest/test-doc/intro/0000",
      title: "test-doc — Intro",
      content: "a chunk long enough to pass the quality gate",
      type: "ingested",
      qualifier: "pdf",
      related_to: [MANIFEST.path],
    };

    beforeEach(async () => {
      calls.length = 0;
      process.env.COMMIT_DB_KEY = "test-key";
      const actual = await vi.importActual<
        typeof import("../../db/pgvector.js")
      >("../../db/pgvector.js");
      mockPgUpsertLineageSource.mockImplementation(
        actual.pgUpsertLineageSource as (...a: unknown[]) => unknown,
      );
      mockPgBatchUpsert.mockImplementation(
        actual.pgBatchUpsert as (...a: unknown[]) => unknown,
      );
      mockIngestPdf.mockResolvedValue({
        parentDocId: "p",
        docTitle: "test-doc",
        manifest: MANIFEST,
        chunks: [{ ...chunk }],
        counts: { text: 1, table: 0, sections: 1, truncated: false },
      });
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      if (origKey === undefined) delete process.env.COMMIT_DB_KEY;
      else process.env.COMMIT_DB_KEY = origKey;
    });

    function stubFetch(
      storedHash: string | null,
      fail: { search?: number; patch?: number } = {},
    ) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          const method = init?.method ?? "GET";
          calls.push({
            url,
            method,
            body: init?.body ? JSON.parse(init.body as string) : undefined,
          });
          if (method === "GET" && url.includes("select=content_hash")) {
            return {
              ok: true,
              json: async () =>
                storedHash === null ? [] : [{ content_hash: storedHash }],
            };
          }
          if (method === "GET" && url.includes("related_to=cs.")) {
            // Slow search: an un-awaited cascade would let a write overtake it.
            await new Promise((r) => setTimeout(r, 30));
            if (fail.search) return { ok: false, status: fail.search };
            return { ok: true, json: async () => [{ path: chunk.path }] };
          }
          if (method === "PATCH" && fail.patch) {
            return { ok: false, status: fail.patch };
          }
          return { ok: true, json: async () => [] };
        }),
      );
    }

    const label = (c: { url: string; method: string; body: unknown }) =>
      c.method === "GET" && c.url.includes("select=content_hash")
        ? "hash-read"
        : c.method === "GET"
          ? "cascade-search"
          : c.method === "PATCH"
            ? "cascade-patch"
            : Array.isArray(c.body)
              ? "chunks-post"
              : "manifest-post";

    it("changed manifest: hash read → cascade search → cascade patch → manifest → chunks", async () => {
      stubFetch("an-older-hash");
      const out = (await kbIngestPdfStructuredTool.execute({
        pdf_path: "/tmp/t.pdf",
      })) as string;
      expect(calls.map(label)).toEqual([
        "hash-read",
        "cascade-search",
        "cascade-patch",
        "manifest-post",
        "chunks-post",
      ]);
      const chunks = calls[4].body as Array<Record<string, unknown>>;
      expect(chunks[0].stale).toBe(false);
      expect(chunks[0].related_to).toEqual([MANIFEST.path]);
      expect(calls[3].body).not.toHaveProperty("related_to");
      expect(out).toContain("previous chunks marked stale");
    });

    it("unchanged manifest: no cascade at all, chunks still written", async () => {
      const { contentHash } = await vi.importActual<
        typeof import("../../db/pgvector.js")
      >("../../db/pgvector.js");
      stubFetch(contentHash(MANIFEST.content));
      await kbIngestPdfStructuredTool.execute({ pdf_path: "/tmp/t.pdf" });
      expect(calls.map(label)).toEqual([
        "hash-read",
        "manifest-post",
        "chunks-post",
      ]);
    });

    for (const [name, fail, failed] of [
      [
        "cascade PATCH 500",
        { patch: 500 },
        ["cascade-search", "cascade-patch"],
      ],
      ["cascade search 503", { search: 503 }, ["cascade-search"]],
    ] as const) {
      it(`${name}: no manifest POST, chunks written, a failure whose summary flags it; a healthy re-ingest retries the cascade`, async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        stubFetch("an-older-hash", fail);
        const out = (await kbIngestPdfStructuredTool.execute({
          pdf_path: "/tmp/t.pdf",
        })) as string;
        expect(calls.map(label)).toEqual([
          "hash-read",
          ...failed,
          "chunks-post",
        ]);
        const parsed = JSON.parse(out);
        expect(parsed.error).toBe(
          "ingest incomplete: 1 of 1 chunks written, 0 failed, 0 rejected as noise; manifest cascade FAILED, manifest not advanced: next ingest retries",
        );
        expect(parsed.summary).toContain(
          "cascade FAILED, manifest not advanced: next ingest retries",
        );

        // The stored hash was not advanced, so the next ingest cascades.
        calls.length = 0;
        stubFetch("an-older-hash");
        await kbIngestPdfStructuredTool.execute({ pdf_path: "/tmp/t.pdf" });
        expect(calls.map(label)).toEqual([
          "hash-read",
          "cascade-search",
          "cascade-patch",
          "manifest-post",
          "chunks-post",
        ]);
      });
    }
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

  type Batch = { success: number; failed: number; rejected: number };

  /** `n` synthetic entries. */
  const entriesOf = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      path: `notes/entry-${i}`,
      title: `Entry ${i}`,
      content: `content of entry ${i}`,
    }));

  /** The plain summary, byte for byte. */
  function batchPlain(n: number, b: Batch, extra: string[] = []): string {
    return [
      `kb_batch_insert: ${n} entries submitted`,
      `  Inserted: ${b.success} | Rejected (validation): ${b.rejected} | Failed: ${b.failed}`,
      ...extra,
    ].join("\n");
  }

  /** A whole-call or partial failure: `{"error"` first, keys exactly as given. */
  function parsedFailure(out: string, keys: string[]): Record<string, unknown> {
    expect(out.startsWith('{"error":')).toBe(true);
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(keys);
    return parsed;
  }

  it("empty entries → {error}, nothing embedded or written", async () => {
    const out = (await kbBatchInsertTool.execute({ entries: [] })) as string;
    expect(parsedFailure(out, ["error"]).error).toBe(
      "kb_batch_insert: no entries provided.",
    );
    expect(mockEmbed).not.toHaveBeenCalled();
    expect(mockPgBatchUpsert).not.toHaveBeenCalled();
  });

  it("pgvector disabled → {error}, nothing embedded or written", async () => {
    mockIsPgvectorEnabled.mockReturnValue(false);
    const out = (await kbBatchInsertTool.execute({
      entries: [{ path: "p", title: "t", content: "c" }],
    })) as string;
    expect(parsedFailure(out, ["error"]).error).toBe(
      "kb_batch_insert: pgvector is not configured.",
    );
    expect(mockEmbed).not.toHaveBeenCalled();
    expect(mockPgBatchUpsert).not.toHaveBeenCalled();
  });

  // A batch with a failed row, or with no row written, is a failure:
  // `{error: <counts>, summary: <the plain summary>}`.
  it.each([
    [
      "some entries failed",
      5,
      { success: 3, failed: 2, rejected: 0 },
      "kb_batch_insert: 3 of 5 entries written, 2 failed, 0 rejected by validation",
    ],
    [
      "some failed beside rejected and written ones",
      4,
      { success: 2, failed: 1, rejected: 1 },
      "kb_batch_insert: 2 of 4 entries written, 1 failed, 1 rejected by validation",
    ],
    [
      "every entry failed",
      3,
      { success: 0, failed: 3, rejected: 0 },
      "kb_batch_insert: 0 of 3 entries written, 3 failed, 0 rejected by validation",
    ],
    [
      "every entry was rejected, nothing written",
      2,
      { success: 0, failed: 0, rejected: 2 },
      "kb_batch_insert: 0 of 2 entries written, 0 failed, 2 rejected by validation",
    ],
  ] as const)("%s → {error, summary}", async (_case, n, batch, error) => {
    mockPgBatchUpsert.mockResolvedValue(batch);
    const out = (await kbBatchInsertTool.execute({
      entries: entriesOf(n),
    })) as string;
    const parsed = parsedFailure(out, ["error", "summary"]);
    expect(parsed.error).toBe(error);
    expect(parsed.summary).toBe(batchPlain(n, batch));
  });

  it.each([
    ["every entry written", 3, { success: 3, failed: 0, rejected: 0 }],
    [
      "entries written beside rejected ones",
      5,
      { success: 3, failed: 0, rejected: 2 },
    ],
  ] as const)("%s → the plain summary", async (_case, n, batch) => {
    mockPgBatchUpsert.mockResolvedValue(batch);
    const out = (await kbBatchInsertTool.execute({
      entries: entriesOf(n),
    })) as string;
    expect(out.startsWith("{")).toBe(false);
    expect(out).toBe(batchPlain(n, batch));
  });

  it("embedding failures with every entry written → the plain summary", async () => {
    mockEmbed.mockResolvedValue(null);
    const batch = { success: 2, failed: 0, rejected: 0 };
    mockPgBatchUpsert.mockResolvedValue(batch);
    const out = (await kbBatchInsertTool.execute({
      entries: entriesOf(2),
    })) as string;
    expect(out.startsWith("{")).toBe(false);
    expect(out).toBe(
      batchPlain(2, batch, [
        "  Embedding failures: 2 (rows still inserted with FTS-only retrieval)",
      ]),
    );
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

  it("source_path sets related_to on every entry (opt-in lineage)", async () => {
    await kbBatchInsertTool.execute({
      source_path: "notes/source.md",
      entries: [
        { path: "a", title: "A", content: "alpha" },
        { path: "b", title: "B", content: "beta" },
      ],
    });
    const sent = mockPgBatchUpsert.mock.calls[0][0];
    expect(sent.map((e: { related_to?: string[] }) => e.related_to)).toEqual([
      ["notes/source.md"],
      ["notes/source.md"],
    ]);
  });

  it("without source_path entries carry no related_to", async () => {
    await kbBatchInsertTool.execute({
      entries: [{ path: "a", title: "A", content: "alpha" }],
    });
    expect(mockPgBatchUpsert.mock.calls[0][0][0]).not.toHaveProperty(
      "related_to",
    );
  });
});

// ---------------------------------------------------------------------------
// Model-visible definitions
// ---------------------------------------------------------------------------

describe("tool definitions", () => {
  type Prop = { description?: string; enum?: string[] };
  const params = (t: typeof kbBatchInsertTool) =>
    t.definition.function.parameters as {
      properties: Record<string, Prop & { items?: { properties: Record<string, Prop> } }>;
    };
  const entryProps = params(kbBatchInsertTool).properties.entries.items!
    .properties;

  it("the batch description names exactly the modalities the entry enum accepts", () => {
    const listed = /modality\s*\(([^)]*)\)/.exec(
      kbBatchInsertTool.definition.function.description,
    );
    expect(listed).not.toBeNull();
    const named = listed![1].split("|").map((m) => m.trim().replace(/^'|'$/g, ""));
    const accepted = entryProps.modality.enum ?? [];
    expect(accepted.length).toBeGreaterThan(0);
    expect([...named].sort()).toEqual([...accepted].sort());
  });

  it("every entry property carries its exact description", () => {
    const expected: Record<string, string> = {
      path: "KB path of the entry; the write is an upsert keyed on this path.",
      title: "Entry title. An entry whose title is empty or only whitespace is rejected.",
      content:
        "Text of the entry. Content shorter than 20 characters after trimming (10 for type 'correction') or matching a noise pattern is rejected.",
      modality: "Kind of content: 'text' or 'table'.",
      parent_doc_id: "UUID of the document the entry belongs to.",
      section_path: "Headings of the section the entry belongs to. Stored as given.",
      chunk_position: "Position of the entry within its document. Stored as given.",
      tags: "Tags stored on the entry. Omitted, the entry is stored with no tags.",
      type: "Entry type. Omitted, it is stored as 'fact'.",
      qualifier: "Entry qualifier. Omitted, it is stored as 'reference'.",
    };
    const names = Object.keys(entryProps);
    expect([...names].sort()).toEqual(Object.keys(expected).sort());
    expect(
      Object.fromEntries(names.map((n) => [n, entryProps[n].description])),
    ).toEqual(expected);
  });

  it("the batch description ends with the result line", () => {
    expect(
      kbBatchInsertTool.definition.function.description.endsWith(
        "Returns a summary of entries inserted, rejected by validation and failed. When an entry failed to be written, or none was written, the call returns an error with those counts and the summary; entries already written stay written.",
      ),
    ).toBe(true);
  });

  it("the max_chunks description says the bound, the refusal and the cut-off result", () => {
    expect(
      params(kbIngestPdfStructuredTool).properties.max_chunks.description,
    ).toBe(
      "Cap on chunks produced from one PDF: 1 or more, default 500. A value below 1 is refused before the PDF is read. A document with more chunks than the cap is cut off there; the rest is not stored, and the call returns an error with the summary.",
    );
  });
});
