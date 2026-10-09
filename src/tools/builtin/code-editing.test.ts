/**
 * Tests for file_edit tool.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  writeFileSync,
  readFileSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
} from "fs";
import { fileEditTool } from "./code-editing.js";
import { initDatabase, closeDatabase, getDatabase } from "../../db/index.js";
import { upsertFile } from "../../db/jarvis-fs.js";
import { sha8 } from "../../lib/v8-4/readback.js";

const reindexMocks = vi.hoisted(() => ({
  upsertFromDiskWrite: vi.fn(),
  declareReadbackGate: vi.fn(),
}));
vi.mock("../../db/jarvis-reindex.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../db/jarvis-reindex.js")>()),
  upsertFromDiskWrite: reindexMocks.upsertFromDiskWrite,
}));
vi.mock("../../lib/v8-4/readback.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/v8-4/readback.js")>()),
  declareReadbackGate: reindexMocks.declareReadbackGate,
}));

const TEST_DIR = "/tmp/mc-test-code-editing";

describe("file_edit", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("should replace a unique string", async () => {
    const path = `${TEST_DIR}/test.ts`;
    writeFileSync(path, 'const x = "hello";\nconst y = "world";\n');

    const result = JSON.parse(
      await fileEditTool.execute({
        path,
        old_string: '"hello"',
        new_string: '"goodbye"',
      }),
    );

    expect(result.replacements).toBe(1);
    expect(readFileSync(path, "utf-8")).toBe(
      'const x = "goodbye";\nconst y = "world";\n',
    );
  });

  it("should error when old_string not found", async () => {
    const path = `${TEST_DIR}/test.ts`;
    writeFileSync(path, "const x = 1;\n");

    const result = JSON.parse(
      await fileEditTool.execute({
        path,
        old_string: "not in file",
        new_string: "replacement",
      }),
    );

    expect(result.error).toContain("not found");
  });

  it("should error when old_string has multiple matches without replace_all", async () => {
    const path = `${TEST_DIR}/test.ts`;
    writeFileSync(path, "foo\nbar\nfoo\n");

    const result = JSON.parse(
      await fileEditTool.execute({
        path,
        old_string: "foo",
        new_string: "baz",
      }),
    );

    expect(result.error).toContain("2 times");
    expect(result.occurrences).toBe(2);
  });

  it("should replace all occurrences when replace_all is true", async () => {
    const path = `${TEST_DIR}/test.ts`;
    writeFileSync(path, "foo\nbar\nfoo\n");

    const result = JSON.parse(
      await fileEditTool.execute({
        path,
        old_string: "foo",
        new_string: "baz",
        replace_all: true,
      }),
    );

    expect(result.replacements).toBe(2);
    expect(readFileSync(path, "utf-8")).toBe("baz\nbar\nbaz\n");
  });

  it("should error when file does not exist", async () => {
    const result = JSON.parse(
      await fileEditTool.execute({
        path: `${TEST_DIR}/nonexistent.ts`,
        old_string: "x",
        new_string: "y",
      }),
    );

    expect(result.error).toContain("not found");
  });

  it("should error when old_string equals new_string", async () => {
    const path = `${TEST_DIR}/test.ts`;
    writeFileSync(path, "hello\n");

    const result = JSON.parse(
      await fileEditTool.execute({
        path,
        old_string: "hello",
        new_string: "hello",
      }),
    );

    expect(result.error).toContain("identical");
  });

  it("should handle deletion (empty new_string)", async () => {
    const path = `${TEST_DIR}/test.ts`;
    writeFileSync(path, "line1\nline2\nline3\n");

    const result = JSON.parse(
      await fileEditTool.execute({
        path,
        old_string: "line2\n",
        new_string: "",
      }),
    );

    expect(result.replacements).toBe(1);
    expect(readFileSync(path, "utf-8")).toBe("line1\nline3\n");
  });

  it("should preserve whitespace exactly", async () => {
    const path = `${TEST_DIR}/test.ts`;
    writeFileSync(path, "  if (true) {\n    console.log('yes');\n  }\n");

    const result = JSON.parse(
      await fileEditTool.execute({
        path,
        old_string: "    console.log('yes');",
        new_string: "    console.log('no');",
      }),
    );

    expect(result.replacements).toBe(1);
    expect(readFileSync(path, "utf-8")).toBe(
      "  if (true) {\n    console.log('no');\n  }\n",
    );
  });
});

// Audit R2-C2 / R3-W1 (2026-09-01): call-site pin for the disk-side
// standing-orders guard in file_edit (symlink-resolved path).
describe("file_edit — standing orders on disk refused", () => {
  it("refuses an edit under jarvis-kb/directives/ before touching the file", async () => {
    const { getJarvisKbRoot } = await import("../../db/jarvis-fs.js");
    const r = JSON.parse(
      await fileEditTool.execute({
        path: getJarvisKbRoot() + "/directives/core.md",
        old_string: "a",
        new_string: "b",
      }),
    );
    expect(String(r.error)).toMatch(/standing order/);
  });
});

// A SKILL.md registers only through jarvis_file_write (critic-gated).
describe("file_edit — skill definitions on disk refused", () => {
  it("refuses an edit to jarvis-kb/skills/<name>/SKILL.md", async () => {
    const { getJarvisKbRoot } = await import("../../db/jarvis-fs.js");
    const r = JSON.parse(
      await fileEditTool.execute({
        path: getJarvisKbRoot() + "/skills/x-y/SKILL.md",
        old_string: "a",
        new_string: "b",
      }),
    );
    expect(String(r.error)).toMatch(/skill definition/);
  });
});

// audit 2026-09-22 R4: the "write" check does not follow symlinks, but an
// edit reads the file first — a link to a read-blocked file must be refused.
describe("file_edit — symlink to a read-blocked file", () => {
  it("refuses before reading the target", async () => {
    const dir = "/tmp/mc-test-code-editing-link";
    mkdirSync(dir, { recursive: true });
    try {
      symlinkSync("/etc/shadow", `${dir}/ak`);
      const r = JSON.parse(
        await fileEditTool.execute({
          path: `${dir}/ak`,
          old_string: "root:",
          new_string: "x",
        }),
      );
      expect(String(r.error)).toMatch(/Edit blocked/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // audit 2026-09-22 R1 C2: the gates checked the literal path, and
  // writeFileSync follows the link. old_string is absent, so nothing is written
  // even when the guard is broken.
  it("gates the symlink target, not the link", async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    try {
      symlinkSync(
        "/root/claude/mission-control/package.json",
        `${TEST_DIR}/pj`,
      );
      const r = JSON.parse(
        await fileEditTool.execute({
          path: `${TEST_DIR}/pj`,
          old_string: "__never_present_in_package_json__",
          new_string: "x",
        }),
      );
      expect(String(r.error)).toMatch(/Edit blocked/);
    } finally {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });
});

// Queue §2026-10-08 item 11: an edit under the KB root reaches the registry
// (W1's first false positive graded a stale registry copy of a file_edit).
describe("file_edit — KB registry parity (item 11)", () => {
  const KB = "/tmp/mc-test-code-editing-kb";
  let prevMirror: string | undefined;

  beforeEach(() => {
    prevMirror = process.env.JARVIS_KB_MIRROR_DIR;
    process.env.JARVIS_KB_MIRROR_DIR = KB;
    mkdirSync(`${KB}/knowledge`, { recursive: true });
    mkdirSync(`${KB}/logs/day-logs`, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    reindexMocks.upsertFromDiskWrite.mockReset();
    reindexMocks.declareReadbackGate.mockReset();
    initDatabase(":memory:");
  });

  afterEach(() => {
    closeDatabase();
    if (prevMirror === undefined) delete process.env.JARVIS_KB_MIRROR_DIR;
    else process.env.JARVIS_KB_MIRROR_DIR = prevMirror;
    rmSync(KB, { recursive: true, force: true });
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("upserts the registry row with the rel path and the NEW content", async () => {
    writeFileSync(`${KB}/knowledge/n.md`, "# N\nold line\n");
    const r = JSON.parse(
      await fileEditTool.execute({
        path: `${KB}/knowledge/n.md`,
        old_string: "old line",
        new_string: "new line",
      }),
    );
    expect(r.replacements).toBe(1);
    expect(r.registry_error).toBeUndefined();
    expect(reindexMocks.upsertFromDiskWrite).toHaveBeenCalledTimes(1);
    expect(reindexMocks.upsertFromDiskWrite).toHaveBeenCalledWith(
      "knowledge/n.md",
      "# N\nnew line\n",
    );
    expect(reindexMocks.declareReadbackGate).toHaveBeenCalledTimes(1);
    expect(reindexMocks.declareReadbackGate).toHaveBeenCalledWith(
      undefined,
      "file_edit",
      "kb:knowledge/n.md",
      "KB knowledge/n.md escrito y legible",
      { path: "knowledge/n.md", sha8: sha8("# N\nnew line\n") },
    );
  });

  it("does not touch the registry for an edit outside the KB root", async () => {
    writeFileSync(`${TEST_DIR}/n.md`, "old line\n");
    const r = JSON.parse(
      await fileEditTool.execute({
        path: `${TEST_DIR}/n.md`,
        old_string: "old line",
        new_string: "new line",
      }),
    );
    expect(r.replacements).toBe(1);
    expect(reindexMocks.upsertFromDiskWrite).not.toHaveBeenCalled();
    expect(reindexMocks.declareReadbackGate).not.toHaveBeenCalled();
  });

  it("refuses a day-log edit and leaves the file bytes unchanged", async () => {
    const p = `${KB}/logs/day-logs/2026-09-01.md`;
    writeFileSync(p, "verbatim\n");
    const r = JSON.parse(
      await fileEditTool.execute({ path: p, old_string: "verbatim", new_string: "x" }),
    );
    expect(String(r.error)).toMatch(/^Edit blocked: logs\/day-logs\/ is mechanically managed/);
    expect(readFileSync(p, "utf-8")).toBe("verbatim\n");
    expect(reindexMocks.upsertFromDiskWrite).not.toHaveBeenCalled();
  });

  it("reports a registry failure on the success JSON; the file is written", async () => {
    reindexMocks.upsertFromDiskWrite.mockImplementation(() => {
      throw new Error("db closed");
    });
    const p = `${KB}/knowledge/f.md`;
    writeFileSync(p, "old line\n");
    const r = JSON.parse(
      await fileEditTool.execute({ path: p, old_string: "old line", new_string: "new line" }),
    );
    expect(r.error).toBeUndefined();
    expect(r.path).toBe(p);
    expect(r.registry_error).toBe("db closed");
    expect(readFileSync(p, "utf-8")).toBe("new line\n");
    // The gate is declared anyway, so the stale row fails the read-back.
    expect(reindexMocks.declareReadbackGate).toHaveBeenCalledTimes(1);
  });

  // The day-log refusal judges the realpath: a link outside the KB root that
  // points INTO logs/day-logs/ is refused too (fold F3).
  it("refuses a day-log edit made through a symlink outside the KB root", async () => {
    const target = `${KB}/logs/day-logs/d.md`;
    writeFileSync(target, "verbatim\n");
    symlinkSync(target, `${TEST_DIR}/link.md`);
    const r = JSON.parse(
      await fileEditTool.execute({
        path: `${TEST_DIR}/link.md`,
        old_string: "verbatim",
        new_string: "x",
      }),
    );
    expect(String(r.error)).toMatch(/^Edit blocked:/);
    expect(readFileSync(target, "utf-8")).toBe("verbatim\n");
  });

  // Fold F1: a disk copy OLDER than a different registry row is stale — an
  // edit would push it over the newer row, so it is refused before writing.
  it("refuses when the registry row is newer than the disk copy and differs", async () => {
    upsertFile("knowledge/r.md", "R", "# R\nregistry truth\n");
    const p = `${KB}/knowledge/r.md`;
    writeFileSync(p, "# R\nold line\n");
    const old = new Date(Date.now() - 3600_000);
    utimesSync(p, old, old);
    const r = JSON.parse(
      await fileEditTool.execute({ path: p, old_string: "old line", new_string: "new line" }),
    );
    expect(String(r.error)).toBe(
      "Edit blocked: the KB registry copy of knowledge/r.md is newer than the disk file — read it with jarvis_file_read and write it with jarvis_file_write",
    );
    expect(readFileSync(p, "utf-8")).toBe("# R\nold line\n");
    expect(reindexMocks.upsertFromDiskWrite).not.toHaveBeenCalled();
    expect(reindexMocks.declareReadbackGate).not.toHaveBeenCalled();
  });

  it("proceeds when the registry row is newer but holds the same bytes", async () => {
    upsertFile("knowledge/s.md", "S", "# S\nold line\n");
    const p = `${KB}/knowledge/s.md`;
    const old = new Date(Date.now() - 3600_000);
    utimesSync(p, old, old);
    const r = JSON.parse(
      await fileEditTool.execute({ path: p, old_string: "old line", new_string: "new line" }),
    );
    expect(r.replacements).toBe(1);
    expect(reindexMocks.upsertFromDiskWrite).toHaveBeenCalledWith("knowledge/s.md", "# S\nnew line\n");
  });

  it("proceeds when the disk copy is newer than a different registry row", async () => {
    upsertFile("knowledge/d.md", "D", "# D\nregistry copy\n");
    getDatabase()
      .prepare("UPDATE jarvis_files SET updated_at = ? WHERE path = ?")
      .run("2026-01-01 00:00:00", "knowledge/d.md");
    const p = `${KB}/knowledge/d.md`;
    writeFileSync(p, "# D\nold line\n");
    const r = JSON.parse(
      await fileEditTool.execute({ path: p, old_string: "old line", new_string: "new line" }),
    );
    expect(r.error).toBeUndefined();
    expect(r.replacements).toBe(1);
    expect(readFileSync(p, "utf-8")).toBe("# D\nnew line\n");
    expect(reindexMocks.upsertFromDiskWrite).toHaveBeenCalledWith("knowledge/d.md", "# D\nnew line\n");
  });
});
