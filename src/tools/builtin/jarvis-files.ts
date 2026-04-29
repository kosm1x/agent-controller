/**
 * Jarvis file system tools — thin wrappers over src/db/jarvis-fs.ts.
 *
 * The infrastructure (upsertFile, getFile, mirrorToDisk, etc.) lives
 * in the DB layer. These tools just expose it to the LLM with ACI
 * descriptions and parameter validation.
 */

import type { Tool } from "../types.js";
import { toMexTime } from "../../lib/timezone.js";
import {
  getFile,
  upsertFile,
  appendToFile,
  updateMetadata,
  deleteFile,
  listFiles,
  moveFile,
  searchFiles,
} from "../../db/jarvis-fs.js";
import type { JarvisFile } from "../../db/jarvis-fs.js";
import { LARGE_FILE_THRESHOLD } from "../../config/constants.js";
import {
  parseLineRanges,
  extractLineRanges,
  buildOutline,
  countLines,
  PREVIEW_CHARS,
} from "../../lib/file-slicing.js";

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

LARGE FILE BEHAVIOR (>${LARGE_FILE_THRESHOLD} chars):
When the file is large AND you don't pass \`lines\`, this tool returns a structured envelope
INSTEAD of the full content:
  { truncated: true, total_chars, total_lines, outline: [...headings with line numbers...],
    preview: <first ~${PREVIEW_CHARS} chars>, next_steps: [...] }
