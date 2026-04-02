/**
 * Jarvis file system tools — thin wrappers over src/db/jarvis-fs.ts.
 *
 * The infrastructure (upsertFile, getFile, mirrorToDisk, etc.) lives
 * in the DB layer. These tools just expose it to the LLM with ACI
 * descriptions and parameter validation.
 */

import type { Tool } from "../types.js";
import {
  getFile,
  upsertFile,
  appendToFile,
  updateMetadata,
  deleteFile,
  listFiles,
} from "../../db/jarvis-fs.js";
import type { JarvisFile } from "../../db/jarvis-fs.js";

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export const jarvisFileReadTool: Tool = {
  name: "jarvis_file_read",
  definition: {
    type: "function",
    function: {
      name: "jarvis_file_read",
      description: `Read a file from your internal knowledge base by path, or search by tags.

USE WHEN:
- You need to recall your directives, SOPs, or behavioral rules
- You need context about a project, client, or schedule
- You want to check what you've stored about a topic

RETURNS: File content + metadata (tags, qualifier, priority, related files).
If searching by tags, returns all matching files with previews.`,
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              'Virtual file path (e.g. "DIRECTIVES.md", "context/crm-pipeline.md"). Omit to search by tags.',
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description:
              'Search by tags. Returns files matching ANY tag. Example: ["crm", "directive"]',
          },
        },
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const path = args.path as string | undefined;
    const tags = args.tags as string[] | undefined;

    if (path) {
      const file = getFile(path);
      if (!file) {
        return JSON.stringify({ error: `File not found: ${path}` });
      }

      // Fetch related files (1 hop)
      let related: Array<{ path: string; title: string }> = [];
      try {
        const relatedIds = JSON.parse(file.related_to) as string[];
        if (relatedIds.length > 0) {
          related = relatedIds
            .map((rid) => getFile(rid))
            .filter((f): f is JarvisFile => f !== null)
            .map((f) => ({ path: f.path, title: f.title }));
        }
      } catch {
        /* ignore */
      }

      return JSON.stringify({
        path: file.path,
        title: file.title,
        content: file.content,
        tags: JSON.parse(file.tags),
        qualifier: file.qualifier,
        condition: file.condition,
        priority: file.priority,
        related,
        updatedAt: file.updated_at,
      });
    }

    if (tags && tags.length > 0) {
      const matches = listFiles({ tags });
      return JSON.stringify({
        results: matches.map((f) => ({
          ...f,
          preview: undefined, // size is enough for listing
        })),
        total: matches.length,
      });
    }

    return JSON.stringify({
      error: "Provide either path or tags to read files.",
    });
  },
};

export const jarvisFileWriteTool: Tool = {
  name: "jarvis_file_write",
  definition: {
    type: "function",
    function: {
      name: "jarvis_file_write",
      description: `Create or overwrite a file in your internal knowledge base.

USE WHEN:
- You learn something important about the user, a project, or a procedure
- You need to store directives or SOPs for future reference
- You're organizing information for structured retrieval

ALL FILES MUST BE MARKDOWN (.md). Use descriptive paths like "context/crm-pipeline.md".

QUALIFIERS:
- "enforce" — MANDATORY rules. Injected with "MANDATORY:" prefix every task.
- "always-read" — Important context. Auto-injected every task (use sparingly).
- "conditional" — Injected when condition matches scope (e.g. "when CRM context active").
- "reference" — Available via jarvis_file_read but not auto-injected.
- "workspace" — Scratch space for ongoing work.`,
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              'File path ending in .md (e.g. "DIRECTIVES.md", "context/user-profile.md")',
          },
          title: {
            type: "string",
            description: "Human-readable title for the file",
          },
          content: {
            type: "string",
            description: "Full Markdown content of the file",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Tags for categorization and search.",
          },
          qualifier: {
            type: "string",
            enum: [
              "always-read",
              "enforce",
              "conditional",
              "reference",
              "workspace",
            ],
            description: "How this file should be used. Default: reference",
          },
          condition: {
            type: "string",
            description:
              'When qualifier is "conditional": describe when to inject.',
          },
          priority: {
            type: "number",
            description:
              "Read order priority (0=highest, 100=lowest). Default: 50",
          },
          related_to: {
            type: "array",
            items: { type: "string" },
            description: "Paths of related files for semantic retrieval chains",
          },
        },
        required: ["path", "title", "content"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const path = args.path as string;
    const title = args.title as string;
    const content = args.content as string;
    const tags = (args.tags as string[]) ?? [];
    const qualifier = (args.qualifier as string) ?? "reference";
    const condition = (args.condition as string) ?? null;
    const priority = (args.priority as number) ?? 50;
    const relatedTo = (args.related_to as string[]) ?? [];

    if (!path.endsWith(".md")) {
      return JSON.stringify({ error: "All files must end with .md" });
    }

    upsertFile(
      path,
      title,
      content,
      tags,
      qualifier,
      priority,
      condition,
      relatedTo,
    );

    return JSON.stringify({ success: true, path, qualifier, priority });
  },
};

