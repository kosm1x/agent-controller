/**
 * Google Docs, Sheets, Slides, and Tasks tools.
 */

import type { Tool } from "../types.js";
import { googleFetch } from "../../google/client.js";
import { validatePathSafety } from "./immutable-core.js";

// ---------------------------------------------------------------------------
// gsheets_read
// ---------------------------------------------------------------------------

export const gsheetsReadTool: Tool = {
  name: "gsheets_read",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "gsheets_read",
      description: `Read data from a Google Spreadsheet.

DO NOT USE browser__goto for Google Sheets URLs — it hits an auth wall.
Use this tool instead — it reads via the authenticated Sheets API.

WORKFLOW: If user mentions a spreadsheet by name, call gdrive_list first to find the file ID.

AFTER READING: Report the spreadsheet name and range read. Only report data that was actually returned — never fill gaps with assumed values.`,
      parameters: {
        type: "object",
        properties: {
          spreadsheet_id: {
            type: "string",
            description:
              "Spreadsheet ID (from gdrive_list or the URL between /d/ and /edit)",
          },
          range: {
            type: "string",
            description:
              "A1 notation range (e.g., 'Sheet1!A1:D10'). Defaults to first sheet all data.",
          },
        },
        required: ["spreadsheet_id"],
      },
    },
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const id = args.spreadsheet_id as string;
    const range = (args.range as string) ?? "Sheet1";

    try {
      const result = await googleFetch<{
        values?: string[][];
        range: string;
      }>(
        `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(range)}`,
      );

      const values = result.values ?? [];

      // Extract the starting row number from the resolved range (e.g. "Sheet1!A2:L50" → 2)
      // so each row includes its actual sheet row number. This prevents LLM row-counting errors.
      const rangeMatch = result.range.match(/!.*?(\d+)/);
      const startRow = rangeMatch ? parseInt(rangeMatch[1], 10) : 1;

      // Pre-formatted output: markdown table so LLM relays data as-is.
      // First row = headers, rest = data rows with row numbers.
      if (values.length === 0) {
        return `📊 Sheet: ${result.range}\nNo data found.`;
      }
      const headers = values[0];
      const dataRows = values.slice(1);
      const lines = [
        `📊 **${result.range}** (${values.length} rows)`,
        "",
        `| Row | ${headers.join(" | ")} |`,
        `| --- | ${headers.map(() => "---").join(" | ")} |`,
        ...dataRows.map(
          (row, i) =>
            `| ${startRow + 1 + i} | ${row.map((c) => (c ?? "").slice(0, 100)).join(" | ")} |`,
        ),
      ];
      return lines.join("\n");
    } catch (err) {
      return JSON.stringify({
        error: `Sheets read failed: ${err instanceof Error ? err.message : err}`,
      });
    }
  },
};

// ---------------------------------------------------------------------------
// gsheets_write
// ---------------------------------------------------------------------------

