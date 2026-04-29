/**
 * File read/write tools.
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, statSync } from "fs";
import { execFileSync } from "child_process";
import { dirname, extname, resolve } from "path";
import type { Tool } from "../types.js";
import {
  isImmutableCorePath,
  validatePathSafety,
  isDangerousRemovalPath,
} from "./immutable-core.js";
import { LARGE_FILE_THRESHOLD } from "../../config/constants.js";
import {
  parseLineRanges,
  extractLineRanges,
  buildOutline,
  countLines,
  PREVIEW_CHARS,
} from "../../lib/file-slicing.js";

/** Hard cap on a single `file_read` payload — protects against pathological
 *  slice requests (e.g. lines='1-100000' on a giant log). */
const MAX_READ = 50_000; // chars

// Jarvis write boundaries — can read anything, writes restricted to project dirs.
// /root/claude/mission-control/ is OFF LIMITS (Jarvis's own source code).
// Granted: project workspaces, tmp, user directories.
const ALLOW_WRITE_PREFIXES = [
  "/root/claude/jarvis-kb/",
  "/root/claude/cuatro-flor/",
  "/root/claude/projects/",
  "/root/claude/mission-control/", // allowed only on jarvis/* branches
  "/tmp/",
  "/workspace/",
];
const DENY_WRITE_PREFIXES = [
  "/root/claude/mission-control/", // dynamic — overridden on jarvis/* branches
  "/root/.claude/",
  "/etc/",
  "/usr/",
  "/var/",
];

const SELF_IMPROVEMENT_ALLOWED = [
  "src/tools/",
  "src/intel/",
  "src/messaging/scope.ts",
  "src/messaging/prompt-sections.ts",
  "src/messaging/prompt-enhancer.ts",
  "src/video/",
];

/** Docs files Jarvis can write on main branch (operational logs, not source code). */
const RITUAL_WRITABLE_DOCS = ["docs/EVOLUTION-LOG.md"];

function getJarvisBranchFile(): string {
  try {
    return execFileSync("git", ["branch", "--show-current"], {
      cwd: "/root/claude/mission-control",
      timeout: 5000,
      encoding: "utf-8",
    }).trim();
  } catch {
    return "";
  }
}

function isOnJarvisBranch(): boolean {
  return /^jarvis\/(feat|fix|refactor)\/.+$/.test(getJarvisBranchFile());
}

