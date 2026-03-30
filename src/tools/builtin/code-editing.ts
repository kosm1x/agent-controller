/**
 * Code editing tool — string-replacement based file editing.
 *
 * Adapted from open-swe/deepagents edit_file pattern: the LLM specifies an
 * exact `old_string` to find in the file and a `new_string` to replace it with.
 * The old_string must be unique (unless replace_all is set) so the edit is
 * deterministic and reviewable.
 *
 * This is strictly better than file_write for code changes because it:
 *   - Forces the LLM to read the file first (it needs the exact old text)
 *   - Produces minimal diffs instead of rewriting entire files
 *   - Prevents accidental truncation of large files
 *   - Makes mistakes obvious (non-unique matches → error)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import type { Tool } from "../types.js";

export const fileEditTool: Tool = {
  name: "file_edit",
  definition: {
    type: "function",
    function: {
      name: "file_edit",
      description: `Edit a file by replacing an exact string match with new content. Preferred over file_write for modifying existing files — produces minimal diffs and prevents accidental truncation.

WORKFLOW:
1. Use file_read to see the current content
2. Copy the exact text you want to change into old_string (whitespace-sensitive)
3. Put the replacement in new_string
4. The old_string must appear exactly ONCE in the file (unless replace_all=true)

RULES:
- old_string must match the file content EXACTLY (including indentation, newlines)
- If old_string is not found → error (you probably have stale content — re-read the file)
- If old_string appears multiple times → error (provide more surrounding context to make it unique, or set replace_all=true)
- To insert text, use old_string as an anchor point and include it in new_string with the addition
- To delete text, set new_string to empty string ""`,
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute path to the file to edit",
          },
          old_string: {
            type: "string",
            description:
              "The exact text to find and replace. Must be unique in the file unless replace_all is true.",
          },
          new_string: {
            type: "string",
            description:
              "The replacement text. Use empty string to delete the matched text.",
          },
          replace_all: {
            type: "boolean",
            description:
              "If true, replace ALL occurrences of old_string. Default: false (requires unique match).",
          },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const path = (args.path ?? args.file_path ?? args.filepath) as string;
    const oldString = (args.old_string ?? args.oldString) as string;
    const newString = (args.new_string ?? args.newString) as string;
    const replaceAll = args.replace_all === true;

    if (!path) return JSON.stringify({ error: "path is required" });
    if (oldString === undefined || oldString === null)
      return JSON.stringify({ error: "old_string is required" });
    if (newString === undefined || newString === null)
      return JSON.stringify({ error: "new_string is required" });
    if (oldString === newString)
      return JSON.stringify({
        error: "old_string and new_string are identical — no change needed",
      });

    try {
      if (!existsSync(path)) {
        return JSON.stringify({ error: `File not found: ${path}` });
      }

      const content = readFileSync(path, "utf-8");
      const occurrences = content.split(oldString).length - 1;

      if (occurrences === 0) {
        // Help the LLM debug: show a snippet around where it might have expected the match
        return JSON.stringify({
          error:
            "old_string not found in file. Re-read the file to get the current content.",
          file_length: content.length,
          hint: "Check for whitespace differences (tabs vs spaces, trailing newlines).",
        });
      }

      if (occurrences > 1 && !replaceAll) {
        return JSON.stringify({
          error: `old_string found ${occurrences} times. Include more surrounding context to make it unique, or set replace_all=true.`,
          occurrences,
        });
      }

      let newContent: string;
      if (replaceAll) {
        newContent = content.split(oldString).join(newString);
      } else {
        // Replace only the first (and only) occurrence
        const idx = content.indexOf(oldString);
        newContent =
          content.slice(0, idx) +
          newString +
          content.slice(idx + oldString.length);
      }

      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, newContent, "utf-8");

      return JSON.stringify({
        path,
        replacements: replaceAll ? occurrences : 1,
        old_length: content.length,
        new_length: newContent.length,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ error: message });
    }
  },
};