export const gsheetsWriteTool: Tool = {
  name: "gsheets_write",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "gsheets_write",
      description: `Write data to a Google Spreadsheet. Values MUST be a 2D array (array of rows, each row is an array of cell values).

CORRECT: values: [["Name","Score"],["Alice","95"]]
WRONG:   values: ["Name","Score","Alice","95"]

DEDUP: The tool automatically skips rows whose first column value (ID) already exists in the sheet. You do NOT need to check for duplicates manually.

MODES:
- append=true (DEFAULT): Adds rows AFTER the last row with data. Use this when adding new entries. The range only needs the sheet name and columns (e.g., "Sheet1!A:J"). Row numbers are ignored — data goes to the next empty row automatically.
- append=false: Overwrites the exact range specified. Use ONLY for corrections to specific cells (e.g., "Sheet1!K55:L55").

ROW TARGETING: When updating specific cells, use the "row" number from gsheets_read results directly in your range. Example: gsheets_read returns {row: 30, cells: [...]} → write to "Sheet1!K30:L30". NEVER count rows manually — always use the row number from the read result.

WORKFLOW: If the spreadsheet doesn't exist, create it with gdrive_create first (type: sheet), then write here.

AFTER WRITING: Report the spreadsheet name, range written, and number of rows affected.`,
      parameters: {
        type: "object",
        properties: {
          spreadsheet_id: {
            type: "string",
            description: "Spreadsheet ID",
          },
          range: {
            type: "string",
            description:
              "A1 notation range. For append mode: 'Sheet1!A:J' (columns only). For overwrite: 'Sheet1!A10:J10' (exact cells).",
          },
          values: {
            type: "array",
            items: { type: "array", items: { type: "string" } },
            description:
              'Rows of data as 2D array (e.g., [["Name","Score"],["Alice","95"]])',
          },
          append: {
            type: "boolean",
            description:
              "true (default): append after last row. false: overwrite exact range.",
          },
        },
        required: ["spreadsheet_id", "range", "values"],
      },
    },
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const id = args.spreadsheet_id as string;
    const range = args.range as string;
    const rawValues = args.values;

    // Normalize values: LLM commonly sends wrong formats.
    // Google Sheets API requires values to be Array<Array<primitive>>.
    let values: unknown[][];
    let parsedValues = rawValues;

    // Handle string values (LLM sends JSON string instead of array)
    if (typeof parsedValues === "string") {
      try {
        parsedValues = JSON.parse(parsedValues);
      } catch {
        return JSON.stringify({
          error: `values is a string but not valid JSON. Send a 2D array like [["a","b"],["c","d"]]`,
        });
      }
    }

    console.log(
      `[gsheets_write] range=${range} type=${typeof parsedValues} isArray=${Array.isArray(parsedValues)} len=${Array.isArray(parsedValues) ? parsedValues.length : "N/A"}`,
    );

    if (!Array.isArray(parsedValues) || parsedValues.length === 0) {
      return JSON.stringify({
        error: `values must be a non-empty 2D array like [["a","b"],["c","d"]]. Received: ${typeof parsedValues}`,
      });
    }
    if (!Array.isArray(parsedValues[0])) {
      // Flat array like ["a","b","c"] → wrap as single row [["a","b","c"]]
      values = [
        (parsedValues as unknown[]).map((v) =>
          v === null || v === undefined
            ? ""
            : typeof v === "object"
              ? JSON.stringify(v)
              : v,
        ),
      ];
    } else {
      // Already 2D — normalize cell values (objects → strings, null → "")
      values = (parsedValues as unknown[][]).map((row) =>
        Array.isArray(row)
          ? row.map((v) =>
              v === null || v === undefined
                ? ""
                : typeof v === "object"
                  ? JSON.stringify(v)
                  : v,
            )
          : [String(row)],
      );
    }

    // If the range targets specific rows (e.g., K6:L6), auto-detect overwrite mode.
    // Append mode ignores row numbers — data goes to the end of the sheet.
    const rangeHasRow = /![A-Z]+\d+/.test(range);
    const useAppend = rangeHasRow
      ? args.append === true
      : args.append !== false;
    console.log(
      `[gsheets_write] mode=${useAppend ? "append" : "overwrite"} append_arg=${args.append} range_has_row=${rangeHasRow}`,
    );

    // Dedup: only in append mode when writing to column A (first column).
    // Skip dedup for overwrite mode or when writing to non-A columns (e.g., K:L)
    // — comparing K-column values against A-column IDs is nonsensical.
    let dedupedValues = values;
    const startsAtColA = /!A[:\d]/.test(range) || /![A-Z]+$/.test(range);

    if (useAppend && startsAtColA) {
      try {
        const sheetName = range.includes("!") ? range.split("!")[0] : "Sheet1";
        const existingCol = await googleFetch<{ values?: string[][] }>(
          `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(sheetName + "!A:A")}`,
        );
        const existingIds = new Set(
          (existingCol.values ?? []).flat().map((v) => String(v).trim()),
        );
        const before = dedupedValues.length;
        dedupedValues = dedupedValues.filter(
          (row) => !existingIds.has(String(row[0]).trim()),
        );
        if (dedupedValues.length < before) {
          console.log(
            `[gsheets_write] Dedup: ${before - dedupedValues.length} duplicate row(s) skipped (IDs already in column A)`,
          );
        }
      } catch (dedupErr) {
        console.error(
          `[gsheets_write] Dedup check failed: ${dedupErr instanceof Error ? dedupErr.message : dedupErr}`,
        );
      }

      if (dedupedValues.length === 0) {
        return JSON.stringify({
          written: false,
          skipped: values.length,
          reason:
            "All rows already exist in the sheet (duplicate IDs in column A)",
        });
      }
    }

    try {
      if (useAppend) {
        // Append: POST to .../values/{range}:append — auto-finds next empty row
        const result = await googleFetch<{
          updates: {
            updatedRange: string;
            updatedRows: number;
            updatedCells: number;
          };
        }>(
          `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
          { method: "POST", body: { values: dedupedValues } },
        );

        const skipped = values.length - dedupedValues.length;
        return JSON.stringify({
          written: true,
          mode: "append",
          range: result.updates.updatedRange,
          rows: result.updates.updatedRows,
          cells: result.updates.updatedCells,
          ...(skipped > 0 ? { skipped_duplicates: skipped } : {}),
        });
      } else {
        // Overwrite: PUT to exact range — for corrections only
        const result = await googleFetch<{
          updatedRange: string;
          updatedRows: number;
          updatedCells: number;
        }>(
          `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
          { method: "PUT", body: { values: dedupedValues } },
        );

        const skipped = values.length - dedupedValues.length;
        return JSON.stringify({
          written: true,
          mode: "overwrite",
          range: result.updatedRange,
          rows: result.updatedRows,
          cells: result.updatedCells,
          ...(skipped > 0 ? { skipped_duplicates: skipped } : {}),
        });
      }
    } catch (err) {
      return JSON.stringify({
        error: `Sheets write failed: ${err instanceof Error ? err.message : err}`,
      });
    }
  },
};

