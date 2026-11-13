/**
 * Tests for file_read large-file behavior (Session 114).
 *
 * Mocks node:fs so the tests don't need real files. The non-truncation paths
 * (path-safety, .docx) are exercised in integration; this file focuses on the
 * Tier B contract: structured envelope on large files + lines parameter.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  mockReadFileSync: vi.fn(),
  mockExecFileSync: vi.fn(() => "main"),
  mockStatSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
  // The path walk's probe: no component exists, so a path is judged as spelled.
  mockLstatSync: vi.fn((_p: string): never => { throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" }); }),
  upsertFromDiskWrite: vi.fn(),
  declareReadbackGate: vi.fn(),
}));

vi.mock("fs", () => ({
  readFileSync: mocks.mockReadFileSync,
  writeFileSync: mocks.mockWriteFileSync,
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
  statSync: mocks.mockStatSync,
  lstatSync: mocks.mockLstatSync,
}));

vi.mock("child_process", () => ({
  execFileSync: mocks.mockExecFileSync,
}));

vi.mock("../../db/jarvis-reindex.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../db/jarvis-reindex.js")>()),
  upsertFromDiskWrite: mocks.upsertFromDiskWrite,
}));

vi.mock("../../lib/v8-4/readback.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/v8-4/readback.js")>()),
  declareReadbackGate: mocks.declareReadbackGate,
}));

import { fileReadTool } from "./file.js";

describe("file_read — Session 114 large-file behavior", () => {
  beforeEach(() => {
    mocks.mockReadFileSync.mockReset();
  });

  it("returns full content + total_chars for small files", async () => {
    mocks.mockReadFileSync.mockReturnValueOnce("# small\nline 2\nline 3");

    const result = await fileReadTool.execute({ path: "/tmp/small.md" });
    const parsed = JSON.parse(result);

    expect(parsed.content).toBe("# small\nline 2\nline 3");
    expect(parsed.total_chars).toBe(21);
    expect(parsed.total_lines).toBe(3);
    expect(parsed.truncated).toBeUndefined();
  });

  it("returns structured envelope on large files (>8k)", async () => {
    const big =
      "# Top\n\n## Section A\nA body\n\n## Section B\nB body\n\n" +
      "x".repeat(10_000);
    mocks.mockReadFileSync.mockReturnValueOnce(big);

    const result = await fileReadTool.execute({ path: "/tmp/big.md" });
    const parsed = JSON.parse(result);

    expect(parsed.truncated).toBe(true);
    expect(parsed.total_chars).toBe(big.length);
    expect(parsed.total_lines).toBeGreaterThan(0);
    expect(parsed.outline).toEqual(
      expect.arrayContaining([expect.stringMatching(/^L\d+: # /)]),
    );
    expect(parsed.outline.some((h: string) => h.includes("Section A"))).toBe(
      true,
    );
    expect(parsed.preview.length).toBeLessThanOrEqual(1500);
    expect(parsed.next_steps.join(" ")).toContain("lines=");
    expect(parsed.content).toBeUndefined();
  });

  it("returns the requested slice when lines is provided", async () => {
    const content = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join(
      "\n",
    );
    mocks.mockReadFileSync.mockReturnValueOnce(content);

    const result = await fileReadTool.execute({
      path: "/tmp/x.md",
      lines: "5-7",
    });
    const parsed = JSON.parse(result);

    expect(parsed.content).toBe("line 5\nline 6\nline 7");
    expect(parsed.lines).toBe("5-7");
    expect(parsed.slice_lines).toBe(3);
    expect(parsed.total_lines).toBe(100);
    expect(parsed.truncated).toBeUndefined();
  });

  it("supports comma-separated multiple ranges", async () => {
    const content = Array.from({ length: 50 }, (_, i) => `L${i + 1}`).join(
      "\n",
    );
    mocks.mockReadFileSync.mockReturnValueOnce(content);

    const result = await fileReadTool.execute({
      path: "/tmp/x.md",
      lines: "1-2,10-11",
    });
    const parsed = JSON.parse(result);

    expect(parsed.content).toBe("L1\nL2\nL10\nL11");
    expect(parsed.slice_lines).toBe(4);
  });

  it("clamps out-of-range slices and flags clamped", async () => {
    mocks.mockReadFileSync.mockReturnValueOnce("L1\nL2\nL3");

    const result = await fileReadTool.execute({
      path: "/tmp/x.md",
      lines: "1-1000",
    });
    const parsed = JSON.parse(result);

    expect(parsed.content).toBe("L1\nL2\nL3");
    expect(parsed.clamped).toBe(true);
    expect(parsed.total_lines).toBe(3);
  });

  it("returns error envelope for malformed lines spec", async () => {
    mocks.mockReadFileSync.mockReturnValueOnce("hello");

    const result = await fileReadTool.execute({
      path: "/tmp/x.md",
      lines: "garbage",
    });
    const parsed = JSON.parse(result);

    expect(parsed.error).toContain("Invalid lines spec");
    expect(parsed.content).toBeUndefined();
  });

  it("coerces numeric `lines` arg rather than crashing (qa W3)", async () => {
    mocks.mockReadFileSync.mockReturnValueOnce("L1\nL2\nL3");
    const result = await fileReadTool.execute({
      path: "/tmp/x.md",
      lines: 2,
    });
    const parsed = JSON.parse(result);
    expect(parsed.content).toBe("L2");
    expect(parsed.lines).toBe("2");
  });

  it("normalizes CRLF in slices (qa W4)", async () => {
    mocks.mockReadFileSync.mockReturnValueOnce("L1\r\nL2\r\nL3\r\n");
    const result = await fileReadTool.execute({
      path: "/tmp/crlf.md",
      lines: "1-2",
    });
    const parsed = JSON.parse(result);
    expect(parsed.content).toBe("L1\nL2");
    expect(parsed.content).not.toMatch(/\r/);
  });

  it("caps very large slice payloads at MAX_READ to prevent payload DoS", async () => {
    // Single line that's bigger than MAX_READ; lines=1 still returns content
    // but it gets sliced down.
    const huge = "x".repeat(60_000);
    mocks.mockReadFileSync.mockReturnValueOnce(huge);

    const result = await fileReadTool.execute({
      path: "/tmp/huge.txt",
      lines: "1-1",
    });
    const parsed = JSON.parse(result);

    expect(parsed.content.length).toBeLessThanOrEqual(50_000);
    expect(parsed.slice_capped).toBe(true);
  });
});

// Audit R2-C2 / R3-W1 (2026-09-01): the disk-side standing-orders guard is
// pinned at its CALL SITES, not only on the helper — deleting the wiring in
// file.ts must go RED here. `file_delete` runs its own gate chain (never
// isWriteAllowed) and the KB root is on the allow-list, so both tools are pinned.
describe("standing orders on disk (jarvis-kb/directives/) — file_write / file_delete refuse", () => {
  it("file_write refuses a path under the KB directives tree", async () => {
    const { fileWriteTool } = await import("./file.js");
    const { getJarvisKbRoot } = await import("../../db/jarvis-fs.js");
    const r = JSON.parse(
      await fileWriteTool.execute({
        path: getJarvisKbRoot() + "/directives/core.md",
        content: "rewritten",
      }),
    );
    expect(String(r.error)).toMatch(/standing order/);
  });

  it("file_delete refuses the directory itself and any spelling under it, FIRST", async () => {
    const { fileDeleteTool } = await import("./file.js");
    const { getJarvisKbRoot } = await import("../../db/jarvis-fs.js");
    const root = getJarvisKbRoot();
    for (const p of [
      root + "/directives",
      root + "/directives/core.md",
      root + "/knowledge/../directives/core.md",
    ]) {
      const r = JSON.parse(await fileDeleteTool.execute({ path: p }));
      expect(String(r.error), p).toMatch(/standing order/);
    }
  });

  it("file_delete leaves neighbours to the other guards", async () => {
    const { fileDeleteTool } = await import("./file.js");
    const { getJarvisKbRoot } = await import("../../db/jarvis-fs.js");
    const r = JSON.parse(
      await fileDeleteTool.execute({ path: getJarvisKbRoot() + "/directive-notes/x.md" }),
    );
    expect(String(r.error ?? "")).not.toMatch(/standing order/);
  });
});

// NorthStar retired (operator ruling 2026-11-03, audit R1-C1): the disk
// mirror is refused to file_read / file_write / file_delete with one stable
// reason. Paths are fake (fs is mocked) — never the live KB.
describe("NorthStar retired on disk (jarvis-kb/NorthStar/) — file_read / file_write / file_delete refuse", () => {
  const REASON =
    "NORTHSTAR_RETIRED: jarvis-kb/NorthStar/ is retired — tasks, goals and objectives come from the projects list (project_list, projects/{slug}/README.md) plus the day-log (logs/day-logs/)";
  const FAKE = "/tmp/mc-fake-kb/jarvis-kb";
  const spellings = (root: string) => [
    root + "/NorthStar",
    root + "/NorthStar/",
    root + "/NorthStar/goals/g1.md",
    root + "/northstar/x.md",
    root + "/NORTHSTAR/x.md",
    root + "/projects/../NorthStar/x.md",
  ];

  beforeEach(() => {
    mocks.mockReadFileSync.mockReset();
    mocks.mockWriteFileSync.mockReset();
  });

  it("file_read refuses every spelling under a jarvis-kb NorthStar tree and never reads", async () => {
    const { fileReadTool: read } = await import("./file.js");
    for (const p of spellings(FAKE)) {
      const r = JSON.parse(await read.execute({ path: p }));
      expect(String(r.error), p).toBe(`Read blocked: ${REASON}`);
    }
    expect(mocks.mockReadFileSync).not.toHaveBeenCalled();
  });

  it("file_write refuses the KB root's NorthStar tree and a jarvis-kb one, and never writes", async () => {
    const { fileWriteTool } = await import("./file.js");
    const { getJarvisKbRoot } = await import("../../db/jarvis-fs.js");
    for (const p of [...spellings(getJarvisKbRoot()), ...spellings(FAKE)]) {
      const r = JSON.parse(await fileWriteTool.execute({ path: p, content: "x" }));
      expect(String(r.error), p).toMatch(/NORTHSTAR_RETIRED/);
    }
    expect(mocks.mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("file_delete refuses the directory itself and any spelling under it", async () => {
    const { fileDeleteTool } = await import("./file.js");
    const { getJarvisKbRoot } = await import("../../db/jarvis-fs.js");
    for (const p of [...spellings(getJarvisKbRoot()), ...spellings(FAKE)]) {
      const r = JSON.parse(await fileDeleteTool.execute({ path: p }));
      expect(String(r.error), p).toBe(`Deletion blocked: ${REASON}`);
    }
  });

  it("neighbours (northstar-notes/, projects/) are left to the other guards", async () => {
    const { fileReadTool: read } = await import("./file.js");
    mocks.mockReadFileSync.mockReturnValue("ok");
    mocks.mockStatSync.mockReturnValue({ size: 2, isFile: () => true, isDirectory: () => false });
    for (const p of [FAKE + "/northstar-notes/x.md", FAKE + "/projects/alpha/README.md"]) {
      const r = await read.execute({ path: p });
      expect(r, p).not.toMatch(/NORTHSTAR_RETIRED/);
    }
  });
});

// S6 WS1: the disk twin of projectRecordGuard, pinned at its CALL SITES —
// the hourly kb-reindex refreshes a record from disk, so file_write and
// file_delete are doors into it. file_read stays allowed.
describe("project record on disk (jarvis-kb/projects/<slug>/project.md) — file_write / file_delete refuse", () => {
  it("file_write refuses the record in any spelling", async () => {
    const { fileWriteTool } = await import("./file.js");
    const { getJarvisKbRoot } = await import("../../db/jarvis-fs.js");
    const root = getJarvisKbRoot();
    for (const p of [
      root + "/projects/acme-radar/project.md",
      root + "/Projects/Acme-Radar/Project.md",
      root + "/knowledge/../projects/acme-radar/project.md",
    ]) {
      const r = JSON.parse(await fileWriteTool.execute({ path: p, content: "x" }));
      expect(String(r.error), p).toMatch(/PROJECT_RECORD_PROTECTED/);
    }
    expect(mocks.mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("file_write lets other files under projects/ through this guard", async () => {
    const { fileWriteTool } = await import("./file.js");
    const { getJarvisKbRoot } = await import("../../db/jarvis-fs.js");
    const r = JSON.parse(
      await fileWriteTool.execute({
        path: getJarvisKbRoot() + "/projects/acme-radar/README.md",
        content: "notes",
      }),
    );
    expect(String(r.error ?? "")).not.toMatch(/PROJECT_RECORD_PROTECTED/);
  });

  it("file_delete refuses the record, its folder and projects/ itself", async () => {
    const { fileDeleteTool } = await import("./file.js");
    const { getJarvisKbRoot } = await import("../../db/jarvis-fs.js");
    const root = getJarvisKbRoot();
    for (const p of [
      root + "/projects",
      root + "/projects/acme-radar",
      root + "/projects/acme-radar/project.md",
      root + "/knowledge/../projects/acme-radar/project.md",
    ]) {
      const r = JSON.parse(await fileDeleteTool.execute({ path: p }));
      expect(String(r.error), p).toMatch(/PROJECT_RECORD_PROTECTED/);
    }
  });

  it("file_delete leaves a README under projects/ to the other guards", async () => {
    const { fileDeleteTool } = await import("./file.js");
    const { getJarvisKbRoot } = await import("../../db/jarvis-fs.js");
    const r = JSON.parse(
      await fileDeleteTool.execute({ path: getJarvisKbRoot() + "/projects/acme-radar/README.md" }),
    );
    expect(String(r.error ?? "")).not.toMatch(/PROJECT_RECORD_PROTECTED/);
  });

  it("file_read of the record is allowed", async () => {
    const { getJarvisKbRoot } = await import("../../db/jarvis-fs.js");
    mocks.mockReadFileSync.mockReturnValueOnce("```json\n{}\n```\n");
    const r = JSON.parse(
      await fileReadTool.execute({ path: getJarvisKbRoot() + "/projects/acme-radar/project.md" }),
    );
    expect(r.error).toBeUndefined();
    expect(r.content).toBe("```json\n{}\n```\n");
  });
});

// A SKILL.md registers only through jarvis_file_write (critic-gated).
describe("skill definitions on disk (jarvis-kb/skills/*/SKILL.md) — file_write refuses", () => {
  it("file_write refuses a SKILL.md and lets other skill files through the guard", async () => {
    const { fileWriteTool } = await import("./file.js");
    const { getJarvisKbRoot } = await import("../../db/jarvis-fs.js");
    const blocked = JSON.parse(
      await fileWriteTool.execute({
        path: getJarvisKbRoot() + "/skills/x-y/SKILL.md",
        content: "---",
      }),
    );
    expect(String(blocked.error)).toMatch(/skill definition/);
    const other = JSON.parse(
      await fileWriteTool.execute({
        path: getJarvisKbRoot() + "/skills/x-y/REFERENCE.md",
        content: "notes",
      }),
    );
    expect(String(other.error ?? "")).not.toMatch(/skill definition/);
  });
});

