/**
 * Google Drive tools — list, create, share, delete, move, upload, download.
 */

import { mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import type { Tool } from "../types.js";
import { googleFetch } from "../../google/client.js";
import { validatePathSafety } from "./immutable-core.js";

/**
 * Output-path whitelist for gdrive_download. Files may only be written under
 * one of these prefixes. Prevents the tool from being abused as a generic
 * filesystem-write primitive (e.g., overwriting service binaries or configs).
 *
 * `/root/claude/` is intentionally NOT a whitelist root — it overlaps the
 * mission-control source tree, mc.db, and CLAUDE.md, and a misled LLM could
 * overwrite shipped code or memory. Drops go to a dedicated inbox under it.
 */
const DOWNLOAD_WRITE_ROOTS = ["/tmp/jarvis-downloads/", "/root/claude/inbox/"];

/**
 * Canonicalize an output path and verify it stays inside the whitelist after
 * resolving `..` traversal AND symlinks on the parent directory. Returns the
 * resolved absolute path (safe to write to) or an error message.
 *
 * Defends against:
 * - C1 path traversal: `/tmp/jarvis-downloads/../../etc/passwd` → resolves to
 *   `/etc/passwd`, fails whitelist.
 * - C2 symlink escape: `/tmp/jarvis-downloads/x` where `x → /etc/cron.d` → the
 *   parent's realpath is `/etc/cron.d`, fails whitelist.
 *
 * Both checks must run AFTER `validatePathSafety` (which catches the prior
 * layer of nasties: $expansion, glob, dangerous filenames, UNC).
 */
function resolveSafeOutputPath(
  rawPath: string,
): { safe: true; path: string } | { safe: false; reason: string } {
  // Resolve `..` and normalize. resolve() makes the path absolute too.
  const resolved = resolvePath(rawPath);

  const inWhitelist = DOWNLOAD_WRITE_ROOTS.some((root) =>
    resolved.startsWith(root),
  );
  if (!inWhitelist) {
    return {
      safe: false,
      reason: `output_path must resolve to a path under: ${DOWNLOAD_WRITE_ROOTS.join(", ")} (got ${resolved})`,
    };
  }

  // Symlink check: if the parent directory exists, ensure its realpath is
  // still inside the whitelist. ENOENT is fine — the parent will be created
  // fresh by mkdirSync, so no symlink exists yet.
  const parent = dirname(resolved);
  try {
    const realParent = realpathSync(parent);
    const realInWhitelist = DOWNLOAD_WRITE_ROOTS.some(
      (root) =>
        // Trim trailing slash for the equality case (parent === root).
        realParent === root.slice(0, -1) || realParent.startsWith(root),
    );
    if (!realInWhitelist) {
      return {
        safe: false,
        reason: `output_path parent symlinks outside the whitelist (resolved to ${realParent})`,
      };
    }
  } catch (err) {
    // ENOENT means parent doesn't exist yet — that's fine, mkdirSync creates
    // it under whitelist roots we control. Any other error is suspicious.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      return {
        safe: false,
        reason: `output_path parent check failed: ${code ?? "unknown"}`,
      };
    }
  }

  return { safe: true, path: resolved };
}

/** Hard cap on download size — 50 MB. Drive will refuse exports above this anyway. */
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

/** Timeout for binary downloads — 60s (default googleFetch is 10s, too tight for PDFs). */
const DOWNLOAD_TIMEOUT_MS = 60_000;

/**
 * Native Google Workspace MIME types that require export (not direct download).
 * Each maps to its default export format. Caller can override via export_format.
 */
const NATIVE_EXPORT_DEFAULTS: Record<
  string,
  { mimeType: string; ext: string }
> = {
  "application/vnd.google-apps.document": {
    mimeType: "application/pdf",
    ext: "pdf",
  },
  "application/vnd.google-apps.presentation": {
    mimeType: "application/pdf",
    ext: "pdf",
  },
  "application/vnd.google-apps.spreadsheet": {
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ext: "xlsx",
  },
  "application/vnd.google-apps.drawing": {
    mimeType: "image/png",
    ext: "png",
  },
};

/** Map of caller-friendly export_format aliases → real MIME types. */
const EXPORT_FORMAT_ALIASES: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  txt: "text/plain",
  html: "text/html",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
};

