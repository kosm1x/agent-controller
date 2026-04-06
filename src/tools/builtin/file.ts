/**
 * File read/write tools.
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, statSync } from "fs";
import { dirname, extname, resolve } from "path";
import type { Tool } from "../types.js";

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

function getJarvisBranchFile(): string {
  try {
    const { execFileSync } =
      require("child_process") as typeof import("child_process");
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
  const resolved = resolve(path);
  for (const deny of DENY_WRITE_PREFIXES) {
    if (resolved.startsWith(deny)) {
      // Dynamic override for mission-control on jarvis/* branches
      if (deny === "/root/claude/mission-control/" && isOnJarvisBranch()) {
        continue;
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

    const absPath = resolve(rawPath);

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