// audit 2026-09-22: content_file was read with no read guard, so file_write
// could copy /proc/self/environ or a credential file into /tmp for file_read.
describe("file_write content_file — read denylist", () => {
  it("refuses blocked content_file sources before reading them", async () => {
    const { fileWriteTool } = await import("./file.js");
    for (const src of ["/proc/self/environ", "/root/.claude.json", "/root/.docker/config.json"]) {
      mocks.mockReadFileSync.mockClear();
      const r = JSON.parse(await fileWriteTool.execute({ path: "/tmp/x-copy", content_file: src }));
      expect(String(r.error), src).toMatch(/content_file blocked/);
      expect(mocks.mockReadFileSync, src).not.toHaveBeenCalledWith(src, "utf-8");
    }
  });
});

// Queue §2026-10-08 item 11: a write under the KB root reaches the registry.
describe("file_write — KB registry parity (item 11)", () => {
  beforeEach(() => {
    mocks.mockWriteFileSync.mockReset();
    mocks.upsertFromDiskWrite.mockReset();
    mocks.declareReadbackGate.mockReset();
  });

  it("upserts the registry row with the rel path and the content", async () => {
    const { fileWriteTool } = await import("./file.js");
    const { getJarvisKbRoot } = await import("../../db/jarvis-fs.js");
    const r = JSON.parse(
      await fileWriteTool.execute({
        path: getJarvisKbRoot() + "/knowledge/w.md",
        content: "# W\nbody",
      }),
    );
    expect(r.bytes_written).toBe(8);
    expect(r.registry_error).toBeUndefined();
    expect(mocks.upsertFromDiskWrite).toHaveBeenCalledTimes(1);
    expect(mocks.upsertFromDiskWrite).toHaveBeenCalledWith("knowledge/w.md", "# W\nbody");
    const { sha8 } = await import("../../lib/v8-4/readback.js");
    expect(mocks.declareReadbackGate).toHaveBeenCalledTimes(1);
    expect(mocks.declareReadbackGate).toHaveBeenCalledWith(
      undefined,
      "file_write",
      "kb:knowledge/w.md",
      "KB knowledge/w.md escrito y legible",
      { path: "knowledge/w.md", sha8: sha8("# W\nbody") },
    );
  });

  it("does not touch the registry for a write outside the KB root", async () => {
    const { fileWriteTool } = await import("./file.js");
    const r = JSON.parse(
      await fileWriteTool.execute({ path: "/tmp/mc-file-test-out/w.md", content: "x" }),
    );
    expect(r.bytes_written).toBe(1);
    expect(mocks.upsertFromDiskWrite).not.toHaveBeenCalled();
    expect(mocks.declareReadbackGate).not.toHaveBeenCalled();
  });

  it("refuses a day-log path before writing", async () => {
    const { fileWriteTool } = await import("./file.js");
    const { getJarvisKbRoot } = await import("../../db/jarvis-fs.js");
    const r = JSON.parse(
      await fileWriteTool.execute({
        path: getJarvisKbRoot() + "/logs/day-logs/2026-09-01.md",
        content: "stub",
      }),
    );
    expect(String(r.error)).toMatch(/^Write blocked: logs\/day-logs\/ is mechanically managed/);
    expect(mocks.mockWriteFileSync).not.toHaveBeenCalled();
    expect(mocks.upsertFromDiskWrite).not.toHaveBeenCalled();
  });

  it("reports a registry failure on the success JSON", async () => {
    mocks.upsertFromDiskWrite.mockImplementation(() => {
      throw new Error("db closed");
    });
    const { fileWriteTool } = await import("./file.js");
    const { getJarvisKbRoot } = await import("../../db/jarvis-fs.js");
    const r = JSON.parse(
      await fileWriteTool.execute({
        path: getJarvisKbRoot() + "/knowledge/f.md",
        content: "abc",
      }),
    );
    expect(r.error).toBeUndefined();
    expect(r.bytes_written).toBe(3);
    expect(r.registry_error).toBe("db closed");
    expect(mocks.mockWriteFileSync).toHaveBeenCalledTimes(1);
    // The gate is declared anyway, so the stale row fails the read-back.
    expect(mocks.declareReadbackGate).toHaveBeenCalledTimes(1);
  });
});

