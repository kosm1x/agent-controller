import { describe, it, expect, vi } from "vitest";

// This file only reads the strings of seventeen Google tools; no handler is called.
// Replaced for the whole file by stubs that throw when called: the Google
// request client, the Drive query helper, the path-safety check, the path
// resolver, the run-context lookup, the read-back gate declaration, the secret
// scrubber and the provenance check (their real modules are never loaded);
// every function export of "fs" and "node:fs" (other exports are kept); and
// the global fetch. "path", "node:path" and the three tool modules stay real.
const stub = vi.hoisted(() => (what: string) =>
  vi.fn(() => {
    throw new Error(`${what} is a stub in this file`);
  }),
);
const stubbedFs = vi.hoisted(() => (real: Record<string, unknown>) => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(real))
    out[k] =
      typeof v === "function"
        ? vi.fn(() => {
            throw new Error(`fs ${k} is a stub in this file`);
          })
        : v;
  out.default = out;
  return out;
});
vi.hoisted(() => vi.stubGlobal("fetch", stub("fetch")));

vi.mock("../../google/client.js", () => ({ googleFetch: stub("googleFetch") }));
vi.mock("../../google/drive-query.js", () => ({
  escapeDriveQueryValue: stub("escapeDriveQueryValue"),
}));
vi.mock("./immutable-core.js", () => ({
  validatePathSafety: stub("validatePathSafety"),
}));
vi.mock("./write-guard.js", () => ({ realResolve: stub("realResolve") }));
vi.mock("../rule-of-two.js", () => ({
  currentRunTaskId: stub("currentRunTaskId"),
}));
vi.mock("../../lib/v8-4/readback.js", () => ({
  declareReadbackGate: stub("declareReadbackGate"),
}));
vi.mock("../../lib/secret-refs.js", () => ({ scrubSecrets: stub("scrubSecrets") }));
vi.mock("../../lib/v8-4/provenance-gate.js", () => ({
  checkArtifactProvenance: stub("checkArtifactProvenance"),
}));
vi.mock("fs", async (importOriginal) =>
  stubbedFs(await importOriginal<Record<string, unknown>>()),
);
vi.mock("node:fs", async (importOriginal) =>
  stubbedFs(await importOriginal<Record<string, unknown>>()),
);

import * as fs from "fs";
import * as nodeFs from "node:fs";
import * as client from "../../google/client.js";
import * as driveQuery from "../../google/drive-query.js";
import * as immutableCore from "./immutable-core.js";
import * as writeGuard from "./write-guard.js";
import * as ruleOfTwo from "../rule-of-two.js";
import * as readback from "../../lib/v8-4/readback.js";
import * as secretRefs from "../../lib/secret-refs.js";
import * as provenanceGate from "../../lib/v8-4/provenance-gate.js";
import type { Tool } from "../types.js";
import { gmailSearchTool, gmailSendTool, gmailReadTool } from "./google-gmail.js";
import {
  gdriveCreateTool,
  gdriveShareTool,
  gdriveDeleteTool,
  gdriveMoveTool,
  gdriveUploadTool,
  gdriveDownloadTool,
} from "./google-drive.js";
import {
  gsheetsWriteTool,
  gdocsWriteTool,
  gdocsReplaceTool,
  gslidesCreateTool,
  gtasksCreateTool,
  gsheetsReadTool,
  gdocsReadTool,
  gdocsReadFullTool,
} from "./google-docs.js";

const desc = (t: Tool) => t.definition.function.description;
const prop = (t: Tool, name: string) =>
  (
    t.definition.function.parameters as {
      properties: Record<string, { description: string }>;
    }
  ).properties[name].description;

const GMAIL_SEARCH = `Search emails in Jarvis's Gmail mailbox.

USE WHEN:
- The user asks about received emails, recent messages, or to find a specific email
- You need to check if an email was received from someone
- User asks to "verify" email status

CRITICAL: Report ONLY what the search returns. If the result is 0 emails, say "0 results found."
NEVER fabricate, infer, or claim emails exist that weren't in the search results.
If no emails match, the answer is "no emails found" — not a story about what might have been sent.

Supports Gmail search operators: from:, to:, subject:, after:, before:, is:unread, has:attachment

DO NOT USE WHEN:
- You need the body or attachments of a message: this tool returns only the ID, sender, subject, date and a short snippet per message — use gmail_read with its ID when it is among your tools.
- You want to send an email: this tool only searches and sends nothing — use gmail_send when it is among your tools.
- You need more than 10 messages or a count of all matches: it returns at most 10 per call (max_results is capped at 10) and shows only how many it returned.`;