/** Best-effort extension guess from MIME type. */
function extFromMime(mime: string): string {
  if (mime === "application/pdf") return "pdf";
  if (mime.includes("wordprocessingml")) return "docx";
  if (mime.includes("presentationml")) return "pptx";
  if (mime.includes("spreadsheetml")) return "xlsx";
  if (mime === "text/plain") return "txt";
  if (mime === "text/html") return "html";
  if (mime === "image/png") return "png";
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/gif") return "gif";
  if (mime === "image/webp") return "webp";
  if (mime === "application/zip") return "zip";
  if (mime === "application/json") return "json";
  if (mime === "text/csv") return "csv";
  // Fall back: take chars after last "/", strip parameters, alphanumerics only
  const after = mime.split("/").pop() ?? "bin";
  return after.split(";")[0].replace(/[^a-z0-9]/gi, "") || "bin";
}

/** Root folders that gdrive_delete refuses to trash. Case-insensitive. */
const PROTECTED_FOLDER_NAMES = new Set([
  "jarvis knowledge base",
  "jarvis-kb",
  "jarvis kb",
]);

const MIME_TYPES: Record<string, string> = {
  doc: "application/vnd.google-apps.document",
  sheet: "application/vnd.google-apps.spreadsheet",
  slide: "application/vnd.google-apps.presentation",
  folder: "application/vnd.google-apps.folder",
};

// ---------------------------------------------------------------------------
// gdrive_list
// ---------------------------------------------------------------------------

export const gdriveListTool: Tool = {
  name: "gdrive_list",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "gdrive_list",
      description: `List or search files in Google Drive.

USE WHEN:
- The user asks to see their files, find a document, or check what's in Drive
- You need to find a file ID for subsequent operations (read, share, delete, move)
- Checking if a file already exists before creating (dedup check)

DO NOT USE browser__goto for drive.google.com URLs — it hits an auth wall.
Use this tool instead — it reads via the authenticated Drive API.

Use parent_folder_id to list contents of a specific folder instead of searching all of Drive.
Supports Drive search queries: name contains 'X', mimeType='application/...', modifiedTime > '2026-01-01'`,
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Drive search query (optional). E.g., \"name contains 'report'\" or leave empty for recent files",
          },
          parent_folder_id: {
            type: "string",
            description:
              "List only files inside this folder (optional). Use to check folder contents or verify a file exists in a specific location.",
          },
          max_results: {
            type: "number",
            description: "Max files to return (1-20, default: 10)",
          },
        },
      },
    },
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const query = args.query as string | undefined;
    const parentFolderId = args.parent_folder_id as string | undefined;
    const maxResults = Math.min(
      Math.max((args.max_results as number) ?? 10, 1),
      20,
    );

    try {
      // Build query: combine user query with parent filter
      const queryParts: string[] = [];
      if (query) queryParts.push(query);
      if (parentFolderId) queryParts.push(`'${parentFolderId}' in parents`);
      queryParts.push("trashed = false");

      let url = `https://www.googleapis.com/drive/v3/files?pageSize=${maxResults}&fields=files(id,name,mimeType,modifiedTime,webViewLink,parents)&orderBy=modifiedTime desc`;
      url += `&q=${encodeURIComponent(queryParts.join(" and "))}`;

      console.log(
        `[gdrive_list] query=${queryParts.join(" and ")} pageSize=${maxResults}`,
      );

      const result = await googleFetch<{
        files: Array<{
          id: string;
          name: string;
          mimeType: string;
          modifiedTime: string;
          webViewLink: string;
          parents?: string[];
        }>;
      }>(url);

      return JSON.stringify({
        files: result.files.map((f) => ({
          id: f.id,
          name: f.name,
          type: f.mimeType.replace("application/vnd.google-apps.", ""),
          parents: f.parents,
          modified: f.modifiedTime,
          url: f.webViewLink,
        })),
        total: result.files.length,
      });
    } catch (err) {
      console.log(
        `[gdrive_list] ERROR: ${err instanceof Error ? err.message : err}`,
      );
      return JSON.stringify({
        error: `Drive list failed: ${err instanceof Error ? err.message : err}`,
      });
    }
  },
};

// ---------------------------------------------------------------------------
// gdrive_create
// ---------------------------------------------------------------------------

