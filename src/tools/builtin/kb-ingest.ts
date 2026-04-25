/**
 * v7.13 KB ingestion tools — `kb_ingest_pdf_structured` + `kb_batch_insert`.
 *
 * kb_ingest_pdf_structured: read a local PDF → structured KbEntry[] → embed
 *   → pgBatchUpsert. Preserves tables (modality='table') and hierarchical
 *   section paths (parent_doc_id, section_path, chunk_position).
 *
 * kb_batch_insert: power-user path. Accept pre-parsed entries, embed each,
 *   pgBatchUpsert. Useful for callers that already have structured content
 *   (Obsidian Drive ingest, custom scrapers).
 */

import type { Tool } from "../types.js";
import { ingestPdf } from "../../kb/pdf-structured-ingest.js";
import {
  isPgvectorEnabled,
  pgBatchUpsert,
  coerceKbType,
  coerceKbQualifier,
  KB_ENTRY_TYPES,
  KB_QUALIFIERS,
  type KbEntry,
} from "../../db/pgvector.js";
import { embed } from "../../memory/embeddings.js";

/** RFC 4122 UUID regex (any version). Audit W3 gate for parent_doc_id. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// kb_ingest_pdf_structured
// ---------------------------------------------------------------------------

export const kbIngestPdfStructuredTool: Tool = {
  name: "kb_ingest_pdf_structured",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "kb_ingest_pdf_structured",
      description: `Ingest a local PDF into the pgvector KB with structure preserved.

USE WHEN:
- User wants to ingest 10-K / earnings / research PDFs for later retrieval
- Need tables + section hierarchy preserved (not flattened to plain text)
- F7 or F9 rituals want structured financial-document RAG

NOT WHEN:
- User wants to read a PDF ad-hoc (use pdf_read; that's a read-only tool)
- Structure doesn't matter (still use kb_ingest_pdf_structured — the cost is marginal)

Pipeline: @opendataloader/pdf → markdown → section-stack sectionizer + pipe-format
table detector → KbEntry[] with modality ('text' | 'table') + parent_doc_id +
section_path + chunk_position → embed each → pgBatchUpsert.

Returns a summary: chunks inserted + modality breakdown + sections count.

Notes: Large tables (>8k chars) are kept as single chunks with an 'oversize-table'
tag; max_chunks defaults to 500 (configurable). Equation + image-caption modalities
are reserved but not produced by this Option-B pipeline — MinerU polish will add
them later if needed.`,
      parameters: {
        type: "object",
        properties: {
          pdf_path: {
            type: "string",
            description: "Absolute path to the local PDF file.",
          },
          namespace: {
            type: "string",
            description:
              "Namespace prefix for chunk paths. Default 'pdf-ingest'.",
          },
          parent_doc_id: {
            type: "string",
            description:
              "Override UUID. If omitted, one is generated and returned in the summary.",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Tags applied to every chunk.",
          },
          max_chunks: {
            type: "number",
            description:
              "Cap on chunks produced from one PDF. Default 500; pathological inputs get truncated with an explicit 'truncated' flag in the summary.",
          },
        },
        required: ["pdf_path"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const pdfPath = args.pdf_path as string | undefined;
    if (!pdfPath) {
      return JSON.stringify({ error: "pdf_path is required" });
    }
    if (!isPgvectorEnabled()) {
      return "kb_ingest_pdf_structured: pgvector is not configured — cannot persist. Set SUPABASE_URL + SUPABASE_API_KEY to enable.";
    }

    const namespace = args.namespace as string | undefined;
    const parentDocId = args.parent_doc_id as string | undefined;
    // Audit W3: reject non-UUID parent_doc_id up front — the Supabase column
    // is `uuid` type and a non-UUID value would 400 the whole batch.
    if (parentDocId !== undefined && !UUID_RE.test(parentDocId)) {
      return `kb_ingest_pdf_structured: parent_doc_id must be a UUID (got '${parentDocId}'). Omit it to auto-generate.`;
    }
    const tags = args.tags as string[] | undefined;
    const maxChunks = Number.isFinite(Number(args.max_chunks))
      ? Number(args.max_chunks)
      : undefined;

    let result;
    try {
      result = await ingestPdf(pdfPath, {
        namespace,
        parentDocId,
        tags,
        maxChunks,
      });
    } catch (err) {
      return `kb_ingest_pdf_structured: failed to parse ${pdfPath} — ${err instanceof Error ? err.message : err}`;
    }

    // Embed each chunk sequentially (bounded by Gemini rate limits).
    // Empty embedding list → pgvector still accepts; retrieval will fall back
    // to FTS-only ranking. Log the embedding failure count in the summary.
    let embedFailures = 0;
    for (const chunk of result.chunks) {
      try {
        const vec = await embed(chunk.content);
        if (vec) chunk.embedding = Array.from(vec);
        else embedFailures++;
      } catch {
        embedFailures++;
      }
    }

    const batch = await pgBatchUpsert(result.chunks);
    return formatIngestSummary(result, batch, embedFailures, pdfPath);
  },
};

// ---------------------------------------------------------------------------
// kb_batch_insert
// ---------------------------------------------------------------------------

export const kbBatchInsertTool: Tool = {
  name: "kb_batch_insert",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "kb_batch_insert",
      description: `Batch-insert pre-parsed KB entries into pgvector.

USE WHEN:
- Caller already has structured content (Obsidian Drive ingest, custom scrapers,
  Google Docs exports with preserved headings) and wants to bypass the PDF
  extractor
- Programmatic ingestion pipelines that need direct control over paths, tags,
  modalities

NOT WHEN:
- Source is a PDF (use kb_ingest_pdf_structured; it owns the chunker)

Each entry must have path + title + content. Optional: modality
('text'|'table'|'equation'|'image_caption'), parent_doc_id (UUID string),
section_path (array of strings), chunk_position (int), tags, type, qualifier.

Returns summary of inserted / duplicate-skipped / rejected counts.`,
      parameters: {
        type: "object",
        properties: {
          entries: {
            type: "array",
            description: "KB entries to insert.",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                title: { type: "string" },
                content: { type: "string" },
                modality: {
                  type: "string",
                  // Option B ships only text + table. equation + image_caption
                  // are reserved in KbEntry for the MinerU polish but NOT
                  // accepted here until the extractor produces them. Audit W1.
                  enum: ["text", "table"],
                },
                parent_doc_id: { type: "string" },
                section_path: { type: "array", items: { type: "string" } },
                chunk_position: { type: "number" },
                tags: { type: "array", items: { type: "string" } },
                type: {
                  type: "string",
                  enum: KB_ENTRY_TYPES as unknown as string[],
                },
                qualifier: {
                  type: "string",
                  enum: KB_QUALIFIERS as unknown as string[],
                },
              },
              required: ["path", "title", "content"],
            },
          },
        },
        required: ["entries"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const entries = args.entries as KbEntry[] | undefined;
    if (!Array.isArray(entries) || entries.length === 0) {
      return "kb_batch_insert: no entries provided.";
    }
    if (!isPgvectorEnabled()) {
      return "kb_batch_insert: pgvector is not configured.";
    }

    // Coerce type/qualifier on each entry — the JSON schema declares enums,
    // but a non-conforming LLM emission would otherwise propagate to the DB
    // CHECK constraint as a 400. Coerce defends against schema drift across
    // the LLM-driven boundary (audit W1).
    for (const entry of entries) {
      entry.type = coerceKbType(entry.type);
      entry.qualifier = coerceKbQualifier(entry.qualifier);
    }

    // Embed each entry (sequential — bounded by Gemini rate limits)
    let embedFailures = 0;
    for (const entry of entries) {
      if (entry.embedding !== undefined) continue; // already embedded
      try {
        const vec = await embed(entry.content);
        if (vec) entry.embedding = Array.from(vec);
        else embedFailures++;
      } catch {
        embedFailures++;
      }
    }

    const batch = await pgBatchUpsert(entries);
    const lines = [
      `kb_batch_insert: ${entries.length} entries submitted`,
      `  Inserted: ${batch.success} | Rejected (validation): ${batch.rejected} | Failed: ${batch.failed}`,
    ];
    if (embedFailures > 0) {
      lines.push(
        `  Embedding failures: ${embedFailures} (rows still inserted with FTS-only retrieval)`,
      );
    }
    return lines.join("\n");
  },
};

// ---------------------------------------------------------------------------
// Formatter
// ---------------------------------------------------------------------------

function formatIngestSummary(
  result: Awaited<ReturnType<typeof ingestPdf>>,
  batch: { success: number; failed: number; rejected: number },
  embedFailures: number,
  pdfPath: string,
): string {
  const lines = [
    `kb_ingest_pdf_structured: ${pdfPath}`,
    `  parent_doc_id: ${result.parentDocId}`,
    `  Doc title: ${result.docTitle}`,
    `  Chunks: ${result.chunks.length} (text ${result.counts.text}, table ${result.counts.table})`,
    `  Sections: ${result.counts.sections}`,
    `  Inserted: ${batch.success} | Rejected (noise): ${batch.rejected} | Failed: ${batch.failed}`,
  ];
  if (result.counts.truncated) {
    lines.push(`  TRUNCATED: exceeded max_chunks — some content not ingested`);
  }
  if (result.largestTable) {
    lines.push(
      `  Largest table: ${result.largestTable.chars} chars at ${result.largestTable.sectionPath.join(" / ")}`,
    );
  }
  if (embedFailures > 0) {
    lines.push(
      `  Embedding failures: ${embedFailures} (chunks inserted with FTS-only retrieval)`,
    );
  }
  // Audit S1: when every attempted row failed, hint at the likely cause
  // (v7.13 schema migration not yet applied to the Supabase kb_entries).
  if (batch.success === 0 && batch.failed > 0 && result.chunks.length > 0) {
    lines.push(
      `  Hint: if this is the first v7.13 ingest, confirm the schema migration was applied (modality / parent_doc_id / section_path / chunk_position columns on kb_entries).`,
    );
  }
  return lines.join("\n");
}