The preview is the first ~${PREVIEW_CHARS} chars only — DO NOT infer the file's content from it.
Read the outline (each heading is prefixed with its line number, e.g. "L42: # Section"),
decide which sections matter, then call again with \`lines='42-90'\` for each one.

WORKFLOW for large files:
  1. jarvis_file_read(path="logs/day-logs/2026-04-04.md")  → {truncated, outline, preview}
  2. From the outline, pick sections of interest (line ranges)
  3. jarvis_file_read(path="...", lines="200-350")  → exact slice you need

For small files (≤${LARGE_FILE_THRESHOLD} chars), the full content is returned as before;
\`total_chars\` is included so you always know the file size.

RETURNS: File content + metadata (tags, qualifier, priority, related files), with
\`total_chars\` always present. If searching by tags, returns all matching files with previews.

AFTER READING: When reporting data from this file, cite the path. If the data is time-sensitive, note when it was last updated.`,
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              'Virtual file path (e.g. "directives/core.md", "projects/cuatro-flor/README.md"). Omit to search by tags.',
          },
          lines: {
            type: "string",
            description:
              "Read only specific line ranges. Format: 'N-M' (single range, e.g. '1-200'), 'N' (single line, e.g. '42'), or comma-separated multiple ranges (e.g. '1-50,200-250'). Lines are 1-indexed and inclusive. Out-of-range ends are clamped to the file size. Maximum 2000 lines per call (response sets `line_capped: true` if hit — paginate by issuing follow-up calls with non-overlapping ranges). Use this on large files after reading the outline returned by an unscoped call.",
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
    // Coerce — LLM occasionally passes lines as a number; raw cast would mask
    // that as a runtime TypeError on .trim() (qa W3).
    const linesSpec = args.lines == null ? undefined : String(args.lines);

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

      const totalChars = file.content.length;
      const totalLines = countLines(file.content);

      // Branch A: caller asked for a specific slice → return that slice + meta
      if (linesSpec !== undefined) {
        let ranges;
        try {
          ranges = parseLineRanges(linesSpec);
        } catch (err) {
          return JSON.stringify({
            error: `Invalid lines spec: ${err instanceof Error ? err.message : err}`,
          });
        }
        const { slice, sliceLines, clamped, lineCapped } = extractLineRanges(
          file.content,
          ranges,
        );
        return JSON.stringify({
          path: file.path,
          title: file.title,
          content: slice,
          lines: linesSpec,
          slice_lines: sliceLines,
          total_chars: totalChars,
          total_lines: totalLines,
          ...(clamped && { clamped: true }),
          ...(lineCapped && { line_capped: true }),
          tags: JSON.parse(file.tags),
          qualifier: file.qualifier,
          condition: file.condition,
          priority: file.priority,
          related,
          updatedAt: toMexTime(file.updated_at),
        });
      }

      // Branch B: large file with no slice asked → return structured envelope
      // (truncated flag at the TOP of the JSON, outline with line numbers, small preview)
      if (totalChars > LARGE_FILE_THRESHOLD) {
        const outline = buildOutline(file.content);
        return JSON.stringify({
          path: file.path,
          title: file.title,
          truncated: true,
          total_chars: totalChars,
          total_lines: totalLines,
          outline,
          preview: file.content.slice(0, PREVIEW_CHARS),
          next_steps: [
            `File is ${totalChars} chars / ${totalLines} lines — full content NOT returned.`,
            `Pick a section from \`outline\` (each entry has its line number) and call again with lines='START-END' to read the slice.`,
            `Example: jarvis_file_read(path="${file.path}", lines="1-200")`,
          ],
          tags: JSON.parse(file.tags),
          qualifier: file.qualifier,
          condition: file.condition,
          priority: file.priority,
          related,
          updatedAt: toMexTime(file.updated_at),
        });
      }

      // Branch C: small file → full content + total_chars (existing shape + meta)
      return JSON.stringify({
        path: file.path,
        title: file.title,
        content: file.content,
        total_chars: totalChars,
        total_lines: totalLines,
        tags: JSON.parse(file.tags),
        qualifier: file.qualifier,
        condition: file.condition,
        priority: file.priority,
        related,
        updatedAt: toMexTime(file.updated_at),
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
      description: `Create or overwrite a file in the Jarvis Knowledge Base.

USE WHEN:
- You learn something about a person, project, or domain → write to knowledge/
- New project info → projects/{slug}/README.md or projects/{slug}/notes/
- User preferences or personal data → knowledge/preferences/ or knowledge/people/
- SOPs or procedures → knowledge/procedures/
- Decision records → logs/decisions/

PATHS — follow the hierarchy:
- "directives/*.md" — standing orders (enforce). DO NOT create new ones without user approval.
- "NorthStar/**/*.md" — visions, goals, objectives, tasks. Leave \`COMMIT_ID:\` empty for new items; the next northstar_sync run POSTs them to COMMIT and fills in the generated UUID. For goals/objectives/tasks, include a parent reference line (\`Vision: <title|uuid>\`, \`Goal: <title|uuid>\`, \`Objective: <title|uuid>\`) — sync resolves the parent before POSTing. COMMIT and NorthStar are peers; local writes stay local until the user invokes northstar_sync — do NOT call it automatically after every write.
- "projects/{slug}/*.md" — project-specific files. README.md in each project.
- "knowledge/people/*.md" — contacts, relationships
- "knowledge/procedures/*.md" — SOPs, protocols
- "knowledge/preferences/*.md" — user preferences
- "knowledge/domain/*.md" — domain knowledge
- "logs/day-logs/*.md" — daily interaction logs (mechanical, don't write manually)
- "logs/sessions/*.md" — auto-persist session data (mechanical, don't write manually)
- "logs/decisions/*.md" — decision records
- "inbox/*.md" — new info to process

QUALIFIERS:
- "enforce" — MANDATORY rules (auto-injected, prefix "MANDATORY:")
- "always-read" — Auto-injected every task (use VERY sparingly — budget is tight)
- "reference" — Available via jarvis_file_read (DEFAULT — use this for most files)
- "workspace" — Scratch space for ongoing work

AFTER WRITING: Report what you did — path, title, qualifier. If updating an existing file, mention what changed.`,
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              'File path ending in .md. Follow the hierarchy: "projects/my-project/README.md", "knowledge/people/name.md", etc.',
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
              "conditional",
              "reference",
              "workspace",
              "enforce",
            ],
            description:
              'How this file should be used. Default: reference. "enforce" is silently downgraded to "reference" — enforce is reserved for user-created directives.',
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
    let qualifier = (args.qualifier as string) ?? "reference";
    const condition = (args.condition as string) ?? null;
    const priority = (args.priority as number) ?? 50;
    const relatedTo = (args.related_to as string[]) ?? [];

    // Prevent LLM from self-promoting files to enforce — reserved for user
    if (qualifier === "enforce") {
      qualifier = "reference";
    }

    if (!path.endsWith(".md")) {
      return JSON.stringify({ error: "All files must end with .md" });
    }

    // Mechanically managed paths — LLM cannot overwrite. `appendDayLog()`
    // in router.ts is the sole writer for `logs/day-logs/`. Curated
    // narratives belong under `logs/day-narratives/`.
    if (path.startsWith("logs/day-logs/")) {
      return JSON.stringify({
        error:
          "logs/day-logs/ is mechanically managed (verbatim interaction log). Write the narrative companion to logs/day-narratives/ instead.",
      });
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
    let qualifier = args.qualifier as string | undefined;
    const priority = args.priority as number | undefined;

    // Prevent LLM from self-promoting files to enforce — reserved for user
    if (qualifier === "enforce") {
      qualifier = "reference";
    }

    // Mechanically managed paths — LLM cannot append to the raw day log.
    if (path.startsWith("logs/day-logs/")) {
      return JSON.stringify({
        error:
          "logs/day-logs/ is mechanically managed (verbatim interaction log). Append narrative to logs/day-narratives/ instead.",
      });
    }

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
- You need to check which files are auto-injected (always-read/enforce)

NAVIGATION GUIDE — use these prefixes:
- "projects/" — all active project folders (README.md in each)
- "NorthStar/visions/" / "NorthStar/goals/" / "NorthStar/objectives/" / "NorthStar/tasks/" — goal hierarchy
- "knowledge/people/" — contacts and relationships
- "knowledge/procedures/" — SOPs
- "directives/" — enforce rules (don't modify)

TIP: If you know WHAT you're looking for but not WHERE, use jarvis_file_search instead — it searches content, not just paths.`,
      parameters: {
        type: "object",
        properties: {
          prefix: {
            type: "string",
            description:
              'Filter by path prefix (e.g. "projects/", "knowledge/", "logs/")',
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
    // Pre-formatted: file listing with path, size, qualifier
    if (results.length === 0) return "📂 No files found.";
    const lines = [`📂 **${results.length} files**`];
    for (const f of results) {
      const sizeStr =
        f.size > 1024 ? `${(f.size / 1024).toFixed(1)}K` : `${f.size}B`;
      lines.push(`  ${f.path} (${sizeStr}, ${f.qualifier})`);
    }
    return lines.join("\n");
  },
};

export const jarvisFileDeleteTool: Tool = {
  name: "jarvis_file_delete",
  requiresConfirmation: true,
  deferred: true, // S5: precious paths need user confirmation
  definition: {
    type: "function",
    function: {
      name: "jarvis_file_delete",
      description: `Delete a file from your knowledge base.

USE WHEN:
- A file is outdated and no longer relevant
- You're cleaning up workspace files after completing a task

CAUTION: Files in knowledge/, projects/, NorthStar/, directives/ require user confirmation.
First call returns CONFIRMATION_REQUIRED — present the file to the user, ask to confirm.
After user confirms, call again with confirmed:true to proceed.`,
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path of the file to delete",
          },
          confirmed: {
            type: "boolean",
            description:
              "Set to true after user has confirmed deletion of a precious file",
          },
        },
        required: ["path"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const path = args.path as string;
    const confirmed = args.confirmed === true;

    // S5: Precious path protection — require confirmation for valuable KB content
    if (!confirmed) {
      const { isPreciousPath } = await import("./immutable-core.js");
      const precious = isPreciousPath(path);
      if (precious.precious) {
        return JSON.stringify({
          error: "CONFIRMATION_REQUIRED",
          message: `This file is in a protected area (${precious.reason}). Present the file path to the user and ask: '¿Lo elimino?' After confirmation, call again with confirmed:true.`,
          path,
        });
      }
    }

    const deleted = deleteFile(path);
    if (!deleted) {
      return JSON.stringify({ error: `File not found: ${path}` });
    }
    return JSON.stringify({ success: true, deleted: path });
  },
};

export const jarvisFileMoveTool: Tool = {
  name: "jarvis_file_move",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "jarvis_file_move",
      description: `Move/rename a file in your knowledge base. Atomic operation — content never passes through the LLM.

USE WHEN:
- Reorganizing the file system (moving files between directories)
- Renaming a file to a better path
- Migrating files from old paths to new ones

THIS IS A TRANSPORT OPERATION — use it instead of jarvis_file_read + jarvis_file_write when you only need to move a file without modifying its content. It's faster and doesn't consume context.

For batch moves, call this tool multiple times (one per file).`,
      parameters: {
        type: "object",
        properties: {
          old_path: {
            type: "string",
            description: "Current file path",
          },
          new_path: {
            type: "string",
            description: "Destination file path",
          },
        },
        required: ["old_path", "new_path"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const oldPath = args.old_path as string;
    const newPath = args.new_path as string;
    if (!oldPath || !newPath)
      return JSON.stringify({ error: "old_path and new_path are required" });

    const moved = moveFile(oldPath, newPath);
    if (!moved) {
      return JSON.stringify({ error: `File not found: ${oldPath}` });
    }
    return JSON.stringify({ success: true, moved: `${oldPath} → ${newPath}` });
  },
};

export const jarvisFileSearchTool: Tool = {
  name: "jarvis_file_search",
  definition: {
    type: "function",
    function: {
      name: "jarvis_file_search",
      description: `Search across ALL files in your Knowledge Base by keyword. Searches file content, titles, and paths.

USE WHEN:
- You need to find which files mention a topic, project, person, or concept
- jarvis_file_list found nothing by path but you suspect the info exists somewhere
- User asks "qué sabes sobre X?" or "dónde hay info de X?"
- PREFER THIS over jarvis_file_list when you know WHAT you want but not WHERE it is

Returns: matching file paths + short snippet around the match. Does NOT return full content — use jarvis_file_read on specific results to get details.

WORKFLOW: search → pick best match → jarvis_file_read to get full content. Never narrate from snippet alone.`,
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Keyword to search for in file content, titles, and paths",
          },
          limit: {
            type: "number",
            description: "Max results (default: 15)",
          },
        },
        required: ["query"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const query = args.query as string;
    if (!query) return JSON.stringify({ error: "query is required" });

    const limit = Math.min(Math.max(Number(args.limit) || 15, 1), 30);
    const results = searchFiles(query, limit);

    if (results.length === 0) {
      return `No files found matching "${query}" in the Knowledge Base.`;
    }

    const lines = [`🔍 ${results.length} files matching "${query}":`, ""];
    for (const r of results) {
      lines.push(`[${r.path}] (${r.size} bytes)`);
      lines.push(`  ${r.snippet}`);
      lines.push("");
    }
    return lines.join("\n");
  },
};
