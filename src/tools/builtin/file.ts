/**
 * File read/write tools.
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, extname } from "path";
import type { Tool } from "../types.js";

const MAX_READ = 50_000; // chars

/** Convert .docx to plain text using mammoth (lazy-loaded). */
async function readDocx(filePath: string): Promise<string> {
  const mammoth = await import("mammoth");
  const result = await mammoth.default.extractRawText({ path: filePath });
  return result.value;
}

export const fileReadTool: Tool = {
  name: "file_read",
  definition: {
    type: "function",
    function: {
      name: "file_read",
      description:
        "Read the contents of a file. Returns the file content as text. Supports plain text files and .docx (Word documents).",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute or relative file path to read",
          },
        },
        required: ["path"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const path = (args.path ?? args.file_path ?? args.filepath) as string;
    if (!path) {
      return JSON.stringify({ error: "path is required" });
    }

    try {
      let content: string;
      if (extname(path).toLowerCase() === ".docx") {
        content = await readDocx(path);
      } else {
        content = readFileSync(path, "utf-8");
      }
      const trimmed =
        content.length > MAX_READ
          ? content.slice(0, MAX_READ) +
            `\n... (truncated, ${content.length} total chars)`
          : content;
      return JSON.stringify({ path, content: trimmed, size: content.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ error: message });
    }
  },
};

export const fileWriteTool: Tool = {
  name: "file_write",
  definition: {
    type: "function",
    function: {
      name: "file_write",
      description: `Write content to a file. Creates parent directories if needed. Overwrites existing files.

For large content that was salvaged from a truncated tool call, pass content_file=<salvage path>
instead of inline content. The tool reads the salvaged file and writes it to the target path.`,
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute or relative file path to write",
          },
          content: {
            type: "string",
            description:
              "Content to write. For large documents, use content_file instead.",
          },
          content_file: {
            type: "string",
            description:
              "Path to a file whose contents will be written to path. Use instead of content for large documents.",
          },
        },
        required: ["path"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const path = (args.path ?? args.file_path ?? args.filepath) as string;
    const contentFile = args.content_file as string | undefined;
    let content: string;

    if (contentFile) {
      try {
        content = readFileSync(contentFile, "utf-8");
      } catch {
        return JSON.stringify({
          error: `content_file not found: ${contentFile}`,
        });
      }
    } else {
      content = args.content as string;
    }

    if (!path) {
      return JSON.stringify({ error: "path is required" });
    }
    if (content === undefined || content === null) {
      return JSON.stringify({
        error: "Either content or content_file is required.",
      });
    }

    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content, "utf-8");
      return JSON.stringify({
        path,
        bytes_written: Buffer.byteLength(content, "utf-8"),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ error: message });
    }
  },
};
