/**
 * Google Drive tools — list, create, share, and delete files.
 */

import type { Tool } from "../types.js";
import { googleFetch } from "../../google/client.js";

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
  definition: {
    type: "function",
    function: {
      name: "gdrive_list",
      description: `List or search files in Google Drive.

USE WHEN:
- The user asks to see their files, find a document, or check what's in Drive
- You need to find a file ID for subsequent operations (read, share)

Supports Drive search queries: name contains 'X', mimeType='application/...', modifiedTime > '2026-01-01'`,
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Drive search query (optional). E.g., \"name contains 'report'\" or leave empty for recent files",
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
    const maxResults = Math.min(
      Math.max((args.max_results as number) ?? 10, 1),
      20,
    );

    try {
      let url = `https://www.googleapis.com/drive/v3/files?pageSize=${maxResults}&fields=files(id,name,mimeType,modifiedTime,webViewLink)&orderBy=modifiedTime desc`;
      if (query) url += `&q=${encodeURIComponent(query)}`;

      const result = await googleFetch<{
        files: Array<{
          id: string;
          name: string;
          mimeType: string;
          modifiedTime: string;
          webViewLink: string;
        }>;
      }>(url);

      return JSON.stringify({
        files: result.files.map((f) => ({
          id: f.id,
          name: f.name,
          type: f.mimeType.replace("application/vnd.google-apps.", ""),
          modified: f.modifiedTime,
          url: f.webViewLink,
        })),
        total: result.files.length,
      });
    } catch (err) {
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