// ---------------------------------------------------------------------------
// gdocs_read
// ---------------------------------------------------------------------------

export const gdocsReadTool: Tool = {
  name: "gdocs_read",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "gdocs_read",
      description: `Read the text content of a Google Doc.

DO NOT USE browser__goto for Google Docs URLs — it hits an auth wall.
Use this tool instead — it reads via the authenticated Docs API.
Pass the document ID (from the URL: docs.google.com/document/d/{ID}/edit).

NOTE: For long documents (>8,000 chars), use gdocs_read_full which exports the full
document as plain text with no truncation limit.`,
      parameters: {
        type: "object",
        properties: {
          document_id: {
            type: "string",
            description: "Google Doc ID",
          },
        },
        required: ["document_id"],
      },
    },
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const docId = args.document_id as string;
    try {
      const doc = await googleFetch<{
        title: string;
        body: {
          content: Array<{
            paragraph?: {
              elements: Array<{
                textRun?: { content: string };
              }>;
            };
          }>;
        };
      }>(`https://docs.googleapis.com/v1/documents/${docId}`);

      const text = doc.body.content
        .map((block) =>
          (block.paragraph?.elements ?? [])
            .map((e) => e.textRun?.content ?? "")
            .join(""),
        )
        .join("");

      const truncated = text.length > 8000;
      return JSON.stringify({
        document_id: docId,
        title: doc.title,
        text: text.slice(0, 8000),
        ...(truncated
          ? {
              warning: `Document truncated at 8,000 chars (total: ${text.length} chars). Use gdocs_read_full to read the complete document.`,
            }
          : {}),
      });
    } catch (err) {
      return JSON.stringify({
        error: `Docs read failed: ${err instanceof Error ? err.message : err}`,
      });
    }
  },
};

// ---------------------------------------------------------------------------
// gdocs_read_full  — full document export via Drive API (no truncation)
// ---------------------------------------------------------------------------

export const gdocsReadFullTool: Tool = {
  name: "gdocs_read_full",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "gdocs_read_full",
      description: `Read the COMPLETE text content of a Google Doc without any truncation.

USE THIS (not gdocs_read) when:
- The document is long (articles, plans, reports, anything > 1 page)
- gdocs_read returned a warning about truncation
- You need to read the full content for analysis or summarization

HOW IT WORKS: Uses Google Drive Export API to export the doc as plain text.
This bypasses the structural element limit of the Docs API and returns ALL text.

DO NOT USE for short documents or when you only need a preview — gdocs_read is faster.

Pass the document ID (from the URL: docs.google.com/document/d/{ID}/edit).`,
      parameters: {
        type: "object",
        properties: {
          document_id: {
            type: "string",
            description: "Google Doc ID",
          },
        },
        required: ["document_id"],
      },
    },
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const docId = args.document_id as string;
    try {
      // Step 1: Get doc title from Docs API
      const meta = await googleFetch<{ title: string }>(
        `https://docs.googleapis.com/v1/documents/${docId}?fields=title`,
      );

      // Step 2: Export as plain text via Drive API — returns full content, no truncation.
      // Extended timeout: large docs can exceed the default 10s.
      const exportText = await googleFetch<string>(
        `https://www.googleapis.com/drive/v3/files/${docId}/export?mimeType=text%2Fplain`,
        { rawText: true, timeout: 30_000 },
      );

      return JSON.stringify({
        document_id: docId,
        title: meta.title,
        text: exportText,
        chars: exportText.length,
      });
    } catch (err) {
      return JSON.stringify({
        error: `Docs full read failed: ${err instanceof Error ? err.message : err}`,
      });
    }
  },
};