export const gdriveCreateTool: Tool = {
  name: "gdrive_create",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "gdrive_create",
      description: `Create a new file in Google Drive (document, spreadsheet, presentation, or folder).

USE WHEN:
- The user asks to create a new document, spreadsheet, presentation, or folder
- You need to prepare a file for sharing or collaboration

IMPORTANT — CHECK BEFORE CREATING:
Always call gdrive_list first to verify the file/folder doesn't already exist.
If it exists, return the existing file instead of creating a duplicate.
Drive does NOT prevent duplicate names — every call creates a new file.

Returns the file URL for sharing.`,
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "File name",
          },
          type: {
            type: "string",
            enum: ["doc", "sheet", "slide", "folder"],
            description:
              "File type: doc (Google Docs), sheet (Sheets), slide (Slides), folder",
          },
          parent_folder_id: {
            type: "string",
            description: "Parent folder ID (optional, defaults to root)",
          },
        },
        required: ["name", "type"],
      },
    },
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const name = args.name as string;
    const type = args.type as string;
    const parentId = args.parent_folder_id as string | undefined;

    const mimeType = MIME_TYPES[type];
    if (!mimeType) {
      return JSON.stringify({
        error: `Invalid type: ${type}. Use doc, sheet, slide, or folder.`,
      });
    }

    try {
      const metadata: Record<string, unknown> = { name, mimeType };
      if (parentId) metadata.parents = [parentId];

      const result = await googleFetch<{
        id: string;
        name: string;
        webViewLink: string;
      }>(
        "https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink",
        { method: "POST", body: metadata },
      );

      return JSON.stringify({
        created: true,
        id: result.id,
        name: result.name,
        type,
        url: result.webViewLink,
      });
    } catch (err) {
      return JSON.stringify({
        error: `Drive create failed: ${err instanceof Error ? err.message : err}`,
      });
    }
  },
};

// ---------------------------------------------------------------------------
// gdrive_share
// ---------------------------------------------------------------------------

export const gdriveShareTool: Tool = {
  name: "gdrive_share",
  requiresConfirmation: true,
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "gdrive_share",
      description: `Share a Google Drive file with someone.

USE WHEN:
- The user asks to share a file with an email address
- After creating a file that needs to be shared

WORKFLOW: If user mentions a file by name, call gdrive_list first to find the file ID.`,
      parameters: {
        type: "object",
        properties: {
          file_id: {
            type: "string",
            description: "File ID (get from gdrive_list or gdrive_create)",
          },
          email: {
            type: "string",
            description: "Email address to share with",
          },
          role: {
            type: "string",
            enum: ["reader", "writer", "commenter"],
            description: "Permission role (default: reader)",
          },
        },
        required: ["file_id", "email"],
      },
    },
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const fileId = args.file_id as string;
    const email = args.email as string;
    const role = (args.role as string) ?? "reader";

    try {
      await googleFetch(
        `https://www.googleapis.com/drive/v3/files/${fileId}/permissions`,
        {
          method: "POST",
          body: { type: "user", role, emailAddress: email },
        },
      );

      return JSON.stringify({ shared: true, file_id: fileId, email, role });
    } catch (err) {
      return JSON.stringify({
        error: `Drive share failed: ${err instanceof Error ? err.message : err}`,
      });
    }
  },
};

// ---------------------------------------------------------------------------
// gdrive_delete
// ---------------------------------------------------------------------------

