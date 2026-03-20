/**
 * Code search tools — grep (content search) and glob (file discovery).
 *
 * Adapted from open-swe patterns. These give the LLM the ability to explore
 * and understand codebases without resorting to shell_exec + grep/find, which
 * has worse error handling and inconsistent output formats.
 */

import { execSync } from "child_process";
import type { Tool } from "../types.js";

const MAX_RESULTS = 100;
const MAX_OUTPUT = 15_000; // chars

// ---------------------------------------------------------------------------
// grep — content search
// ---------------------------------------------------------------------------

export const grepTool: Tool = {
  name: "grep",
  definition: {
    type: "function",
    function: {
      name: "grep",
      description: `Search file contents for a text pattern. Uses fixed-string matching (not regex) for reliability.

WHEN TO USE:
- Find where a function, class, variable, or string is used
- Locate error messages, config keys, or API endpoints
- Search for TODO/FIXME/HACK comments

OUTPUT MODES:
- "files" (default): Just file paths that contain the pattern — fast overview
- "content": Matching lines with line numbers — for reading the matches
- "count": Number of matches per file — for gauging scope

TIPS:
- Start with "files" mode to find relevant files, then use file_read to examine them
- Use include_glob to narrow search (e.g. "*.ts" for TypeScript only)
- Search is case-sensitive by default; set case_insensitive=true if needed`,
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Text to search for (literal string, not regex)",
          },
          path: {
            type: "string",
            description:
              'Directory or file to search in. Defaults to current working directory "."',
          },
          include_glob: {
            type: "string",
            description:
              'File pattern filter, e.g. "*.ts", "*.py", "src/**/*.js"',
          },
          output_mode: {
            type: "string",
            enum: ["files", "content", "count"],
            description:
              'What to return: "files" (paths only), "content" (matching lines), "count" (match counts). Default: "files"',
          },
          case_insensitive: {
            type: "boolean",
            description: "Case-insensitive search. Default: false",
          },
          max_results: {
            type: "number",
            description: `Maximum results to return. Default: ${MAX_RESULTS}`,
          },
        },
        required: ["pattern"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const pattern = args.pattern as string;
    if (!pattern) return JSON.stringify({ error: "pattern is required" });

    const searchPath = (args.path as string) || ".";
    const includeGlob = args.include_glob as string | undefined;
    const mode = (args.output_mode as string) || "files";
    const caseInsensitive = args.case_insensitive === true;
    const maxResults = Math.min(
      typeof args.max_results === "number" ? args.max_results : MAX_RESULTS,
      500,
    );

    // Build ripgrep command (available on most Linux systems, falls back to grep)
    const flags: string[] = ["--fixed-strings", "--no-heading"];
    if (caseInsensitive) flags.push("--ignore-case");

    switch (mode) {
      case "files":
        flags.push("--files-with-matches");
        break;
      case "count":
        flags.push("--count");
        break;
      case "content":
        flags.push("--line-number");
        break;
    }

    if (includeGlob) {
      flags.push(`--glob '${includeGlob}'`);
    }

    // Limit output
    flags.push(`--max-count ${mode === "files" ? 1 : maxResults}`);

    // Escape single quotes in pattern for shell safety
    const safePattern = pattern.replace(/'/g, "'\\''");
    const cmd = `rg ${flags.join(" ")} -- '${safePattern}' '${searchPath}' 2>/dev/null || grep -r ${caseInsensitive ? "-i" : ""} ${mode === "files" ? "-l" : mode === "count" ? "-c" : "-n"} --fixed-strings ${includeGlob ? `--include='${includeGlob}'` : ""} -- '${safePattern}' '${searchPath}' 2>/dev/null || true`;

    try {
      const output = execSync(cmd, {
        timeout: 20_000,
        maxBuffer: 2 * 1024 * 1024,
        encoding: "utf-8",
      });

      if (!output.trim()) {
        return JSON.stringify({
          matches: [],
          total: 0,
          message: "No matches found",
        });
      }

      let lines = output.trim().split("\n");
      const total = lines.length;

      if (lines.length > maxResults) {
        lines = lines.slice(0, maxResults);
      }

      const result = lines.join("\n");
      const trimmed =
        result.length > MAX_OUTPUT
          ? result.slice(0, MAX_OUTPUT) +
            `\n... (truncated, ${total} total matches)`
          : result;

      return JSON.stringify({
        matches: trimmed,
        total,
        truncated: total > maxResults,
      });
    } catch (err) {
      const error = err as {
        status?: number;
        stdout?: string;
        stderr?: string;
        message?: string;
      };
      // grep returns exit code 1 for "no matches" — not an error
      if (error.status === 1 && !error.stderr) {
        return JSON.stringify({
          matches: [],
          total: 0,
          message: "No matches found",
        });
      }
      return JSON.stringify({
        error: error.stderr || error.message || String(err),
      });
    }
  },
};

// ---------------------------------------------------------------------------
// glob — file discovery
// ---------------------------------------------------------------------------

export const globTool: Tool = {
  name: "glob",
  definition: {
    type: "function",
    function: {
      name: "glob",
      description: `Find files matching a glob pattern. Use this to discover project structure, locate files by extension, or find specific filenames.

WHEN TO USE:
- "What TypeScript files are in src/?" → glob pattern="src/**/*.ts"
- "Find all test files" → glob pattern="**/*.test.*"
- "Is there a package.json?" → glob pattern="**/package.json"
- "Find all Python files" → glob pattern="**/*.py"

PATTERNS:
- "*" matches any filename: "*.ts" finds all .ts files in current dir
- "**" matches any depth: "src/**/*.ts" finds .ts files anywhere under src/
- "{a,b}" alternation: "*.{ts,js}" finds both .ts and .js files

TIPS:
- Always use "**/" prefix to search recursively
- Results are sorted alphabetically
- Use path to narrow the search directory`,
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description:
              'Glob pattern, e.g. "**/*.ts", "src/**/*.{ts,tsx}", "**/package.json"',
          },
          path: {
            type: "string",
            description: 'Base directory to search from. Defaults to "."',
          },
          max_results: {
            type: "number",
            description: `Maximum files to return. Default: ${MAX_RESULTS}`,
          },
        },
        required: ["pattern"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const pattern = args.pattern as string;
    if (!pattern) return JSON.stringify({ error: "pattern is required" });

    const searchPath = (args.path as string) || ".";
    const maxResults = Math.min(
      typeof args.max_results === "number" ? args.max_results : MAX_RESULTS,
      1000,
    );

    // Use find with shell glob expansion, or fd if available
    // Escape single quotes for shell safety
    const safePattern = pattern.replace(/'/g, "'\\''");
    const safePath = searchPath.replace(/'/g, "'\\''");

    // Try fd first (fast, respects .gitignore), fall back to find + bash globbing
    const cmd = `cd '${safePath}' && (fd --glob '${safePattern}' --type f 2>/dev/null || find . -type f -name '${safePattern.includes("/") ? safePattern.split("/").pop() : safePattern}' 2>/dev/null | head -${maxResults}) | sort | head -${maxResults}`;

    try {
      const output = execSync(cmd, {
        timeout: 20_000,
        maxBuffer: 2 * 1024 * 1024,
        encoding: "utf-8",
      });

      if (!output.trim()) {
        return JSON.stringify({
          files: [],
          total: 0,
          message: "No files found",
        });
      }

      const files = output.trim().split("\n").filter(Boolean);
      return JSON.stringify({
        files,
        total: files.length,
        truncated: files.length >= maxResults,
      });
    } catch (err) {
      const error = err as { stderr?: string; message?: string };
      return JSON.stringify({
        error: error.stderr || error.message || String(err),
      });
    }
  },
};

// ---------------------------------------------------------------------------
// ls — directory listing
// ---------------------------------------------------------------------------

export const listDirTool: Tool = {
  name: "list_dir",
  definition: {
    type: "function",
    function: {
      name: "list_dir",
      description: `List the contents of a directory. Shows files and subdirectories with type indicators.

WHEN TO USE:
- Explore project structure before making changes
- Check what files exist in a directory
- Verify a file was created or deleted

Returns entries sorted alphabetically with "/" suffix for directories.`,
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: 'Directory path to list. Defaults to "."',
          },
          recursive: {
            type: "boolean",
            description:
              "If true, list all files recursively (tree view). Default: false",
          },
          max_depth: {
            type: "number",
            description: "Maximum depth for recursive listing. Default: 3",
          },
        },
        required: [],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const dirPath = (args.path as string) || ".";
    const recursive = args.recursive === true;
    const maxDepth = Math.min(
      typeof args.max_depth === "number" ? args.max_depth : 3,
      6,
    );

    try {
      let cmd: string;
      if (recursive) {
        // tree-style recursive listing
        cmd = `find '${dirPath.replace(/'/g, "'\\''")}' -maxdepth ${maxDepth} -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' | sort | head -500`;
      } else {
        cmd = `ls -1Ap '${dirPath.replace(/'/g, "'\\''")}' 2>/dev/null | head -200`;
      }

      const output = execSync(cmd, {
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
        encoding: "utf-8",
      });

      if (!output.trim()) {
        return JSON.stringify({
          entries: [],
          message: "Directory is empty or does not exist",
        });
      }

      const entries = output.trim().split("\n").filter(Boolean);
      return JSON.stringify({ path: dirPath, entries, total: entries.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ error: message });
    }
  },
};