const GDRIVE_CREATE = `Create a new file in Google Drive (document, spreadsheet, presentation, or folder).

USE WHEN:
- The user asks to create a new document, spreadsheet, presentation, or folder
- You need to prepare a file for sharing or collaboration

IMPORTANT — CHECK BEFORE CREATING:
Always call gdrive_list first, when it is among your tools, to verify the file/folder doesn't already exist.
If it exists, return the existing file instead of creating a duplicate.
Drive does NOT prevent duplicate names — every successful call creates a new file.

DO NOT USE WHEN:
- You want to upload a plain text file (.md, .txt, .json): this tool creates only a Google Doc, Sheet, Slides file or folder and takes no content — use gdrive_upload when it is among your tools.
- You want a presentation with slides in it: this tool adds no slides — use gslides_create when it is among your tools.

Returns the file URL for sharing.`;

const GDRIVE_SHARE = `Share a Google Drive file with someone.

USE WHEN:
- The user asks to share a file with an email address
- After creating a file that needs to be shared

WORKFLOW: If user mentions a file by name, call gdrive_list first, when it is among your tools, to find the file ID.

DO NOT USE WHEN:
- You want a public or "anyone with the link" share: this tool creates one user permission for one email address per call.
- You want to remove someone's access: this tool only creates a permission and never sends a request to remove one.`;

const GDRIVE_DELETE = `Delete a file or folder from Google Drive (moves to trash).

USE WHEN:
- The user asks to remove, delete, or clean up files/folders in Drive
- Removing duplicate files or outdated documents

WORKFLOW:
1. Call gdrive_list, when it is among your tools, to find the file/folder ID by name
2. Call gdrive_delete with the file_id
3. Folders are deleted recursively (all contents moved to trash)

CAUTION: Deleting a folder removes all files inside it. Verify the ID is correct.
NOTE: Files go to Drive trash (recoverable for 30 days). Not permanent deletion.

DO NOT USE WHEN:
- You want a file gone for good: this tool only moves it to the Drive trash and never deletes permanently.
- The file is a knowledge-base file: this tool trashes only the Drive file with that ID and does not change the knowledge-base file.`;

const GDRIVE_MOVE = `Move a file or folder to a different parent folder in Google Drive.

USE WHEN:
- Reorganizing files between folders
- Moving a file from root to a subfolder
- Fixing misplaced files

WORKFLOW:
1. Call gdrive_list, when it is among your tools, to find the file ID and its current parent
2. Find the destination folder ID the same way
3. Call gdrive_move with file_id, from the current parent to the new parent

Also supports renaming — pass new_name to rename while moving (or rename in place).

DO NOT USE WHEN:
- The file is a knowledge-base file: this tool moves only the Drive file with that ID and does not change the knowledge-base file.
- You only want to rename: new_parent_id is still required, and every request this tool sends asks Drive to add it as a parent.`;

const GSHEETS_WRITE = `Write data to a Google Spreadsheet. Values MUST be a 2D array (array of rows, each row is an array of cell values).

CORRECT: values: [["Name","Score"],["Alice","95"]]
WRONG:   values: ["Name","Score","Alice","95"]

DEDUP: in append mode with a "Sheet1!A:J"-style range (sheet name, column A), the tool skips rows whose first value is already in column A, unless reading column A fails. Overwrite mode never skips rows.

MODES:
- append=true (DEFAULT for a range like "Sheet1!A:J"): Adds rows AFTER the last row with data. Use this when adding new entries. The range only needs the sheet name and columns (e.g., "Sheet1!A:J"). Row numbers are ignored — data goes to the next empty row automatically.
- append=false: Overwrites the exact range specified. Use ONLY for corrections to specific cells (e.g., "Sheet1!K55:L55").

ROW TARGETING: When updating specific cells, use the "row" number from gsheets_read results, when it is among your tools, directly in your range. Example: a gsheets_read row numbered 30 → write to "Sheet1!K30:L30". NEVER count rows manually.

WORKFLOW: If the spreadsheet doesn't exist, create it first with gdrive_create (type: sheet) when it is among your tools, then write here.

PROVENANCE: numeric cells must be traceable — produced by a tool of this run (gsheets_read, shell_exec, web_read, data_summarize…) or given by the user — else pass \`fuente\` (URL, file, or "tool + query") or put a "fuente:/calc:/supuesto:" cell in the row. Unsourced figures are REJECTED; figures from memory stay in chat as "~X (sin verificar)".

DO NOT USE WHEN:
- You want cell formatting or a new tab: this tool only writes cell values.
- You want to correct rows already in the sheet: append only inserts new rows — give the exact cells (e.g. "Sheet1!K30:L30") with append=false, so the tool overwrites them.

AFTER WRITING: Report the spreadsheet name, range written, and number of rows affected.`;