export const gdriveDeleteTool: Tool = {
  name: "gdrive_delete",
  requiresConfirmation: true,
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "gdrive_delete",
      description: `Delete a file or folder from Google Drive (moves to trash). Requires confirmation.

USE WHEN:
- The user asks to remove, delete, or clean up files/folders in Drive
- Removing duplicate files or outdated documents

WORKFLOW:
1. Call gdrive_list to find the file/folder ID by name
2. Call gdrive_delete with the file_id
3. Folders are deleted recursively (all contents moved to trash)

CAUTION: Deleting a folder removes all files inside it. Verify the ID is correct.
NOTE: Files go to Drive trash (recoverable for 30 days). Not permanent deletion.`,
      parameters: {
        type: "object",
        properties: {
          file_id: {
            type: "string",
            description: "File or folder ID to delete (get from gdrive_list)",
          },
        },
        required: ["file_id"],
      },
    },
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const fileId = args.file_id as string;
    if (!fileId) return JSON.stringify({ error: "file_id is required" });

    try {
      // Pre-flight: fetch file metadata to check for protected folders
      const meta = await googleFetch<{
        id: string;
        name: string;
        mimeType: string;
      }>(
        `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,mimeType`,
      );

      // Block deletion of root knowledge base folders
      const isFolder = meta.mimeType === "application/vnd.google-apps.folder";
      if (isFolder && PROTECTED_FOLDER_NAMES.has(meta.name.toLowerCase())) {
        return JSON.stringify({
          error: `BLOCKED: '${meta.name}' is a protected root folder. Delete individual files inside it, not the folder itself.`,
        });
      }

      // Move to trash (recoverable) rather than permanent delete
      await googleFetch<{ id: string; trashed: boolean }>(
        `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,trashed`,
        {
          method: "PATCH",
          body: { trashed: true },
        },
      );

      return JSON.stringify({
        deleted: true,
        file_id: fileId,
        note: "Moved to trash (recoverable for 30 days)",
      });
    } catch (err) {
      return JSON.stringify({
        error: `Drive delete failed: ${err instanceof Error ? err.message : err}`,
      });
    }
  },
};

// ---------------------------------------------------------------------------
// gdrive_move
// ---------------------------------------------------------------------------

export const gdriveMoveTool: Tool = {
  name: "gdrive_move",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "gdrive_move",
      description: `Move a file or folder to a different parent folder in Google Drive.

USE WHEN:
- Reorganizing files between folders
- Moving a file from root to a subfolder
- Fixing misplaced files

WORKFLOW:
1. Call gdrive_list to find the file ID and its current parent
2. Call gdrive_list to find the destination folder ID
3. Call gdrive_move with file_id, from the current parent to the new parent

Also supports renaming — pass new_name to rename while moving (or rename in place).`,
      parameters: {
        type: "object",
        properties: {
          file_id: {
            type: "string",
            description: "File or folder ID to move (get from gdrive_list)",
          },
          new_parent_id: {
            type: "string",
            description: "Destination folder ID (get from gdrive_list)",
          },
          old_parent_id: {
            type: "string",
            description:
              "Current parent folder ID to remove from (optional — if omitted, file stays in old location too)",
          },
          new_name: {
            type: "string",
            description: "New file name (optional — only if renaming)",
          },
        },
        required: ["file_id", "new_parent_id"],
      },
    },
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const fileId = args.file_id as string;
    const newParentId = args.new_parent_id as string;
    const oldParentId = args.old_parent_id as string | undefined;
    const newName = args.new_name as string | undefined;

    if (!fileId) return JSON.stringify({ error: "file_id is required" });
    if (!newParentId)
      return JSON.stringify({ error: "new_parent_id is required" });

    try {
      let url = `https://www.googleapis.com/drive/v3/files/${fileId}?addParents=${encodeURIComponent(newParentId)}&fields=id,name,parents`;
      if (oldParentId) {
        url += `&removeParents=${encodeURIComponent(oldParentId)}`;
      }

      const body: Record<string, unknown> = {};
      if (newName) body.name = newName;

      const result = await googleFetch<{
        id: string;
        name: string;
        parents: string[];
      }>(url, {
        method: "PATCH",
        body: Object.keys(body).length > 0 ? body : undefined,
      });

      return JSON.stringify({
        moved: true,
        file_id: result.id,
        name: result.name,
        parents: result.parents,
      });
    } catch (err) {
      return JSON.stringify({
        error: `Drive move failed: ${err instanceof Error ? err.message : err}`,
      });
    }
  },
};

// ---------------------------------------------------------------------------
// gdrive_upload
// ---------------------------------------------------------------------------