// ---------------------------------------------------------------------------
// gdocs_write
// ---------------------------------------------------------------------------

export const gdocsWriteTool: Tool = {
  name: "gdocs_write",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "gdocs_write",
      description: `Append text to a Google Doc. Inserts at the end of the document.

LARGE CONTENT (> 2 paragraphs): Pass content_file=<path> instead of inline text.
The tool reads the file and writes its contents to the doc. This avoids truncation
when the content is too long to fit in tool arguments.

WORKFLOW for long documents:
1. Write content to a temp file with file_write (e.g., /tmp/doc-content.txt)
2. Call gdocs_write with document_id and content_file=<that path>

AFTER WRITING: Report the document title and what was appended.`,
      parameters: {
        type: "object",
        properties: {
          document_id: {
            type: "string",
            description: "Google Doc ID",
          },
          text: {
            type: "string",
            description:
              "Text to append (short content only). For long content, use content_file instead.",
          },
          content_file: {
            type: "string",
            description:
              "Path to a file whose contents will be appended to the doc. Use instead of text for large documents.",
          },
        },
        required: ["document_id"],
      },
    },
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const docId = args.document_id as string;
    const contentFile = args.content_file as string | undefined;
    let text: string;

    if (contentFile) {
      // Sec2 round-2 fix: content_file was an LLM-controlled absolute path →
      // readFileSync → uploaded to Google Docs. Secret-exfil vector. Route
      // through the read denylist.
      const safety = validatePathSafety(contentFile, "read");
      if (!safety.safe) {
        return JSON.stringify({
          error: `content_file blocked: ${safety.reason}`,
        });
      }
      try {
        const { readFileSync } = await import("node:fs");
        text = readFileSync(contentFile, "utf-8");
      } catch (err) {
        return JSON.stringify({
          error: `content_file not found: ${contentFile}. Write the content to a file first with file_write.`,
        });
      }
    } else {
      text = args.text as string;
    }

    if (!text) {
      return JSON.stringify({
        error:
          "Either text or content_file is required. For large documents, use content_file.",
      });
    }

    try {
      // First get the doc to find the end index
      const doc = await googleFetch<{
        body: { content: Array<{ endIndex: number }> };
      }>(`https://docs.googleapis.com/v1/documents/${docId}`);

      const endIndex =
        doc.body.content[doc.body.content.length - 1]?.endIndex ?? 1;

      await googleFetch(
        `https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`,
        {
          method: "POST",
          body: {
            requests: [
              {
                insertText: {
                  location: { index: endIndex - 1 },
                  text,
                },
              },
            ],
          },
        },
      );

      return JSON.stringify({
        written: true,
        document_id: docId,
        chars: text.length,
      });
    } catch (err) {
      return JSON.stringify({
        error: `Docs write failed: ${err instanceof Error ? err.message : err}`,
      });
    }
  },
};

// ---------------------------------------------------------------------------
// gdocs_replace
// ---------------------------------------------------------------------------