const GDOCS_WRITE = `Append text to a Google Doc. Inserts at the end of the document.

LARGE CONTENT (> 2 paragraphs): Pass content_file=<path> instead of inline text.
The tool reads the file and writes its contents to the doc. This avoids truncation
when the content is too long to fit in tool arguments.

WORKFLOW for long documents:
1. Write content to a temp file (e.g., /tmp/doc-content.txt) — use file_write when it is among your tools
2. Call gdocs_write with document_id and content_file=<that path>

PROVENANCE: figures must be traceable — from a tool result of this run or the user's message, or their paragraph carries "fuente:", "calc:" or "supuesto:", or pass \`fuente\` for the whole append. Unsourced figures are REJECTED; figures from memory stay in chat as "~X (sin verificar)".

DO NOT USE WHEN:
- You want to rewrite what the document says: this tool only adds text at the end and keeps everything already there — use gdocs_replace when it is among your tools.
- You want headings, bold, lists or tables: this tool sends the text as it is, with no formatting, and converts no Markdown.
- The document does not exist yet: this tool writes only into the existing document named by document_id and never creates one — use gdrive_create when it is among your tools.

AFTER WRITING: Report the document title and what was appended.`;

const GDOCS_REPLACE = `Replace ALL content in a Google Doc with new text. Clears existing content first.

USE WHEN:
- Syncing/updating a Google Doc with fresh content (not appending)
- The document needs to reflect current state, not accumulate history

DIFFERENCE FROM gdocs_write:
- gdocs_write APPENDS to the end (additive)
- gdocs_replace CLEARS everything and writes fresh (destructive)

LARGE CONTENT: Pass content_file=<path> instead of inline text.

PROVENANCE: same rule as gdocs_write — figures must be traceable (read-tool result of this run, the user's message, a "fuente:/calc:/supuesto:" in the paragraph, or a checkable \`fuente\` parameter); unsourced figures are REJECTED.

DO NOT USE WHEN:
- You want to keep the current text and add to it: this tool deletes the whole body before writing — use gdocs_write when it is among your tools.
- You want to change one passage or a few words: this tool has no find-and-replace; it replaces everything with the text you pass.
- You want headings, bold, lists or tables: this tool sends the text as it is, with no formatting, and converts no Markdown.

AFTER REPLACING: Report the document title and confirm the content was replaced.`;

const GSLIDES_CREATE = `Create a new Google Slides presentation with initial slides.

DO NOT USE WHEN:
- You want to change an existing presentation: this tool only creates a new presentation and never opens or edits an existing one.
- You want images, charts or a layout other than title and body: every slide it adds has one title and one body of plain text.`;

const GTASKS_CREATE = `Create a Google Task in the first task list the service returns.

DO NOT USE WHEN:
- You want something done on a repeat: this tool only adds a task to a Google Tasks list and never runs anything — use schedule_task when it is among your tools.
- You want an event at a set time: this tool sends only a title, notes and a due date — use calendar_create when it is among your tools.
- You want to change, complete or delete a task, or use another list: this tool only creates a task, in the first list the service returns.`;

const GMAIL_SEND = `Send an email from Jarvis's Gmail account.

USE WHEN:
- The user EXPLICITLY asks to send an email ("envía un correo a...", "manda un email")
- You need to share research results or reports BY USER REQUEST

DO NOT USE WHEN:
- The user asks about received emails (use gmail_search when it is among your tools)
- The user asks to "verify" or "check" email status (use gmail_search when it is among your tools, NEVER send)
- You are doing research (NEVER send emails to researchers/contacts during research tasks)
- The user did not explicitly ask you to send an email

CRITICAL: Sending unsolicited emails is a SERIOUS violation. NEVER send an email
unless the user explicitly requested it in the current message. "Verify the email"
means SEARCH, not SEND.

AFTER SENDING: Report the recipient, subject, and confirmation that the email was sent.`;