export const gdriveUploadTool: Tool = {
  name: "gdrive_upload",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "gdrive_upload",
      description: `Upload or update a plain text file (.md, .txt, .json, etc.) in Google Drive.

USE WHEN:
- Syncing Jarvis knowledge base files to Drive (Obsidian mirror)
- Uploading any plain text content as a real file (not a Google Doc)
- Updating an existing file's content (pass file_id to overwrite)

BEHAVIOR:
- Creates a new file if no file_id provided
- UPDATES existing file content if file_id is provided (full replace, not append)
- Files are plain text, readable by Obsidian and any text editor

WORKFLOW for Obsidian sync:
1. Call gdrive_list with parent_folder_id to check if file exists
2. If exists → call gdrive_upload with file_id to update content
3. If not → call gdrive_upload without file_id to create new file

IMPORTANT: Always use parent_folder_id when creating new files to place them in the correct folder.`,
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              'File name with extension (e.g. "DIRECTIVES.md", "projects.md")',
          },
          content: {
            type: "string",
            description: "Text content to upload",
          },
          content_file: {
            type: "string",
            description:
              "Path to a local file whose contents will be uploaded. Use instead of content for large files.",
          },
          parent_folder_id: {
            type: "string",
            description:
              "Folder ID to place the file in (required for new files, ignored for updates)",
          },
          file_id: {
            type: "string",
            description: "Existing file ID to update (omit to create new file)",
          },
          mime_type: {
            type: "string",
            description:
              'MIME type (default: "text/markdown"). Use "text/plain" for .txt, "application/json" for .json',
          },
        },
        required: ["name"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const name = args.name as string;
    const fileId = args.file_id as string | undefined;
    const parentFolderId = args.parent_folder_id as string | undefined;
    const contentFile = args.content_file as string | undefined;
    const mimeType = (args.mime_type as string) ?? "text/markdown";

    if (!name) return JSON.stringify({ error: "name is required" });

    // Resolve content
    let content: string;
    if (contentFile) {
      // Sec2 round-2 fix: content_file secret-exfil vector — see google-docs.ts.
      const safety = validatePathSafety(contentFile, "read");
      if (!safety.safe) {
        return JSON.stringify({
          error: `content_file blocked: ${safety.reason}`,
        });
      }
      try {
        const { readFileSync } = await import("node:fs");
        content = readFileSync(contentFile, "utf-8");
      } catch {
        return JSON.stringify({
          error: `content_file not found: ${contentFile}`,
        });
      }
    } else {
      content = (args.content as string) ?? "";
    }

    if (!content && !fileId) {
      return JSON.stringify({
        error: "content or content_file is required for new files",
      });
    }

    const boundary = "jarvis_upload_boundary";

    try {
      if (fileId) {
        // UPDATE existing file — simple media upload
        const result = await googleFetch<{
          id: string;
          name: string;
          modifiedTime: string;
        }>(
          `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media&fields=id,name,modifiedTime`,
          {
            method: "PATCH",
            rawBody: content,
            contentType: mimeType,
          },
        );
        return JSON.stringify({
          updated: true,
          file_id: result.id,
          name: result.name,
          modified: result.modifiedTime,
        });
      }

      // CREATE new file — multipart/related (metadata + content)
      const metadata: Record<string, unknown> = { name, mimeType };
      if (parentFolderId) metadata.parents = [parentFolderId];

      const body =
        `--${boundary}\r\n` +
        `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
        `${JSON.stringify(metadata)}\r\n` +
        `--${boundary}\r\n` +
        `Content-Type: ${mimeType}\r\n\r\n` +
        `${content}\r\n` +
        `--${boundary}--`;

      const result = await googleFetch<{
        id: string;
        name: string;
        webViewLink: string;
      }>(
        `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink`,
        {
          method: "POST",
          rawBody: body,
          contentType: `multipart/related; boundary=${boundary}`,
        },
      );

      return JSON.stringify({
        created: true,
        file_id: result.id,
        name: result.name,
        url: result.webViewLink,
      });
    } catch (err) {
      return JSON.stringify({
        error: `Drive upload failed: ${err instanceof Error ? err.message : err}`,
      });
    }
  },
};

// ---------------------------------------------------------------------------
// gdrive_download
// ---------------------------------------------------------------------------

export const gdriveDownloadTool: Tool = {
  name: "gdrive_download",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "gdrive_download",
      description: `Download a file from Google Drive to the local VPS filesystem.

USE WHEN:
- The user shares a Drive URL (drive.google.com/file/d/<ID>/...) for a PDF, image, or other binary
- You need to read a Drive-hosted PDF — the flow is gdrive_download → pdf_read
- You need to read a Drive-hosted Google Doc/Slide/Sheet as PDF (auto-exports for native types)

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

Returns: { path, name, mimeType, sizeBytes, note? }`,
      parameters: {
        type: "object",
        properties: {
          file_id: {
            type: "string",
            description:
              "Drive file ID. Extract from drive.google.com/file/d/<ID>/... URLs, or get from gdrive_list.",
          },
          output_path: {
            type: "string",
            description:
              "Absolute path to write the file to. Must resolve under /tmp/jarvis-downloads/ or /root/claude/inbox/. Defaults to /tmp/jarvis-downloads/<file_id>.<ext>.",
          },
          export_format: {
            type: "string",
            enum: ["pdf", "docx", "pptx", "xlsx", "txt", "html", "csv", "png"],
            description:
              "For native Google Docs/Slides/Sheets only — choose export format. Ignored for binary files (PDF/PNG/ZIP). Default: pdf for docs/slides, xlsx for sheets.",
          },
        },
        required: ["file_id"],
      },
    },
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const fileId = args.file_id as string | undefined;
    const userOutputPath = args.output_path as string | undefined;
    const exportFormat = args.export_format as string | undefined;

    if (!fileId) {
      return JSON.stringify({ error: "file_id is required" });
    }

    try {
      // 1. Fetch metadata to learn name + mimeType + size
      const meta = await googleFetch<{
        id: string;
        name: string;
        mimeType: string;
        size?: string;
      }>(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
          fileId,
        )}?fields=id,name,mimeType,size`,
      );

      const isNative = meta.mimeType.startsWith("application/vnd.google-apps.");

      // 2. Decide path: native → export, binary → alt=media
      let downloadUrl: string;
      let resultMime: string;

      if (isNative) {
        const aliasMime = exportFormat
          ? EXPORT_FORMAT_ALIASES[exportFormat.toLowerCase()]
          : undefined;
        const fallback = NATIVE_EXPORT_DEFAULTS[meta.mimeType];
        const exportMime = aliasMime ?? fallback?.mimeType;
        if (!exportMime) {
          return JSON.stringify({
            error: `Cannot export ${meta.mimeType} — no default export format and no export_format provided. Try export_format: "pdf" or "txt".`,
          });
        }
        downloadUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
          fileId,
        )}/export?mimeType=${encodeURIComponent(exportMime)}`;
        resultMime = exportMime;
      } else {
        // Binary file — Drive size header tells us up front
        if (meta.size && Number(meta.size) > MAX_DOWNLOAD_BYTES) {
          return JSON.stringify({
            error: `File too large: ${meta.size} bytes exceeds 50 MB cap`,
          });
        }
        downloadUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
          fileId,
        )}?alt=media`;
        resultMime = meta.mimeType;
      }

      // 3. Resolve output path with whitelist + traversal + symlink defense
      const ext = extFromMime(resultMime);
      const requestedPath =
        userOutputPath ?? `/tmp/jarvis-downloads/${fileId}.${ext}`;

      const safety = validatePathSafety(requestedPath, "write");
      if (!safety.safe) {
        return JSON.stringify({
          error: `output_path blocked: ${safety.reason}`,
        });
      }

      const safeResolve = resolveSafeOutputPath(requestedPath);
      if (!safeResolve.safe) {
        return JSON.stringify({ error: safeResolve.reason });
      }
      const outputPath = safeResolve.path;

      // 4. Fetch bytes
      const bytes = await googleFetch<Uint8Array>(downloadUrl, {
        rawBytes: true,
        timeout: DOWNLOAD_TIMEOUT_MS,
      });

      if (bytes.byteLength > MAX_DOWNLOAD_BYTES) {
        return JSON.stringify({
          error: `Downloaded payload too large: ${bytes.byteLength} bytes exceeds 50 MB cap`,
        });
      }

      // 5. Write to disk
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, bytes);

      console.log(
        `[gdrive_download] file_id=${fileId} → ${outputPath} (${bytes.byteLength} bytes, ${resultMime})`,
      );

      const result: Record<string, unknown> = {
        path: outputPath,
        name: meta.name,
        mimeType: resultMime,
        sizeBytes: bytes.byteLength,
      };
      // W3: surface signal that export_format was discarded for binary files
      if (exportFormat && !isNative) {
        result.note = `export_format='${exportFormat}' ignored — file is already binary (${meta.mimeType})`;
      }
      return JSON.stringify(result);
    } catch (err) {
      console.log(
        `[gdrive_download] ERROR: ${err instanceof Error ? err.message : err}`,
      );
      return JSON.stringify({
        error: `Drive download failed: ${err instanceof Error ? err.message : err}`,
      });
    }
  },
};
