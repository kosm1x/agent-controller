/**
 * Jarvis internal file system — persistent knowledge base tools.
 *
 * Gives Jarvis structured, taggable, priority-ordered files that persist
 * across sessions. Files with qualifier "always-read" or "enforce" are
 * auto-injected into the system prompt. Files with "conditional" are
 * injected when their condition matches the active scope.
 *
 * All files are Markdown (.md). SQLite is source of truth; filesystem
 * mirror at data/jarvis/ for human inspection.
 */

import type { Tool } from "../types.js";
import { getDatabase } from "../../db/index.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

const MIRROR_DIR = join(process.cwd(), "data", "jarvis");

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

interface JarvisFile {
  id: string;
  path: string;
  title: string;
  content: string;
  tags: string;
  qualifier: string;
  condition: string | null;
  priority: number;
  related_to: string;
  created_at: string;
  updated_at: string;
}

function mirrorToDisk(path: string, content: string): void {
  try {
    const fullPath = join(MIRROR_DIR, path);
    // Defense-in-depth: block path traversal
    if (!fullPath.startsWith(MIRROR_DIR)) return;
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, "utf-8");
  } catch {
    // Non-fatal — SQLite is source of truth
  }
}

/** Use path as ID — no derived transformation, no collision risk. */
function pathToId(path: string): string {
  return path;
}

// ---------------------------------------------------------------------------
// Query functions (exported for auto-injection)
// ---------------------------------------------------------------------------