const GMAIL_READ = `Read a full email message — body text and attachments.

USE WHEN:
- You have a message ID from gmail_search and need to read the full content
- The user asks to read, open, or view an email
- You need to download or inspect email attachments

Any other tool named in this description or its parameters is usable only when it is among your tools.

DO NOT USE browser__goto for Gmail URLs — it hits an auth wall.
Use gmail_search to find emails, then gmail_read with the ID from the results.

WORKFLOW: gmail_search → get message ID (the "ID:" field) → gmail_read with that ID.

Returns the email body (plain text preferred, HTML fallback) and a list of
attachments with filenames and sizes. Use download_attachments=true to save
attachments to /tmp/ and get their local file paths (then use file_read or
pdf_read to inspect them).`;

const GDRIVE_UPLOAD = `Upload or update a plain text file (.md, .txt, .json, etc.) in Google Drive.

USE WHEN:
- Uploading any plain text content as a real file (not a Google Doc)
- Updating an existing file's content (pass file_id to overwrite)

Any other tool named in this description or its parameters is usable only when it is among your tools.

DO NOT USE for knowledge base files: they are synced to Drive automatically. Write them with jarvis_file_write or jarvis_file_update instead; a raw upload creates an untracked duplicate. This tool is for non-KB files only.

BEHAVIOR:
- Creates a new file if no file_id provided
- UPDATES existing file content if file_id is provided (full replace, not append)
- Files are plain text, readable by Obsidian and any text editor

WORKFLOW:
1. Call gdrive_list with parent_folder_id to check if file exists
2. If exists → call gdrive_upload with file_id to update content
3. If not → call gdrive_upload without file_id to create new file

IMPORTANT: Always use parent_folder_id when creating new files to place them in the correct folder.`;

const GDRIVE_DOWNLOAD = `Download a file from Google Drive to the local VPS filesystem.

USE WHEN:
- The user shares a Drive URL (drive.google.com/file/d/<ID>/...) for a PDF, image, or other binary
- You need to read a Drive-hosted PDF — the flow is gdrive_download → pdf_read
- You need to read a Drive-hosted Google Doc/Slide/Sheet as PDF (auto-exports for native types)

Any other tool named in this description or its parameters is usable only when it is among your tools.

DO NOT USE for:
- Native Google Slides where you only need text — gslides_read is faster (no download, no export)
- Plain-text Google Docs — gdocs_read returns text directly

DRIVE URL → file_id EXTRACTION:
- https://drive.google.com/file/d/<ID>/view  → file_id = <ID>
- https://drive.google.com/open?id=<ID>       → file_id = <ID>
- https://docs.google.com/document/d/<ID>/edit → file_id = <ID>

WORKFLOW for Drive-hosted PDFs:
1. Extract file_id from the URL the user shared (or call gdrive_list to find it)
2. Call gdrive_download with file_id (output_path optional, defaults to /tmp/jarvis-downloads/<id>.<ext>)
3. Call pdf_read on the returned path
4. Or for vision: pass the path to gemini_upload / vision tools

NATIVE GOOGLE FILES are auto-exported:
- google-apps.document     → PDF (override with export_format: "docx" | "txt" | "html")
- google-apps.presentation → PDF (override with export_format: "pptx")
- google-apps.spreadsheet  → XLSX (override with export_format: "csv" | "pdf")
- Other binary files (PDF, PNG, ZIP, etc.) download as-is — export_format is ignored.

LIMITS:
- 50 MB hard cap on file size (this tool's safety cap)
- Native exports (Docs/Slides as PDF/DOCX/PPTX) are additionally capped by Drive at 10 MB. Sheets at 100 MB.
- Output paths must resolve under /tmp/jarvis-downloads/ or /root/claude/inbox/. Path traversal (..) and symlink escape are blocked.

Returns: { path, name, mimeType, sizeBytes, note?, hint? }`;

const GSHEETS_READ = `Read data from a Google Spreadsheet.

DO NOT USE browser__goto for Google Sheets URLs — it hits an auth wall.
Use this tool instead — it reads via the authenticated Sheets API.

WORKFLOW: If user mentions a spreadsheet by name, call gdrive_list first, when it is among your tools, to find the file ID.

AFTER READING: Report the spreadsheet name and range read. Only report data that was actually returned — never fill gaps with assumed values.`;

const GDOCS_READ = `Read the text content of a Google Doc.

DO NOT USE browser__goto for Google Docs URLs — it hits an auth wall.
Use this tool instead — it reads via the authenticated Docs API.
Pass the document ID (from the URL: docs.google.com/document/d/{ID}/edit).

NOTE: For long documents (>8,000 chars), use gdocs_read_full, when it is among your tools, which exports the full
document as plain text with no truncation limit.`;