export const gdocsReplaceTool: Tool = {
  name: "gdocs_replace",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "gdocs_replace",
      description: `Replace ALL content in a Google Doc with new text. Clears existing content first.

USE WHEN:
- Syncing/updating a Google Doc with fresh content (not appending)
- The document needs to reflect current state, not accumulate history

DIFFERENCE FROM gdocs_write:
- gdocs_write APPENDS to the end (additive)
- gdocs_replace CLEARS everything and writes fresh (destructive)

LARGE CONTENT: Pass content_file=<path> instead of inline text.

AFTER REPLACING: Report the document title and confirm the content was replaced.`,
      parameters: {
        type: "object",
        properties: {
          document_id: {
            type: "string",
            description: "Google Doc ID",
          },
          text: {
            type: "string",
            description: "New content to replace the entire document with",
          },
          content_file: {
            type: "string",
            description:
              "Path to a file whose contents will replace the doc. Use for large documents.",
          },
        },
        required: ["document_id"],
      },
    },
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const docId = args.document_id as string;
    const contentFile = args.content_file as string | undefined;
    let text: string;

    if (contentFile) {
      // Sec2 round-2 fix: content_file was an LLM-controlled absolute path →
      // readFileSync → uploaded to Google Docs. Secret-exfil vector. Route
      // through the read denylist.
      const safety = validatePathSafety(contentFile, "read");
      if (!safety.safe) {
        return JSON.stringify({
          error: `content_file blocked: ${safety.reason}`,
        });
      }
      try {
        const { readFileSync } = await import("node:fs");
        text = readFileSync(contentFile, "utf-8");
      } catch {
        return JSON.stringify({
          error: `content_file not found: ${contentFile}`,
        });
      }
    } else {
      text = args.text as string;
    }

    if (!text) {
      return JSON.stringify({
        error: "text or content_file is required",
      });
    }

    try {
      // Get current doc to find content range
      const doc = await googleFetch<{
        body: { content: Array<{ endIndex: number }> };
      }>(`https://docs.googleapis.com/v1/documents/${docId}`);

      const endIndex =
        doc.body.content[doc.body.content.length - 1]?.endIndex ?? 1;

      const requests: unknown[] = [];

      // Delete existing content (if any beyond the initial newline)
      if (endIndex > 2) {
        requests.push({
          deleteContentRange: {
            range: { startIndex: 1, endIndex: endIndex - 1 },
          },
        });
      }

      // Insert new content at the beginning
      requests.push({
        insertText: {
          location: { index: 1 },
          text,
        },
      });

      await googleFetch(
        `https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`,
        {
          method: "POST",
          body: { requests },
        },
      );

      return JSON.stringify({
        replaced: true,
        document_id: docId,
        chars: text.length,
      });
    } catch (err) {
      return JSON.stringify({
        error: `Docs replace failed: ${err instanceof Error ? err.message : err}`,
      });
    }
  },
};

// ---------------------------------------------------------------------------
// gslides_read
// ---------------------------------------------------------------------------

export const gslidesReadTool: Tool = {
  name: "gslides_read",
  deferred: true,
  triggerPhrases: [
    "lee esta presentación",
    "abre esta presentación",
    "qué dice este slides",
    "analiza la presentación",
    "read this presentation",
    "diapositivas",
  ],
  definition: {
    type: "function",
    function: {
      name: "gslides_read",
      description: `Read the text content of a Google Slides presentation.

USE WHEN:
- The user shares a Google Slides URL and wants you to read or analyze it
- You need to review presentation content (titles, bullet points, speaker notes)
- The user says "lee esta presentación", "qué dice este slides"

DO NOT USE browser__goto for Google Slides URLs — it hits an auth wall.
Use this tool instead — it reads via the authenticated Slides API.

Pass the presentation ID (from the URL: docs.google.com/presentation/d/{ID}/edit).`,
      parameters: {
        type: "object",
        properties: {
          presentation_id: {
            type: "string",
            description:
              "Google Slides presentation ID (the long string in the URL between /d/ and /edit)",
          },
        },
        required: ["presentation_id"],
      },
    },
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const presId = args.presentation_id as string;
    if (!presId)
      return JSON.stringify({ error: "presentation_id is required" });

    try {
      const pres = await googleFetch<{
        title: string;
        slides: Array<{
          objectId: string;
          pageElements?: Array<{
            objectId: string;
            shape?: {
              text?: {
                textElements?: Array<{
                  textRun?: { content: string };
                }>;
              };
            };
          }>;
          slideProperties?: {
            notesPage?: {
              pageElements?: Array<{
                shape?: {
                  text?: {
                    textElements?: Array<{
                      textRun?: { content: string };
                    }>;
                  };
                };
              }>;
            };
          };
        }>;
      }>(`https://slides.googleapis.com/v1/presentations/${presId}`);

      const slideTexts = pres.slides.map((slide, i) => {
        // Extract text from all shapes on the slide
        const texts = (slide.pageElements ?? [])
          .map((el) =>
            (el.shape?.text?.textElements ?? [])
              .map((te) => te.textRun?.content ?? "")
              .join("")
              .trim(),
          )
          .filter(Boolean);

        // Extract speaker notes
        const notes = (slide.slideProperties?.notesPage?.pageElements ?? [])
          .map((el) =>
            (el.shape?.text?.textElements ?? [])
              .map((te) => te.textRun?.content ?? "")
              .join("")
              .trim(),
          )
          .filter(Boolean)
          .join(" ");

        let slideText = `## Slide ${i + 1}\n${texts.join("\n")}`;
        if (notes) slideText += `\n_Notes: ${notes}_`;
        return slideText;
      });

      const content = `# ${pres.title}\n\n${slideTexts.join("\n\n")}`;
      return content.length > 8000
        ? content.slice(0, 8000) + "\n...(truncated)"
        : content;
    } catch (err) {
      return JSON.stringify({
        error: `Slides read failed: ${err instanceof Error ? err.message : err}`,
      });
    }
  },
};

