/**
 * Google Drive tools — list, create, and share files.
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
