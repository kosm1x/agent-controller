/**
 * Google Docs, Sheets, Slides, and Tasks tools.
 */

import type { Tool } from "../types.js";
import { googleFetch } from "../../google/client.js";

// ---------------------------------------------------------------------------
// gsheets_read
// ---------------------------------------------------------------------------

export const gsheetsReadTool: Tool = {
  name: "gsheets_read",
  definition: {
    type: "function",
    function: {
      name: "gsheets_read",
      description: `Read data from a Google Spreadsheet.

WORKFLOW: If user mentions a spreadsheet by name, call gdrive_list first to find the file ID.`,
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

      return JSON.stringify({
        range: result.range,
        rows: result.values?.length ?? 0,
        data: result.values ?? [],
      });
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
  definition: {
    type: "function",
    function: {
      name: "gsheets_write",
      description: `Write data to a Google Spreadsheet. Values MUST be a 2D array (array of rows, each row is an array of cell values).

CORRECT: values: [["Name","Score"],["Alice","95"]]
WRONG:   values: ["Name","Score","Alice","95"]

MODES:
- append=true (DEFAULT): Adds rows AFTER the last row with data. Use this when adding new entries. The range only needs the sheet name and columns (e.g., "Sheet1!A:J"). Row numbers are ignored — data goes to the next empty row automatically.
- append=false: Overwrites the exact range specified. Use ONLY for corrections to specific cells.

WORKFLOW: If the spreadsheet doesn't exist, create it with gdrive_create first (type: sheet), then write here.`,
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

    // Default to append mode — prevents overwriting existing data
    const useAppend = args.append !== false;

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
          { method: "POST", body: { values } },
        );

        return JSON.stringify({
          written: true,
          mode: "append",
          range: result.updates.updatedRange,
          rows: result.updates.updatedRows,
          cells: result.updates.updatedCells,
        });
      } else {
        // Overwrite: PUT to exact range — for corrections only
        const result = await googleFetch<{
          updatedRange: string;
          updatedRows: number;
          updatedCells: number;
        }>(
          `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
          { method: "PUT", body: { values } },
        );

        return JSON.stringify({
          written: true,
          mode: "overwrite",
          range: result.updatedRange,
          rows: result.updatedRows,
          cells: result.updatedCells,
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
  definition: {
    type: "function",
    function: {
      name: "gdocs_read",
      description: `Read the text content of a Google Doc.

WORKFLOW: If user mentions a document by name, call gdrive_list first to find the file ID.`,
      parameters: {
        type: "object",
        properties: {
          document_id: {
            type: "string",
            description: "Document ID (from gdrive_list or URL)",
          },
        },
        required: ["document_id"],
      },
    },
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const id = args.document_id as string;

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
      }>(`https://docs.googleapis.com/v1/documents/${id}`);

      // Extract text content
      const text = doc.body.content
        .map(
          (block) =>
            block.paragraph?.elements
              ?.map((el) => el.textRun?.content ?? "")
              .join("") ?? "",
        )
        .join("")
        .trim();

      return JSON.stringify({
        title: doc.title,
        content: text.slice(0, 10000),
        truncated: text.length > 10000,
      });
    } catch (err) {
      return JSON.stringify({
        error: `Docs read failed: ${err instanceof Error ? err.message : err}`,
      });
    }
  },
};

// ---------------------------------------------------------------------------
// gdocs_write
// ---------------------------------------------------------------------------

export const gdocsWriteTool: Tool = {
  name: "gdocs_write",
  definition: {
    type: "function",
    function: {
      name: "gdocs_write",
      description: `Write/append text to a Google Doc.

WORKFLOW:
1. To create a new doc: call gdrive_create(type: doc) first, then write here
2. To append to existing: call gdocs_read first to get current length, then insert at end`,
      parameters: {
        type: "object",
        properties: {
          document_id: {
            type: "string",
            description: "Document ID",
          },
          text: {
            type: "string",
            description: "Text to insert (plain text, newlines supported)",
          },
          index: {
            type: "number",
            description:
              "Character index to insert at (1 = beginning, omit to append at end)",
          },
        },
        required: ["document_id", "text"],
      },
    },
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const id = args.document_id as string;
    const text = args.text as string;
    let index = args.index as number | undefined;

    try {
      // If no index, get document length to append at end
      if (!index) {
        const doc = await googleFetch<{
          body: { content: Array<{ endIndex: number }> };
        }>(`https://docs.googleapis.com/v1/documents/${id}`);

        const lastElement = doc.body.content[doc.body.content.length - 1];
        index = Math.max((lastElement?.endIndex ?? 2) - 1, 1);
      }

      await googleFetch(
        `https://docs.googleapis.com/v1/documents/${id}:batchUpdate`,
        {
          method: "POST",
          body: {
            requests: [{ insertText: { location: { index }, text } }],
          },
        },
      );

      return JSON.stringify({
        written: true,
        document_id: id,
        chars: text.length,
        at_index: index,
      });
    } catch (err) {
      return JSON.stringify({
        error: `Docs write failed: ${err instanceof Error ? err.message : err}`,
      });
    }
  },
};

// ---------------------------------------------------------------------------
// gslides_create
// ---------------------------------------------------------------------------

export const gslidesCreateTool: Tool = {
  name: "gslides_create",
  definition: {
    type: "function",
    function: {
      name: "gslides_create",
      description: `Create a Google Slides presentation with slides.

WORKFLOW: Creates the presentation via Drive, then adds slides with titles and content.`,
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
              required: ["title"],
            },
            description: "Array of slides with title and optional body",
          },
        },
        required: ["title", "slides"],
      },
    },
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const title = args.title as string;
    const slides = args.slides as Array<{ title: string; body?: string }>;

    try {
      // Create presentation
      const pres = await googleFetch<{
        presentationId: string;
        slides: Array<{ objectId: string }>;
      }>("https://slides.googleapis.com/v1/presentations", {
        method: "POST",
        body: { title },
      });

      const presId = pres.presentationId;

      // Build batch requests for slides
      const requests: unknown[] = [];

      // Delete the default blank slide
      if (pres.slides?.length > 0) {
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

        if (slides[i].body) {
          requests.push({
            insertText: {
              objectId: bodyId,
              text: slides[i].body,
            },
          });
        }
      }

      if (requests.length > 0) {
        await googleFetch(
          `https://slides.googleapis.com/v1/presentations/${presId}:batchUpdate`,
          { method: "POST", body: { requests } },
        );
      }

      return JSON.stringify({
        created: true,
        presentation_id: presId,
        url: `https://docs.google.com/presentation/d/${presId}/edit`,
        slides_count: slides.length,
        title,
      });
    } catch (err) {
      return JSON.stringify({
        error: `Slides create failed: ${err instanceof Error ? err.message : err}`,
      });
    }
  },
};

