/**
 * code_search: its description example and the results of its query checks;
 * list_dir: the message of a listing with no entries.
 *
 * Safety of this file: every program start is stood in for under both module
 * names ("child_process" and "node:child_process") and throws, except the one
 * start a case names in advance (exact program and arguments), which gets a
 * stand-in child that prints the given text and closes; nothing is ever
 * started. The code index is stood in and the database module refuses to
 * open, so no database is read. The only files written are in this file's own
 * temporary folder.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const h = vi.hoisted(() => {
  const starts: string[] = [];
  const state = { answer: null as null | { cmd: string; args: string[]; stdout: string } };
  /** A child that prints `stdout`, then closes with status 0. */
  const standInChild = (stdout: string) => {
    const handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
    const on = (key: string) => (event: string, cb: (...a: unknown[]) => void) => {
      (handlers[`${key}:${event}`] ??= []).push(cb);
    };
    setImmediate(() => {
      if (stdout) for (const cb of handlers["out:data"] ?? []) cb(Buffer.from(stdout));
      for (const cb of handlers["child:close"] ?? []) cb(0);
    });
    return {
      stdout: { on: on("out") },
      stderr: { on: on("err") },
      on: on("child"),
      kill: () => {
        throw new Error("no signal in this test");
      },
    };
  };
  const childProcess = () => {
    const refuse =
      (name: string) =>
      (..._args: unknown[]): never => {
        starts.push(name);
        throw new Error(`program start refused in this test: ${name}`);
      };
    const spawn = (cmd: unknown, args: unknown, ..._rest: unknown[]) => {
      const a = state.answer;
      if (a && cmd === a.cmd && JSON.stringify(args) === JSON.stringify(a.args)) {
        state.answer = null;
        return standInChild(a.stdout);
      }
      return refuse("spawn")();
    };
    const api = {
      spawn,
      spawnSync: refuse("spawnSync"),
      exec: refuse("exec"),
      execSync: refuse("execSync"),
      execFile: refuse("execFile"),
      execFileSync: refuse("execFileSync"),
      fork: refuse("fork"),
    };
    return { ...api, default: api };
  };
  return { starts, state, childProcess };
});

vi.mock("child_process", () => h.childProcess());
vi.mock("node:child_process", () => h.childProcess());
vi.mock("../../db/index.js", () => ({
  getDatabase: () => {
    throw new Error("no database in this test");
  },
  writeWithRetry: () => {
    throw new Error("no database in this test");
  },
}));
vi.mock("./code-index.js", () => ({
  searchCode: vi.fn(() => []),
  symbolsInFile: vi.fn(() => []),
}));

import { codeSearchTool, listDirTool } from "./code-search.js";
import { searchCode, symbolsInFile } from "./code-index.js";
import { detectsHallucinatedExecution } from "../../runners/hallucination-guard.js";

const mockSearchCode = vi.mocked(searchCode);
const mockSymbolsInFile = vi.mocked(symbolsInFile);

beforeEach(() => {
  vi.clearAllMocks();
  h.starts.length = 0;
  h.state.answer = null;
});

describe("code_search description", () => {
  it("its example searches for a function that exists and cites no file and line", () => {
    expect(typeof detectsHallucinatedExecution).toBe("function");
    const description = codeSearchTool.definition.function.description;
    const example = description.split("\n").find((l) => l.startsWith("1. code_search "));
    expect(example).toBe(
      `1. code_search query="${detectsHallucinatedExecution.name}" → the file and line where it is defined`,
    );
    expect(description).not.toMatch(/\.ts:\d/);
  });
});

describe("code_search query length", () => {
  const tooShort = '{"error":"Query must be at least 2 characters."}';

  it.each([
    ["an empty query", ""],
    ["a one-character query", "a"],
  ])("%s returns the error object with error as its first key and searches nothing", async (_label, query) => {
    const result = await codeSearchTool.execute({ query });
    expect(result).toBe(tooShort);
    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(Object.keys(parsed)[0]).toBe("error");
    expect(parsed.error).toBe("Query must be at least 2 characters.");
    expect(mockSearchCode).not.toHaveBeenCalled();
    expect(h.starts).toEqual([]);
  });

  it("a missing query returns the same error object and starts nothing", async () => {
    const result = await codeSearchTool.execute({});
    expect(result).toBe(tooShort);
    expect(mockSearchCode).not.toHaveBeenCalled();
    expect(h.starts).toEqual([]);
  });

  it("a two-character query passes the length check and a search that finds nothing says so in plain text", async () => {
    const result = await codeSearchTool.execute({ query: "ab" });
    expect(mockSearchCode).toHaveBeenCalledWith("ab", { kind: undefined, limit: 15 });
    expect(result).toBe('🔍 No matches for "ab".');
    expect(h.starts).toEqual([]);
  });

  it("a file with no indexed symbols says so in plain text", async () => {
    const result = await codeSearchTool.execute({ query: "x", file: "src/none.ts" });
    expect(mockSymbolsInFile).toHaveBeenCalledWith("src/none.ts");
    expect(result).toBe('No symbols indexed for "src/none.ts".');
    expect(h.starts).toEqual([]);
  });
});

describe("list_dir with no entries listed", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "code-search-tool-"));
    writeFileSync(join(dir, "a.txt"), "x");
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const recursiveArgs = (path: string): string[] => [
    path,
    "-maxdepth",
    "3",
    "-not",
    "-path",
    "*/node_modules/*",
    "-not",
    "-path",
    "*/.git/*",
    "-not",
    "-path",
    "*/dist/*",
  ];

  it("empty output from a plain listing returns the no-entries message exactly", async () => {
    h.state.answer = { cmd: "ls", args: ["-1Ap", dir], stdout: "" };
    const result = await listDirTool.execute({ path: dir });
    expect(result).toBe('{"entries":[],"message":"No entries listed"}');
    expect(h.state.answer).toBeNull();
    expect(h.starts).toEqual([]);
  });

  it("empty output from a recursive listing returns the same message", async () => {
    h.state.answer = { cmd: "find", args: recursiveArgs(dir), stdout: "" };
    const result = await listDirTool.execute({ path: dir, recursive: true });
    expect(result).toBe('{"entries":[],"message":"No entries listed"}');
    expect(h.state.answer).toBeNull();
    expect(h.starts).toEqual([]);
  });

  it("a recursive listing with entries returns them and carries no message", async () => {
    h.state.answer = { cmd: "find", args: recursiveArgs(dir), stdout: `${dir}\n${dir}/a.txt\n` };
    const parsed = JSON.parse(await listDirTool.execute({ path: dir, recursive: true })) as Record<string, unknown>;
    expect(parsed).toEqual({ path: dir, entries: [dir, `${dir}/a.txt`], total: 2 });
    expect(parsed).not.toHaveProperty("message");
    expect(h.state.answer).toBeNull();
    expect(h.starts).toEqual([]);
  });

  it("a listing with an entry returns it and carries no message", async () => {
    h.state.answer = { cmd: "ls", args: ["-1Ap", dir], stdout: "a.txt\n" };
    const parsed = JSON.parse(await listDirTool.execute({ path: dir })) as Record<string, unknown>;
    expect(parsed).toEqual({ path: dir, entries: ["a.txt"], total: 1 });
    expect(parsed).not.toHaveProperty("message");
    expect(h.state.answer).toBeNull();
    expect(h.starts).toEqual([]);
  });
});
