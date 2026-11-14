/**
 * jarvis_files_batch_write qualifier check on the real `jarvis_files` table.
 *
 * jarvis-files.test.ts stubs `prepare`, so it cannot see the database rule on
 * `jarvis_files.qualifier`. Here the handler runs on `initDatabase(":memory:")`:
 * an entry with a qualifier outside the tool's schema gets the tool's own
 * per-entry error, nothing is stored for it, and the rest of the batch is
 * written as before.
 *
 * Effects besides SQL are fenced: the disk mirror goes to a throwaway folder
 * under the temp dir (removed after the file), the vector copy, the Drive copy
 * and the index regeneration are recorders, and their delete paths throw.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const kb = vi.hoisted(() => ({
  syncToPgvector: vi.fn(),
  syncToDrive: vi.fn(),
  markIndexDirty: vi.fn(),
  refuse: (name: string) => () => {
    throw new Error(`${name} must not be called by the batch write tool`);
  },
}));

vi.mock("../../db/pgvector-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../db/pgvector-sync.js")>()),
  syncToPgvector: kb.syncToPgvector,
  syncDeleteToPgvector: kb.refuse("syncDeleteToPgvector"),
}));
vi.mock("../../db/drive-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../db/drive-sync.js")>()),
  syncToDrive: kb.syncToDrive,
  syncDeleteToDrive: kb.refuse("syncDeleteToDrive"),
}));
vi.mock("../../db/jarvis-index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../db/jarvis-index.js")>()),
  markIndexDirty: kb.markIndexDirty,
}));

import { closeDatabase, getDatabase, initDatabase } from "../../db/index.js";
import { jarvisFilesBatchWriteTool } from "./jarvis-files.js";

// The qualifier values this tool's schema offers per entry.
const SCHEMA_QUALIFIERS = (
  jarvisFilesBatchWriteTool.definition.function.parameters as {
    properties: { files: { items: { properties: { qualifier: { enum: string[] } } } } };
  }
).properties.files.items.properties.qualifier.enum;

const QUALIFIER_ERROR =
  "qualifier must be one of: always-read, conditional, reference, workspace, enforce";

type FileRow = {
  path: string;
  title: string;
  content: string;
  tags: string;
  qualifier: string;
  condition: string | null;
  priority: number;
  related_to: string;
};

const row = (path: string) =>
  getDatabase()
    .prepare(
      "SELECT path, title, content, tags, qualifier, condition, priority, related_to FROM jarvis_files WHERE path = ?",
    )
    .get(path) as FileRow | undefined;

// Batch paths only: initDatabase seeds directive rows of its own.
const batchRows = () =>
  getDatabase()
    .prepare(
      "SELECT path, qualifier FROM jarvis_files WHERE path LIKE 'projects/syn-batch/%' ORDER BY path",
    )
    .all() as Array<{ path: string; qualifier: string }>;

const write = async (files: Array<Record<string, unknown>>) =>
  JSON.parse(await jarvisFilesBatchWriteTool.execute({ files })) as {
    success: boolean;
    total: number;
    ok: number;
    errors: number;
    results: Array<{ path: string; status: string; error?: string }>;
  };

let mirror = "";
const savedMirror = process.env.JARVIS_KB_MIRROR_DIR;

beforeAll(() => {
  mirror = mkdtempSync(join(tmpdir(), "jarvis-files-batch-"));
  process.env.JARVIS_KB_MIRROR_DIR = mirror;
});

afterAll(() => {
  try {
    if (savedMirror === undefined) delete process.env.JARVIS_KB_MIRROR_DIR;
    else process.env.JARVIS_KB_MIRROR_DIR = savedMirror;
  } finally {
    rmSync(mirror, { recursive: true, force: true });
  }
});

beforeEach(() => {
  initDatabase(":memory:");
  // initDatabase seeds directive rows through the same writer.
  vi.clearAllMocks();
});

afterEach(() => {
  closeDatabase();
});

describe("jarvis_files_batch_write — the per-entry qualifier on the real schema", () => {
  it("every qualifier the schema offers is accepted and stored ('enforce' as 'reference')", async () => {
    const files = SCHEMA_QUALIFIERS.map((qualifier) => ({
      path: `projects/syn-batch/${qualifier}.md`,
      title: `T ${qualifier}`,
      content: `body ${qualifier}`,
      qualifier,
    }));
    const out = await write(files);
    expect(out).toMatchObject({ success: true, total: 5, ok: 5, errors: 0 });
    expect(batchRows()).toEqual(
      SCHEMA_QUALIFIERS.map((q) => ({
        path: `projects/syn-batch/${q}.md`,
        qualifier: q === "enforce" ? "reference" : q,
      })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    );
  });

  it("an absent or null qualifier takes the default 'reference'", async () => {
    const out = await write([
      { path: "projects/syn-batch/plain.md", title: "Plain", content: "plain body" },
      { path: "projects/syn-batch/zero.md", title: "Zero", content: "zero body", qualifier: null },
    ]);
    expect(out).toEqual({
      success: true,
      total: 2,
      ok: 2,
      errors: 0,
      results: [
        { path: "projects/syn-batch/plain.md", status: "ok" },
        { path: "projects/syn-batch/zero.md", status: "ok" },
      ],
    });
    expect(batchRows()).toEqual([
      { path: "projects/syn-batch/plain.md", qualifier: "reference" },
      { path: "projects/syn-batch/zero.md", qualifier: "reference" },
    ]);
  });

  it("an entry with both a refused path and a wrong qualifier reports the path error", async () => {
    const out = await write([
      { path: "projects/syn-batch/notes.txt", title: "N", content: "n", qualifier: "mandatory" },
    ]);
    expect(out.results).toEqual([
      { path: "projects/syn-batch/notes.txt", status: "error", error: "path must end with .md" },
    ]);
    expect(batchRows()).toEqual([]);
  });

  for (const wrong of ["mandatory", "Reference", "", 7]) {
    it(`a wrong qualifier (${JSON.stringify(wrong)}) is refused for its entry only; the neighbours are written`, async () => {
      const out = await write([
        {
          path: "projects/syn-batch/a.md",
          title: "Title A",
          content: "content a",
          tags: ["tag-a"],
          qualifier: "workspace",
          condition: "cond a",
          priority: 7,
          related_to: ["projects/syn-batch/c.md"],
        },
        { path: "projects/syn-batch/b.md", title: "Title B", content: "content b", qualifier: wrong },
        {
          path: "projects/syn-batch/c.md",
          title: "Title C",
          content: "content c",
          qualifier: "conditional",
          priority: 3,
        },
      ]);
      expect(out).toEqual({
        success: false,
        total: 3,
        ok: 2,
        errors: 1,
        results: [
          { path: "projects/syn-batch/a.md", status: "ok" },
          { path: "projects/syn-batch/b.md", status: "error", error: QUALIFIER_ERROR },
          { path: "projects/syn-batch/c.md", status: "ok" },
        ],
      });
      expect(row("projects/syn-batch/b.md")).toBeUndefined();
      expect(row("projects/syn-batch/a.md")).toEqual({
        path: "projects/syn-batch/a.md",
        title: "Title A",
        content: "content a",
        tags: JSON.stringify(["tag-a"]),
        qualifier: "workspace",
        condition: "cond a",
        priority: 7,
        related_to: JSON.stringify(["projects/syn-batch/c.md"]),
      });
      expect(row("projects/syn-batch/c.md")).toEqual({
        path: "projects/syn-batch/c.md",
        title: "Title C",
        content: "content c",
        tags: "[]",
        qualifier: "conditional",
        condition: null,
        priority: 3,
        related_to: "[]",
      });
      // The vector copy is asked for the written entries only.
      expect(kb.syncToPgvector.mock.calls.map((c) => c[0])).toEqual([
        "projects/syn-batch/a.md",
        "projects/syn-batch/c.md",
      ]);
    });
  }

  it("the schema's qualifier list is exactly the database rule's, which refuses any other value", () => {
    const tableSql = (
      getDatabase()
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'jarvis_files'")
        .get() as { sql: string }
    ).sql;
    const rule = tableSql.match(/CHECK\(qualifier IN \(([^)]*)\)\)/);
    expect(rule).not.toBeNull();
    expect(
      rule![1]
        .split(",")
        .map((v) => v.trim().replace(/^'|'$/g, ""))
        .sort(),
    ).toEqual([...SCHEMA_QUALIFIERS].sort());
    expect(QUALIFIER_ERROR).toBe(`qualifier must be one of: ${SCHEMA_QUALIFIERS.join(", ")}`);

    for (const qualifier of ["mandatory", "Reference", ""]) {
      expect(() =>
        getDatabase()
          .prepare("INSERT INTO jarvis_files (id, path, title, content, qualifier) VALUES (?, ?, 't', 'c', ?)")
          .run("projects/syn-batch/out.md", "projects/syn-batch/out.md", qualifier),
      ).toThrow(/CHECK constraint failed/);
    }
    expect(batchRows()).toEqual([]);
  });
});