function isWriteAllowed(path: string): { allowed: boolean; reason?: string } {
  // Path safety pipeline (Claude Code pattern): TOCTOU, shell expansion, dangerous files
  const safety = validatePathSafety(path, "write");
  if (!safety.safe) {
    return { allowed: false, reason: `Write blocked: ${safety.reason}` };
  }

  const resolved = resolve(path);
  // SG3: Immutable core — blocked even on jarvis/* branches
  const immCheck = isImmutableCorePath(resolved);
  if (immCheck.immutable) {
    return {
      allowed: false,
      reason: `Write blocked: ${immCheck.reason}. This file cannot be modified by Jarvis.`,
    };
  }
  for (const deny of DENY_WRITE_PREFIXES) {
    if (resolved.startsWith(deny)) {
      // Dynamic override for mission-control on jarvis/* branches
      if (deny === "/root/claude/mission-control/" && isOnJarvisBranch()) {
        continue;
      }
      // Narrow exception: ritual-writable docs (operational logs, not source)
      if (deny === "/root/claude/mission-control/") {
        const rel = resolved.replace("/root/claude/mission-control/", "");
        if (RITUAL_WRITABLE_DOCS.includes(rel)) {
          continue;
        }
      }
      return {
        allowed: false,
        reason: `Write blocked: ${deny} is protected. Jarvis cannot modify its own source code or system files.`,
      };
    }
  }
  // S5 safety: on jarvis/fix/* branches, restrict to allowed paths
  if (resolved.startsWith("/root/claude/mission-control/")) {
    const branch = getJarvisBranchFile();
    if (branch.startsWith("jarvis/fix/")) {
      const rel = resolved.replace("/root/claude/mission-control/", "");
      if (!SELF_IMPROVEMENT_ALLOWED.some((p) => rel.startsWith(p))) {
        return {
          allowed: false,
          reason: `Write blocked: outside self-improvement scope. Allowed: ${SELF_IMPROVEMENT_ALLOWED.join(", ")}`,
        };
      }
    }
  }
  if (ALLOW_WRITE_PREFIXES.some((p) => resolved.startsWith(p))) {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason: `Write blocked: ${resolved} is outside Jarvis's allowed write directories. Allowed: ${ALLOW_WRITE_PREFIXES.join(", ")}`,
  };
}

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
      description: `Read the contents of a file. Supports plain text files and .docx (Word documents).

LARGE FILE BEHAVIOR (>${LARGE_FILE_THRESHOLD} chars):
When the file is large AND you don't pass \`lines\`, this tool returns a structured envelope
INSTEAD of the full content:
  { truncated: true, total_chars, total_lines, outline: [...headings with line numbers...],
    preview: <first ~${PREVIEW_CHARS} chars>, next_steps: [...] }
The preview is the first ~${PREVIEW_CHARS} chars only — DO NOT infer the file's content from it.
Read the outline (each heading is prefixed with its line number, e.g. "L42: # Section"),
decide which sections matter, then call again with \`lines='42-90'\` for each one.

WORKFLOW for large files:
  1. file_read(path="/path/to/file.md")  → {truncated, outline, preview}
  2. From the outline, pick sections of interest (line ranges)
  3. file_read(path="...", lines="200-350")  → exact slice you need

For small files (≤${LARGE_FILE_THRESHOLD} chars), the full content is returned as before;
\`total_chars\` is included so you always know the file size.`,
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute or relative file path to read",
          },
          lines: {
            type: "string",
            description:
              "Read only specific line ranges. Format: 'N-M' (single range, e.g. '1-200'), 'N' (single line, e.g. '42'), or comma-separated multiple ranges (e.g. '1-50,200-250'). Lines are 1-indexed and inclusive. Out-of-range ends are clamped to the file size. Maximum 2000 lines per call (response sets `line_capped: true` if hit — paginate by issuing follow-up calls with non-overlapping ranges). Use this on large files after reading the outline returned by an unscoped call.",
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
    // Coerce — LLM occasionally passes lines as a number; raw cast would mask
    // that as a runtime TypeError on .trim() (qa W3).
    const linesSpec = args.lines == null ? undefined : String(args.lines);

    // Sec2 round-1 fix: file_read had zero path validation. LLM could read
    // /root/.claude/.credentials.json, /etc/shadow, Supabase .env, etc.
    // validatePathSafety now applies a read-path denylist; see immutable-core.
    const safety = validatePathSafety(path, "read");
    if (!safety.safe) {
      return JSON.stringify({ error: `Read blocked: ${safety.reason}` });
    }

    try {
      let content: string;
      if (extname(path).toLowerCase() === ".docx") {
        content = await readDocx(path);
      } else {
        content = readFileSync(path, "utf-8");
      }

      const totalChars = content.length;
      const totalLines = countLines(content);

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
          content,
          ranges,
        );
        // Hard cap on slice payload — protects against lines='1-1000000' DoS
        const cappedSlice =
          slice.length > MAX_READ ? slice.slice(0, MAX_READ) : slice;
        return JSON.stringify({
          path,
          content: cappedSlice,
          lines: linesSpec,
          slice_lines: sliceLines,
          total_chars: totalChars,
          total_lines: totalLines,
          ...(clamped && { clamped: true }),
          ...(lineCapped && { line_capped: true }),
          ...(slice.length > MAX_READ && { slice_capped: true }),
        });
      }

      // Branch B: large file with no slice → structured envelope (top-level signal)
      if (totalChars > LARGE_FILE_THRESHOLD) {
        const outline = buildOutline(content);
        return JSON.stringify({
          path,
          truncated: true,
          total_chars: totalChars,
          total_lines: totalLines,
          outline,
          preview: content.slice(0, PREVIEW_CHARS),
          next_steps: [
            `File is ${totalChars} chars / ${totalLines} lines — full content NOT returned.`,
            `Pick a section from \`outline\` (each entry has its line number) and call again with lines='START-END' to read the slice.`,
            `Example: file_read(path="${path}", lines="1-200")`,
          ],
        });
      }

      // Branch C: small file → full content + total_chars (existing shape + meta)
      return JSON.stringify({
        path,
        content,
        total_chars: totalChars,
        total_lines: totalLines,
        size: totalChars, // legacy field name kept for compatibility
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ error: message });
    }
  },
};

