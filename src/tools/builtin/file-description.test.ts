import { describe, it, expect, vi, beforeEach } from "vitest";

// This file only reads the tools' strings and calls no handler, no execute and
// no guard function. For the whole file every function export of "fs",
// "node:fs", "fs/promises", "node:fs/promises", "child_process" and
// "node:child_process" is replaced by a stub that throws; other exports stay
// real, "default" points to the stub object, and the "promises" property of
// both fs specifiers points to the stubbed promises module. The global fetch is
// a stub that throws, set before the imports and again before each test.
// Packages loaded from node_modules without transformation keep the real
// built-in modules.
// file_read's expected text is built from the two constants its description
// interpolates, imported from the same modules, so it holds for any setting.
const stubbed = vi.hoisted(() => (label: string, real: Record<string, unknown>) => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(real))
    out[k] =
      typeof v === "function"
        ? vi.fn(() => {
            throw new Error(`${label} ${k} is a stub in this file`);
          })
        : v;
  out.default = out;
  return out;
});
vi.mock("fs/promises", async (importOriginal) =>
  stubbed("fs/promises", await importOriginal<Record<string, unknown>>()),
);
vi.mock("node:fs/promises", async (importOriginal) =>
  stubbed("node:fs/promises", await importOriginal<Record<string, unknown>>()),
);
vi.mock("fs", async (importOriginal) => {
  const out = stubbed("fs", await importOriginal<Record<string, unknown>>());
  out.promises = await import("fs/promises");
  return out;
});
vi.mock("node:fs", async (importOriginal) => {
  const out = stubbed("node:fs", await importOriginal<Record<string, unknown>>());
  out.promises = await import("node:fs/promises");
  return out;
});
vi.mock("child_process", async (importOriginal) =>
  stubbed("child_process", await importOriginal<Record<string, unknown>>()),
);
vi.mock("node:child_process", async (importOriginal) =>
  stubbed("node:child_process", await importOriginal<Record<string, unknown>>()),
);
const fetchStub = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("fetch is a stub in this file");
  }),
);
vi.hoisted(() => vi.stubGlobal("fetch", fetchStub));
beforeEach(() => {
  vi.stubGlobal("fetch", fetchStub);
});

import * as fs from "fs";
import * as nodeFs from "node:fs";
import * as fsPromises from "fs/promises";
import * as nodeFsPromises from "node:fs/promises";
import * as childProcess from "child_process";
import * as nodeChildProcess from "node:child_process";
import { LARGE_FILE_THRESHOLD } from "../../config/constants.js";
import { PREVIEW_CHARS } from "../../lib/file-slicing.js";
import { fileReadTool, fileWriteTool, fileDeleteTool } from "./file.js";

const FILE_READ = `Read the contents of a file. Supports plain text files and .docx (Word documents).

LARGE FILE BEHAVIOR (>${LARGE_FILE_THRESHOLD} chars):
When the file is large AND you don't pass \`lines\`, this tool returns a structured envelope
INSTEAD of the full content:
  { truncated: true, total_chars, total_lines, outline: [...headings AND timestamped log entries ("- [HH:MM:SS] **WHO**: …", e.g. day-logs) with line numbers...],
    preview: <first ~${PREVIEW_CHARS} chars>, next_steps: [...] }
The preview is the first ~${PREVIEW_CHARS} chars only — DO NOT infer the file's content from it.
Read the outline (each entry is prefixed with its line number, e.g. "L42: # Section" or "L31: [11:45:00] USER: …"),
decide which sections matter, then call again with \`lines='42-90'\` for each one.

WORKFLOW for large files:
  1. file_read(path="/path/to/file.md")  → {truncated, outline, preview}
  2. From the outline, pick sections of interest (line ranges)
  3. file_read(path="...", lines="200-350")  → exact slice you need

For small files (≤${LARGE_FILE_THRESHOLD} chars), the full content is returned as before;
\`total_chars\` is included so you always know the file size.

DO NOT USE WHEN:
- The path is a knowledge-base path: this tool looks the path up on disk, not in the knowledge base — use jarvis_file_read when it is among your tools.
- The file is a PDF: this tool reads a .docx as text and any other file as UTF-8 text — use pdf_read when it is among your tools.
- You want a folder's contents: this tool reads one file and returns an error for a folder.`;

const FILE_WRITE = `Write content to a VPS file. Creates parent directories if needed. Overwrites existing files.

USE WHEN:
- Writing source code to project directories (under /root/claude/, etc.)
- Creating temp files for tool pipelines (/tmp/wp_content/, etc.)

DO NOT USE for your Knowledge Base — use jarvis_file_write when it is among your tools.
DO NOT USE for /root/claude/mission-control/ — that is your own source code and is blocked.

For large content salvaged from a truncated tool call, pass content_file=<salvage path>.

AFTER WRITING: Report the file path written.`;

const FILE_DELETE = `Delete a file or directory.

USE WHEN:
- You need to remove a file or folder that is no longer needed
- Cleaning up temporary files or outdated outputs

RESTRICTIONS:
- Only paths under /root/claude/, /tmp/, /workspace/ or the knowledge-base folder can be deleted
- System paths are blocked for safety
- Directories are removed recursively (like rm -rf)

DO NOT USE WHEN:
- The file belongs to your knowledge base: this tool removes only the copy on disk and leaves the knowledge-base entry in place — use jarvis_file_delete when it is among your tools.
- You want to delete several files by a pattern: this tool takes one exact path and refuses wildcards and glob characters.
- The target is /root/claude/, /tmp/ or /workspace/ itself, or a project folder directly under /root/claude/: this tool refuses it and deletes nothing.
- You expect the operator to be asked before the deletion: in a run marked non-interactive, such as a scheduled task or a ritual, this tool does not ask.

CAUTION: This is irreversible. Verify the path is correct before calling.`;

describe("file tools — description text", () => {
  it("every function export of the six module specifiers is a mock, and fetch is the stub (checked without calling one)", () => {
    expect(fs.promises).toBe(fsPromises);
    expect(nodeFs.promises).toBe(nodeFsPromises);
    const mods: Record<string, object> = {
      fs,
      "node:fs": nodeFs,
      "fs/promises": fsPromises,
      "node:fs/promises": nodeFsPromises,
      "fs.promises": fs.promises,
      "node:fs.promises": nodeFs.promises,
      child_process: childProcess,
      "node:child_process": nodeChildProcess,
    };
    for (const [label, mod] of Object.entries(mods)) {
      const fns = Object.entries(mod).filter(([, v]) => typeof v === "function");
      expect(fns.length, label).toBeGreaterThan(0);
      for (const [name, fn] of fns) expect(vi.isMockFunction(fn), `${label} ${name}`).toBe(true);
    }
    expect(globalThis.fetch).toBe(fetchStub);
    expect(vi.isMockFunction(globalThis.fetch)).toBe(true);
  });

  it("file_read — the whole description", () => {
    expect(fileReadTool.definition.function.description).toBe(FILE_READ);
  });

  it("file_write — the whole description", () => {
    expect(fileWriteTool.definition.function.description).toBe(FILE_WRITE);
  });

  it("file_delete — the whole description", () => {
    expect(fileDeleteTool.definition.function.description).toBe(FILE_DELETE);
  });
});