// ---------------------------------------------------------------------------
// gslides_create
// ---------------------------------------------------------------------------

export const gslidesCreateTool: Tool = {
  name: "gslides_create",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "gslides_create",
      description:
        "Create a new Google Slides presentation with initial slides.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Presentation title",
          },
          slides: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string", description: "Slide title" },
                body: { type: "string", description: "Slide body text" },
              },
            },
            description: "Array of slides with title and body",
          },
        },
        required: ["title", "slides"],
      },
    },
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const title = args.title as string;
    const slides = args.slides as Array<{ title: string; body: string }>;

    try {
      // Create presentation
      const pres = await googleFetch<{
        presentationId: string;
        slides: Array<{
          objectId: string;
          pageElements: Array<{ objectId: string }>;
        }>;
      }>("https://slides.googleapis.com/v1/presentations", {
        method: "POST",
        body: { title },
      });

      // Build requests to add slides
      const requests: unknown[] = [];

      // Delete the default blank slide
      if (pres.slides.length > 0) {
        requests.push({
          deleteObject: { objectId: pres.slides[0].objectId },
        });
      }

      for (let i = 0; i < slides.length; i++) {
        const slideId = `slide_${i}`;
        const titleId = `title_${i}`;
        const bodyId = `body_${i}`;

        requests.push({
          createSlide: {
            objectId: slideId,
            insertionIndex: i,
            slideLayoutReference: {
              predefinedLayout: "TITLE_AND_BODY",
            },
            placeholderIdMappings: [
              {
                layoutPlaceholder: { type: "TITLE" },
                objectId: titleId,
              },
              {
                layoutPlaceholder: { type: "BODY" },
                objectId: bodyId,
              },
            ],
          },
        });

        requests.push({
          insertText: {
            objectId: titleId,
            text: slides[i].title,
          },
        });

        requests.push({
          insertText: {
            objectId: bodyId,
            text: slides[i].body,
          },
        });
      }

      await googleFetch(
        `https://slides.googleapis.com/v1/presentations/${pres.presentationId}:batchUpdate`,
        { method: "POST", body: { requests } },
      );

      return JSON.stringify({
        created: true,
        presentationId: pres.presentationId,
        url: `https://docs.google.com/presentation/d/${pres.presentationId}/edit`,
        slides: slides.length,
      });
    } catch (err) {
      return JSON.stringify({
        error: `Slides creation failed: ${err instanceof Error ? err.message : err}`,
      });
    }
  },
};

// ---------------------------------------------------------------------------
// gtasks_create
// ---------------------------------------------------------------------------

export const gtasksCreateTool: Tool = {
  name: "gtasks_create",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "gtasks_create",
      description:
        'Create a Google Task in the default task list ("My Tasks").',
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Task title",
          },
          notes: {
            type: "string",
            description: "Task notes/description",
          },
          due: {
            type: "string",
            description:
              "Due date in RFC 3339 format (e.g., 2026-04-01T00:00:00Z)",
          },
        },
        required: ["title"],
      },
    },
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const title = args.title as string;
    const notes = args.notes as string | undefined;
    const due = args.due as string | undefined;

    try {
      // Get the default task list
      const lists = await googleFetch<{
        items: Array<{ id: string; title: string }>;
      }>("https://tasks.googleapis.com/tasks/v1/users/@me/lists");

      const defaultList = lists.items?.[0];
      if (!defaultList) {
        return JSON.stringify({ error: "No task lists found" });
      }

      const body: Record<string, unknown> = { title };
      if (notes) body.notes = notes;
      if (due) body.due = due;

      const task = await googleFetch<{ id: string; title: string }>(
        `https://tasks.googleapis.com/tasks/v1/lists/${defaultList.id}/tasks`,
        { method: "POST", body },
      );

      return JSON.stringify({
        created: true,
        taskId: task.id,
        title: task.title,
        list: defaultList.title,
      });
    } catch (err) {
      return JSON.stringify({
        error: `Task creation failed: ${err instanceof Error ? err.message : err}`,
      });
    }
  },
};