export const fileWriteTool: Tool = {
  name: "file_write",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "file_write",
      description: `Write content to a VPS file. Creates parent directories if needed. Overwrites existing files.

USE WHEN:
- Writing source code to project directories (/root/claude/cuatro-flor/, etc.)
- Creating temp files for tool pipelines (/tmp/wp_content/, etc.)

DO NOT USE for your Knowledge Base — use jarvis_file_write instead.
DO NOT USE for /root/claude/mission-control/ — that is your own source code and is blocked.

For large content salvaged from a truncated tool call, pass content_file=<salvage path>.

AFTER WRITING: Report the file path written.`,
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

    // Enforce write boundaries
    const writeCheck = isWriteAllowed(path);
    if (!writeCheck.allowed) {
      return JSON.stringify({ error: writeCheck.reason });
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

// ---------------------------------------------------------------------------
// Allowed paths for deletion — same as shell_exec write prefixes
// ---------------------------------------------------------------------------

// Delete uses same boundaries as write
const ALLOW_DELETE_PREFIXES = ALLOW_WRITE_PREFIXES;

export const fileDeleteTool: Tool = {
  name: "file_delete",
  requiresConfirmation: true,
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "file_delete",
      description: `Delete a file or directory. Requires confirmation before execution.

USE WHEN:
- You need to remove a file or folder that is no longer needed
- Cleaning up temporary files or outdated outputs

RESTRICTIONS:
- Only paths under /root/claude/, /tmp/, or /workspace/ can be deleted
- System paths are blocked for safety
- Directories are removed recursively (like rm -rf)

CAUTION: This is irreversible. Verify the path is correct before calling.`,
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute path to the file or directory to delete",
          },
        },
        required: ["path"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const rawPath = (args.path ?? args.file_path) as string;
    if (!rawPath) return JSON.stringify({ error: "path is required" });

    // Path safety pipeline + dangerous removal check (Claude Code pattern)
    const safety = validatePathSafety(rawPath, "delete");
    if (!safety.safe) {
      return JSON.stringify({ error: `Deletion blocked: ${safety.reason}` });
    }
    const dangerCheck = isDangerousRemovalPath(rawPath);
    if (dangerCheck.dangerous) {
      return JSON.stringify({
        error: `Deletion blocked: ${dangerCheck.reason}`,
      });
    }

    const absPath = resolve(rawPath);

    // SG3: Immutable core — blocked even on jarvis/* branches
    const immCheck = isImmutableCorePath(absPath);
    if (immCheck.immutable) {
      return JSON.stringify({
        error: `Deletion blocked: ${immCheck.reason}. This file cannot be modified by Jarvis.`,
      });
    }

    // Safety: only allow deletion under known safe prefixes, at least 1 level deep
    const matchedPrefix = ALLOW_DELETE_PREFIXES.find((p) =>
      absPath.startsWith(p),
    );
    if (!matchedPrefix) {
      return JSON.stringify({
        error: `Deletion blocked: '${absPath}' is outside allowed paths (${ALLOW_DELETE_PREFIXES.join(", ")})`,
      });
    }
    // Prevent deleting the prefix root or top-level project directories
    const relative = absPath.slice(matchedPrefix.length);
    if (!relative || relative === "/") {
      return JSON.stringify({
        error: `Deletion blocked: cannot delete root prefix '${matchedPrefix}'`,
      });
    }
    // For /root/claude/, require depth >= 2 (prevent deleting project roots like /root/claude/mission-control)
    if (
      matchedPrefix === "/root/claude/" &&
      relative.split("/").filter(Boolean).length < 2
    ) {
      return JSON.stringify({
        error: `Deletion blocked: cannot delete top-level project directory '${absPath}'. Target a subdirectory or file instead.`,
      });
    }

    try {
      const stats = statSync(absPath);
      const type = stats.isDirectory() ? "directory" : "file";

      rmSync(absPath, { recursive: true, force: true });

      return JSON.stringify({
        deleted: absPath,
        type,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ error: message });
    }
  },
};