export const jarvisFileUpdateTool: Tool = {
  name: "jarvis_file_update",
  definition: {
    type: "function",
    function: {
      name: "jarvis_file_update",
      description: `Append content to an existing file, or update its metadata (tags, qualifier, priority).

USE WHEN:
- You need to add new information to an existing file without rewriting it
- You want to change a file's qualifier or priority
- You're building up a document incrementally`,
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path of the file to update",
          },
          append: {
            type: "string",
            description: "Markdown content to append to the end of the file",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Replace tags (if provided).",
          },
          qualifier: {
            type: "string",
            enum: [
              "always-read",
              "enforce",
              "conditional",
              "reference",
              "workspace",
            ],
            description: "Change qualifier (if provided)",
          },
          priority: {
            type: "number",
            description: "Change priority (if provided)",
          },
        },
        required: ["path"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const path = args.path as string;
    const append = args.append as string | undefined;
    const tags = args.tags as string[] | undefined;
    const qualifier = args.qualifier as string | undefined;
    const priority = args.priority as number | undefined;

    const existing = getFile(path);
    if (!existing) {
      return JSON.stringify({ error: `File not found: ${path}` });
    }

    if (append) {
      appendToFile(path, append);
    }

    // Update metadata if provided
    if (tags || qualifier || priority !== undefined) {
      updateMetadata(path, {
        tags: tags ?? undefined,
        qualifier: qualifier ?? undefined,
        priority: priority ?? undefined,
      });
    }

    const updated = getFile(path);
    return JSON.stringify({
      success: true,
      path,
      contentLength: updated?.content.length ?? 0,
      qualifier: updated?.qualifier,
      priority: updated?.priority,
    });
  },
};

export const jarvisFileListTool: Tool = {
  name: "jarvis_file_list",
  definition: {
    type: "function",
    function: {
      name: "jarvis_file_list",
      description: `List files in your knowledge base, optionally filtered by tags, qualifier, or path prefix.

USE WHEN:
- You want to see what's in your knowledge base
- You're looking for files on a topic
- You need to check which files are auto-injected (always-read/enforce)`,
      parameters: {
        type: "object",
        properties: {
          prefix: {
            type: "string",
            description:
              'Filter by path prefix (e.g. "context/", "schedules/")',
          },
          qualifier: {
            type: "string",
            enum: [
              "always-read",
              "enforce",
              "conditional",
              "reference",
              "workspace",
            ],
            description: "Filter by qualifier",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Filter by tags (ANY match)",
          },
        },
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const results = listFiles({
      prefix: args.prefix as string | undefined,
      qualifier: args.qualifier as string | undefined,
      tags: args.tags as string[] | undefined,
    });
    return JSON.stringify({ files: results, total: results.length });
  },
};

export const jarvisFileDeleteTool: Tool = {
  name: "jarvis_file_delete",
  definition: {
    type: "function",
    function: {
      name: "jarvis_file_delete",
      description: `Delete a file from your knowledge base.

USE WHEN:
- A file is outdated and no longer relevant
- You're cleaning up workspace files after completing a task

CAUTION: This permanently removes the file.`,
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path of the file to delete",
          },
        },
        required: ["path"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const path = args.path as string;
    const deleted = deleteFile(path);
    if (!deleted) {
      return JSON.stringify({ error: `File not found: ${path}` });
    }
    return JSON.stringify({ success: true, deleted: path });
  },
};