// Only an error reported by the file system means a path component is missing;
// any other error from the walk's probe ends the check, and nothing is written.
describe("file_write — the path walk fails closed", () => {
  const missing = mocks.mockLstatSync.getMockImplementation()!;
  const WRITE = { path: "/tmp/mc-file-test-out/w.md", content: "x" };
  /** Walk `n` of the path (each walk probes `/tmp` once) throws a RangeError; `n` 0 = every walk. Returns the walk count. */
  const throwOnWalk = (n: number) => {
    const walks = { count: 0 };
    mocks.mockLstatSync.mockImplementation((p: string): never => {
      if (p === "/tmp" && (++walks.count === n || n === 0)) throw new RangeError("Maximum call stack size exceeded");
      return missing(p);
    });
    return walks;
  };

  beforeEach(() => mocks.mockWriteFileSync.mockReset());
  afterEach(() => {
    mocks.mockLstatSync.mockImplementation(missing);
  });

  it("throws without writing when every walk of the path fails with an error that is not about the path", async () => {
    throwOnWalk(0);
    const { fileWriteTool } = await import("./file.js");
    await expect(fileWriteTool.execute(WRITE)).rejects.toThrow(RangeError);
    expect(mocks.mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("throws without writing when only the first walk (the /proc-link check) fails", async () => {
    throwOnWalk(1);
    const { fileWriteTool } = await import("./file.js");
    await expect(fileWriteTool.execute(WRITE)).rejects.toThrow(RangeError);
    expect(mocks.mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("throws without writing when only the write-boundary walk fails", async () => {
    const { fileWriteTool } = await import("./file.js");
    // The path is walked four times: the path-safety check's /proc-link check and
    // write resolve, the write boundary's resolve, then the registry path.
    const baseline = throwOnWalk(-1);
    await fileWriteTool.execute(WRITE);
    expect(baseline.count).toBe(4);
    mocks.mockWriteFileSync.mockReset();
    throwOnWalk(3);
    await expect(fileWriteTool.execute(WRITE)).rejects.toThrow(RangeError);
    expect(mocks.mockWriteFileSync).not.toHaveBeenCalled();
  });
});

describe("file_read — evicted tool result past its retention window", () => {
  const enoent = (p: string) =>
    Object.assign(
      new Error(`ENOENT: no such file or directory, open '${p}'`),
      { code: "ENOENT" },
    );

  beforeEach(() => {
    mocks.mockReadFileSync.mockReset();
  });

  it("answers expired: true with a pruned notice for a missing evicted file", async () => {
    const p = "/root/claude/mission-control/tool-results/web-read-1-abcd.txt";
    mocks.mockReadFileSync.mockImplementationOnce(() => {
      throw enoent(p);
    });
    const parsed = JSON.parse(await fileReadTool.execute({ path: p }));
    expect(parsed.expired).toBe(true);
    expect(parsed.error).toMatch(/pruned after its one-hour retention window/);
    // The model decides whether the content is still needed (Hermes #139894).
    expect(parsed.error).not.toMatch(/re-?run|run again|call again/i);
  });

  it("keeps the plain error for a missing file elsewhere", async () => {
    const p = "/tmp/missing.txt";
    mocks.mockReadFileSync.mockImplementationOnce(() => {
      throw enoent(p);
    });
    const parsed = JSON.parse(await fileReadTool.execute({ path: p }));
    expect(parsed).toEqual({
      error: `ENOENT: no such file or directory, open '${p}'`,
    });
  });

  it("keeps the plain error for a non-ENOENT failure inside the eviction dir", async () => {
    const p = "/root/claude/mission-control/tool-results/web-read-2.txt";
    mocks.mockReadFileSync.mockImplementationOnce(() => {
      throw Object.assign(new Error("EACCES: permission denied"), {
        code: "EACCES",
      });
    });
    const parsed = JSON.parse(await fileReadTool.execute({ path: p }));
    expect(parsed).toEqual({ error: "EACCES: permission denied" });
  });
});
