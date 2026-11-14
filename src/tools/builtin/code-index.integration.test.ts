/**
 * Code index SQL on the real database: the lazy `code_index` table and its
 * two indexes, the rebuild DELETE + INSERT, and the two read queries, on
 * `initDatabase(":memory:")`.
 *
 * `rebuildIndex` walks a fixed source folder. While it runs, `fs` maps that
 * folder onto a throwaway tree and refuses any other path, so the index holds
 * exactly the symbols below. Outside the call `fs` is the real one, which
 * `initDatabase` needs to read the schema.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join, relative } from "path";

const walk = vi.hoisted(() => ({
  on: false,
  tree: "",
  src: "/root/claude/mission-control/src",
}));

vi.mock("fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("fs")>();
  const map = (p: unknown): string => {
    const s = String(p);
    if (!walk.on) return s;
    if (s !== walk.src && !s.startsWith(walk.src + "/")) {
      throw new Error(`code index read outside the source folder: ${s}`);
    }
    return join(walk.tree, relative(walk.src, s));
  };
  const remap = <F>(f: F): F =>
    ((p: unknown, ...rest: unknown[]) =>
      (f as unknown as (...a: unknown[]) => unknown)(map(p), ...rest)) as unknown as F;
  const mocked = {
    ...real,
    readdirSync: remap(real.readdirSync),
    statSync: remap(real.statSync),
    readFileSync: remap(real.readFileSync),
  };
  return { ...mocked, default: mocked };
});

import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { closeDatabase, getDatabase, initDatabase } from "../../db/index.js";
import { rebuildIndex, searchCode, symbolsInFile } from "./code-index.js";

const A_TS = [
  "export function alphaRun(): void {}",
  "const alphaHidden = 1;",
  "export interface GammaShape {",
  "  size: number;",
  "}",
].join("\n");
const B_TS = ['export type DeltaKind = "x";', "export class AlphaWorker {}"].join(
  "\n",
);

function rebuild(): { files: number; symbols: number } {
  walk.on = true;
  try {
    return rebuildIndex();
  } finally {
    walk.on = false;
  }
}

const allRows = () =>
  getDatabase()
    .prepare(
      "SELECT name, kind, file, line, exported, signature FROM code_index ORDER BY file, line",
    )
    .all();

beforeEach(() => {
  walk.tree = mkdtempSync(join(tmpdir(), "code-index-int-"));
  mkdirSync(join(walk.tree, "sub"));
  writeFileSync(join(walk.tree, "a.ts"), A_TS);
  writeFileSync(join(walk.tree, "sub", "b.ts"), B_TS);
  vi.spyOn(console, "log").mockImplementation(() => {});
  initDatabase(":memory:");
});

afterEach(() => {
  try {
    closeDatabase();
    vi.restoreAllMocks();
  } finally {
    walk.on = false;
    rmSync(walk.tree, { recursive: true, force: true });
  }
});

describe("rebuildIndex on the real database", () => {
  it("creates the table and both indexes, then stores every symbol of the tree", () => {
    expect(rebuild()).toEqual({ files: 2, symbols: 5 });

    const indexes = getDatabase()
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'code_index' ORDER BY name",
      )
      .all();
    expect(indexes).toEqual([
      { name: "idx_code_index_file" },
      { name: "idx_code_index_name" },
    ]);
    expect(allRows()).toEqual([
      { name: "alphaRun", kind: "function", file: "src/a.ts", line: 1, exported: 1, signature: "export function alphaRun(): void {}" },
      { name: "alphaHidden", kind: "const", file: "src/a.ts", line: 2, exported: 0, signature: "const alphaHidden = 1;" },
      { name: "GammaShape", kind: "interface", file: "src/a.ts", line: 3, exported: 1, signature: "export interface GammaShape {" },
      { name: "DeltaKind", kind: "type", file: "src/sub/b.ts", line: 1, exported: 1, signature: 'export type DeltaKind = "x";' },
      { name: "AlphaWorker", kind: "class", file: "src/sub/b.ts", line: 2, exported: 1, signature: "export class AlphaWorker {}" },
    ]);
  });

  it("a rebuild replaces the previous index instead of adding to it", () => {
    rebuild();
    unlinkSync(join(walk.tree, "sub", "b.ts"));

    expect(rebuild()).toEqual({ files: 1, symbols: 3 });
    expect(allRows().map((r) => (r as { name: string }).name)).toEqual([
      "alphaRun",
      "alphaHidden",
      "GammaShape",
    ]);
  });
});

describe("code index reads on the real database", () => {
  beforeEach(() => {
    rebuild();
  });

  it("searchCode matches name or signature, exported first, then by name ignoring case", () => {
    const names = (q: string, opts?: Parameters<typeof searchCode>[1]) =>
      searchCode(q, opts).map((s) => s.name);

    expect(names("alpha")).toEqual(["alphaRun", "AlphaWorker", "alphaHidden"]);
    expect(names("void")).toEqual(["alphaRun"]);
    expect(names("alpha", { kind: "class" })).toEqual(["AlphaWorker"]);
    expect(names("alpha", { limit: 1 })).toEqual(["alphaRun"]);
    expect(searchCode("zzz-none")).toEqual([]);
  });

  it("symbolsInFile returns one file's symbols in line order", () => {
    expect(symbolsInFile("src/a.ts").map((s) => [s.name, s.line])).toEqual([
      ["alphaRun", 1],
      ["alphaHidden", 2],
      ["GammaShape", 3],
    ]);
    expect(symbolsInFile("src/sub/b.ts").map((s) => s.name)).toEqual([
      "DeltaKind",
      "AlphaWorker",
    ]);
  });
});