/** Get files by qualifier, ordered by priority. */
export function getFilesByQualifier(...qualifiers: string[]): Array<{
  path: string;
  title: string;
  content: string;
  qualifier: string;
  condition: string | null;
  priority: number;
}> {
  const db = getDatabase();
  const placeholders = qualifiers.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT path, title, content, qualifier, condition, priority
       FROM jarvis_files
       WHERE qualifier IN (${placeholders})
       ORDER BY priority ASC, created_at ASC`,
    )
    .all(...qualifiers) as Array<{
    path: string;
    title: string;
    content: string;
    qualifier: string;
    condition: string | null;
    priority: number;
  }>;
}

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
    const db = getDatabase();
    const path = args.path as string | undefined;
    const tags = args.tags as string[] | undefined;

    if (path) {
      const file = db
        .prepare("SELECT * FROM jarvis_files WHERE path = ?")
        .get(path) as JarvisFile | undefined;

      if (!file) {
        return JSON.stringify({ error: `File not found: ${path}` });
      }

      // Also fetch related files (1 hop)
      let related: Array<{ path: string; title: string }> = [];
      try {
        const relatedIds = JSON.parse(file.related_to) as string[];
        if (relatedIds.length > 0) {
          const ph = relatedIds.map(() => "?").join(",");
          related = db
            .prepare(`SELECT path, title FROM jarvis_files WHERE id IN (${ph})`)
            .all(...relatedIds) as Array<{ path: string; title: string }>;
        }
      } catch {
        /* ignore malformed JSON */
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
      // Search by tags using JSON containment
      const all = db
        .prepare(
          "SELECT path, title, tags, qualifier, priority, substr(content, 1, 200) as preview FROM jarvis_files ORDER BY priority ASC",
        )
        .all() as Array<{
        path: string;
        title: string;
        tags: string;
        qualifier: string;
        priority: number;
        preview: string;
      }>;

      const matches = all.filter((f) => {
        try {
          const fileTags = JSON.parse(f.tags) as string[];
          return tags.some((t) => fileTags.includes(t));
        } catch {
          return false;
        }
      });

      return JSON.stringify({ results: matches, total: matches.length });
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
              'File path ending in .md (e.g. "DIRECTIVES.md", "context/user-profile.md", "schedules/active.md")',
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
            description:
              'Tags for categorization and search. Example: ["directive", "always-read", "persona"]',
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
              'When qualifier is "conditional": describe when to inject. Example: "when CRM context active"',
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
    const db = getDatabase();
    const path = args.path as string;
    const title = args.title as string;
    const content = args.content as string;
    const tags = (args.tags as string[]) ?? [];
    const qualifier = (args.qualifier as string) ?? "reference";
    const condition = (args.condition as string) ?? null;
    const priority = (args.priority as number) ?? 50;
    const relatedPaths = (args.related_to as string[]) ?? [];

    if (!path.endsWith(".md")) {
      return JSON.stringify({
        error: "All files must end with .md",
      });
    }

    const id = pathToId(path);

    // Resolve related paths to IDs
    const relatedIds = relatedPaths.map(pathToId);

    db.prepare(
      `INSERT INTO jarvis_files (id, path, title, content, tags, qualifier, condition, priority, related_to, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         path = excluded.path,
         title = excluded.title,
         content = excluded.content,
         tags = excluded.tags,
         qualifier = excluded.qualifier,
         condition = excluded.condition,
         priority = excluded.priority,
         related_to = excluded.related_to,
         updated_at = datetime('now')`,
    ).run(
      id,
      path,
      title,
      content,
      JSON.stringify(tags),
      qualifier,
      condition,
      priority,
      JSON.stringify(relatedIds),
    );

    mirrorToDisk(path, content);

    return JSON.stringify({
      success: true,
      path,
      id,
      qualifier,
      priority,
    });
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
            description:
              "Replace tags (if provided). Omit to keep existing tags.",
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
    const db = getDatabase();
    const path = args.path as string;

    const existing = db
      .prepare("SELECT * FROM jarvis_files WHERE path = ?")
      .get(path) as JarvisFile | undefined;

    if (!existing) {
      return JSON.stringify({ error: `File not found: ${path}` });
    }

    const append = args.append as string | undefined;
    const tags = args.tags as string[] | undefined;
    const qualifier = args.qualifier as string | undefined;
    const priority = args.priority as number | undefined;

    const newContent = append
      ? `${existing.content}\n\n${append}`
      : existing.content;
    const newTags = tags ? JSON.stringify(tags) : existing.tags;
    const newQualifier = qualifier ?? existing.qualifier;
    const newPriority = priority ?? existing.priority;

    db.prepare(
      `UPDATE jarvis_files
       SET content = ?, tags = ?, qualifier = ?, priority = ?, updated_at = datetime('now')
       WHERE path = ?`,
    ).run(newContent, newTags, newQualifier, newPriority, path);

    mirrorToDisk(path, newContent);

    return JSON.stringify({
      success: true,
      path,
      contentLength: newContent.length,
      qualifier: newQualifier,
      priority: newPriority,
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
    const db = getDatabase();
    const prefix = args.prefix as string | undefined;
    const qualifier = args.qualifier as string | undefined;
    const tags = args.tags as string[] | undefined;

    let sql =
      "SELECT path, title, tags, qualifier, priority, length(content) as size, updated_at FROM jarvis_files";
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (prefix) {
      conditions.push("path LIKE ?");
      params.push(`${prefix}%`);
    }
    if (qualifier) {
      conditions.push("qualifier = ?");
      params.push(qualifier);
    }

    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }
    sql += " ORDER BY priority ASC, path ASC";

    let results = db.prepare(sql).all(...params) as Array<{
      path: string;
      title: string;
      tags: string;
      qualifier: string;
      priority: number;
      size: number;
      updated_at: string;
    }>;

    // Post-filter by tags (JSON containment)
    if (tags && tags.length > 0) {
      results = results.filter((f) => {
        try {
          const fileTags = JSON.parse(f.tags) as string[];
          return tags.some((t) => fileTags.includes(t));
        } catch {
          return false;
        }
      });
    }

    return JSON.stringify({
      files: results.map((r) => ({
        ...r,
        tags: JSON.parse(r.tags),
      })),
      total: results.length,
    });
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

CAUTION: This permanently removes the file. Consider updating qualifier to "workspace" first if unsure.`,
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
    const db = getDatabase();
    const path = args.path as string;

    const existing = db
      .prepare("SELECT id FROM jarvis_files WHERE path = ?")
      .get(path) as { id: string } | undefined;

    if (!existing) {
      return JSON.stringify({ error: `File not found: ${path}` });
    }

    db.prepare("DELETE FROM jarvis_files WHERE path = ?").run(path);

    return JSON.stringify({ success: true, deleted: path });
  },
};