// ---------------------------------------------------------------------------
// gtasks_create
// ---------------------------------------------------------------------------

export const gtasksCreateTool: Tool = {
  name: "gtasks_create",
  definition: {
    type: "function",
    function: {
      name: "gtasks_create",
      description: `Create a Google Task.

USE WHEN:
- The user wants to add something to Google Tasks (separate from COMMIT tasks)
- For quick reminders or items that don't belong in the COMMIT hierarchy`,
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Task title",
          },
          notes: {
            type: "string",
            description: "Task notes/details (optional)",
          },
          due: {
            type: "string",
            description: "Due date (YYYY-MM-DD, optional)",
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
      // Get default task list
      const lists = await googleFetch<{
        items: Array<{ id: string; title: string }>;
      }>("https://tasks.googleapis.com/tasks/v1/users/@me/lists");

      const listId = lists.items?.[0]?.id;
      if (!listId) {
        return JSON.stringify({ error: "No task lists found" });
      }

      const task: Record<string, unknown> = { title };
      if (notes) task.notes = notes;
      if (due) task.due = `${due}T00:00:00.000Z`;

      const result = await googleFetch<{
        id: string;
        title: string;
        selfLink: string;
      }>(`https://tasks.googleapis.com/tasks/v1/lists/${listId}/tasks`, {
        method: "POST",
        body: task,
      });

      return JSON.stringify({
        created: true,
        id: result.id,
        title: result.title,
      });
    } catch (err) {
      return JSON.stringify({
        error: `Tasks create failed: ${err instanceof Error ? err.message : err}`,
      });
    }
  },
};