const GDOCS_READ_FULL = `Read the COMPLETE text content of a Google Doc without any truncation.

USE THIS (not gdocs_read) when:
- The document is long (articles, plans, reports, anything > 1 page)
- gdocs_read returned a warning about truncation
- You need to read the full content for analysis or summarization

HOW IT WORKS: Uses Google Drive Export API to export the doc as plain text.
This bypasses the structural element limit of the Docs API and returns ALL text.

DO NOT USE for short documents or when you only need a preview.

Pass the document ID (from the URL: docs.google.com/document/d/{ID}/edit).`;

describe("Google tools — description text", () => {
  it("every function export of each replaced module is a mock (checked without calling one)", () => {
    const mods = {
      fs,
      nodeFs,
      client,
      driveQuery,
      immutableCore,
      writeGuard,
      ruleOfTwo,
      readback,
      secretRefs,
      provenanceGate,
    };
    for (const [modName, mod] of Object.entries(mods)) {
      const fns = Object.entries(mod).filter(([, v]) => typeof v === "function");
      expect(fns.length, modName).toBeGreaterThan(0);
      for (const [name, fn] of fns)
        expect(vi.isMockFunction(fn), `${modName}.${name}`).toBe(true);
    }
    expect(vi.isMockFunction(globalThis.fetch)).toBe(true);
  });

  it("gmail_search: the whole description", () => {
    expect(desc(gmailSearchTool)).toBe(GMAIL_SEARCH);
  });

  it("gdrive_create: the whole description", () => {
    expect(desc(gdriveCreateTool)).toBe(GDRIVE_CREATE);
  });

  it("gdrive_share: the whole description", () => {
    expect(desc(gdriveShareTool)).toBe(GDRIVE_SHARE);
  });

  it("gdrive_delete: the whole description", () => {
    expect(desc(gdriveDeleteTool)).toBe(GDRIVE_DELETE);
  });

  it("gdrive_move: the whole description", () => {
    expect(desc(gdriveMoveTool)).toBe(GDRIVE_MOVE);
  });

  it("gsheets_write: the whole description", () => {
    expect(desc(gsheetsWriteTool)).toBe(GSHEETS_WRITE);
  });

  it("gdocs_write: the whole description", () => {
    expect(desc(gdocsWriteTool)).toBe(GDOCS_WRITE);
  });

  it("gdocs_replace: the whole description", () => {
    expect(desc(gdocsReplaceTool)).toBe(GDOCS_REPLACE);
  });

  it("gslides_create: the whole description", () => {
    expect(desc(gslidesCreateTool)).toBe(GSLIDES_CREATE);
  });

  it("gtasks_create: the whole description", () => {
    expect(desc(gtasksCreateTool)).toBe(GTASKS_CREATE);
  });

  it("gmail_send: the whole description", () => {
    expect(desc(gmailSendTool)).toBe(GMAIL_SEND);
  });

  it("gmail_read: the whole description", () => {
    expect(desc(gmailReadTool)).toBe(GMAIL_READ);
  });

  it("gdrive_upload: the whole description", () => {
    expect(desc(gdriveUploadTool)).toBe(GDRIVE_UPLOAD);
  });

  it("gdrive_download: the whole description", () => {
    expect(desc(gdriveDownloadTool)).toBe(GDRIVE_DOWNLOAD);
  });

  it("gsheets_read: the whole description", () => {
    expect(desc(gsheetsReadTool)).toBe(GSHEETS_READ);
  });

  it("gdocs_read: the whole description", () => {
    expect(desc(gdocsReadTool)).toBe(GDOCS_READ);
  });

  it("gdocs_read_full: the whole description", () => {
    expect(desc(gdocsReadFullTool)).toBe(GDOCS_READ_FULL);
  });

  it("each changed parameter text", () => {
    expect(prop(gdriveShareTool, "file_id")).toBe(
      "File ID (as returned by gdrive_list or gdrive_create)",
    );
    expect(prop(gdriveDeleteTool, "file_id")).toBe(
      "File or folder ID to delete (as returned by gdrive_list)",
    );
    expect(prop(gdriveMoveTool, "file_id")).toBe(
      "File or folder ID to move (as returned by gdrive_list)",
    );
    expect(prop(gdriveMoveTool, "new_parent_id")).toBe(
      "Destination folder ID (as returned by gdrive_list)",
    );
    expect(prop(gdriveMoveTool, "old_parent_id")).toBe(
      "Current parent folder ID to remove from (optional — without it the call asks Drive to remove no parent)",
    );
    expect(prop(gsheetsWriteTool, "append")).toBe(
      "true: append after last row (the default for a range like 'Sheet1!A:J'). false: overwrite exact range.",
    );
  });
});
