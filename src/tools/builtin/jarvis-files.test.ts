import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mockRun = vi.fn().mockReturnValue({ changes: 1 });
const mockGet = vi.fn();
const mockAll = vi.fn().mockReturnValue([]);
const mockDb = {
  prepare: vi.fn().mockReturnValue({
    run: mockRun,
    get: mockGet,
    all: mockAll,
  }),
  exec: vi.fn(),
};

vi.mock("../../db/index.js", () => ({
  getDatabase: () => mockDb,
}));

vi.mock("node:fs", () => ({
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  // Silence syncDeleteFromKbMirror's existsSync/rmSync probes during
  // delete-path tests. Pre-existing noise; multiplied by batch tests.
  existsSync: vi.fn().mockReturnValue(false),
  rmSync: vi.fn(),
}));

import {
  jarvisFileReadTool,
  jarvisFileWriteTool,
  jarvisFileUpdateTool,
  jarvisFileListTool,
  jarvisFileDeleteTool,
  jarvisFilesBatchWriteTool,
  jarvisFilesBatchDeleteTool,
} from "./jarvis-files.js";
import { getFilesByQualifier } from "../../db/jarvis-fs.js";

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.prepare.mockReturnValue({
    run: mockRun,
    get: mockGet,
    all: mockAll,
  });
});

describe("jarvis_file_write", () => {
  it("inserts a file with correct parameters", async () => {
    const result = await jarvisFileWriteTool.execute({
      path: "DIRECTIVES.md",
      title: "Core Directives",
      content: "# Directives\n\nBe helpful.",
      tags: ["directive", "enforce"],
      qualifier: "enforce",
      priority: 0,
    });

    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(true);
    expect(parsed.path).toBe("DIRECTIVES.md");
    expect(mockDb.prepare).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO jarvis_files"),
    );
    expect(mockRun).toHaveBeenCalled();
  });

  it("rejects files not ending in .md", async () => {
    const result = await jarvisFileWriteTool.execute({
      path: "notes.txt",
      title: "Notes",
      content: "hello",
    });

    expect(JSON.parse(result).error).toContain(".md");
    expect(mockRun).not.toHaveBeenCalled();
  });
});

describe("jarvis_file_read", () => {
  it("reads a file by path", async () => {
    mockGet.mockReturnValueOnce({
      id: "directives",
      path: "DIRECTIVES.md",
      title: "Core Directives",
      content: "# Be helpful",
      tags: '["directive"]',
      qualifier: "enforce",
      condition: null,
      priority: 0,
      related_to: "[]",
      updated_at: "2026-04-02",
    });

    const result = await jarvisFileReadTool.execute({
      path: "DIRECTIVES.md",
    });
    const parsed = JSON.parse(result);
    expect(parsed.title).toBe("Core Directives");
    expect(parsed.content).toBe("# Be helpful");
    expect(parsed.tags).toEqual(["directive"]);
  });

  it("returns error for missing file", async () => {
    mockGet.mockReturnValueOnce(undefined);
    const result = await jarvisFileReadTool.execute({
      path: "nonexistent.md",
    });
    expect(JSON.parse(result).error).toContain("not found");
  });

  it("searches by tags", async () => {
    mockAll.mockReturnValueOnce([
      {
        path: "context/crm.md",
        title: "CRM Context",
        tags: '["crm","sales"]',
        qualifier: "conditional",
        priority: 30,
        preview: "# CRM Pipeline...",
      },
    ]);

    const result = await jarvisFileReadTool.execute({
      tags: ["crm"],
    });
    const parsed = JSON.parse(result);
    expect(parsed.total).toBe(1);
    expect(parsed.results[0].path).toBe("context/crm.md");
  });

  it("includes total_chars + total_lines on small files (Session 114)", async () => {
    mockGet.mockReturnValueOnce({
      id: "small",
      path: "notes/small.md",
      title: "Small note",
      content: "# Title\n\nLine 2\nLine 3",
      tags: "[]",
      qualifier: "reference",
      condition: null,
      priority: 0,
      related_to: "[]",
      updated_at: "2026-04-29",
    });

    const result = await jarvisFileReadTool.execute({ path: "notes/small.md" });
    const parsed = JSON.parse(result);
    expect(parsed.content).toContain("Line 3");
    expect(parsed.total_chars).toBe(22);
    expect(parsed.total_lines).toBe(4);
    expect(parsed.truncated).toBeUndefined();
  });

  it("returns structured envelope on large files instead of full content (Session 114)", async () => {
    // 12k chars > LARGE_FILE_THRESHOLD (8000) → truncated path fires
    const big =
      ["# Section 1", "intro paragraph", "", "## Subsection", "details"].join(
        "\n",
      ) +
      "\n" +
      "x".repeat(12_000);
    mockGet.mockReturnValueOnce({
      id: "big",
      path: "logs/day-logs/2026-04-04.md",
      title: "Day Log",
      content: big,
      tags: "[]",
      qualifier: "reference",
      condition: null,
      priority: 0,
      related_to: "[]",
      updated_at: "2026-04-29",
    });

    const result = await jarvisFileReadTool.execute({
      path: "logs/day-logs/2026-04-04.md",
    });
    const parsed = JSON.parse(result);

    // Top-level signal — not buried in content
    expect(parsed.truncated).toBe(true);
    expect(parsed.total_chars).toBe(big.length);
    expect(parsed.total_lines).toBeGreaterThan(0);
    // Outline includes line numbers — load-bearing for the "lines=N-M" workflow
    expect(parsed.outline).toEqual(
      expect.arrayContaining([expect.stringMatching(/^L\d+: # /)]),
    );
    expect(parsed.outline.some((h: string) => h.includes("Section 1"))).toBe(
      true,
    );
    expect(parsed.outline.some((h: string) => h.includes("Subsection"))).toBe(
      true,
    );
    // Preview is short (~1500 chars) so the LLM doesn't form conclusions from it
    expect(parsed.preview.length).toBeLessThanOrEqual(1500);
    // next_steps explicitly tells the model the next call shape
    expect(parsed.next_steps.join(" ")).toContain("lines=");
    // Full content NOT in response
    expect(parsed.content).toBeUndefined();
  });

  it("returns the requested slice when lines is provided (Session 114)", async () => {
    const content = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join(
      "\n",
    );
    mockGet.mockReturnValueOnce({
      id: "x",
      path: "logs/x.md",
      title: "x",
      content,
      tags: "[]",
      qualifier: "reference",
      condition: null,
      priority: 0,
      related_to: "[]",
      updated_at: "2026-04-29",
    });

    const result = await jarvisFileReadTool.execute({
      path: "logs/x.md",
      lines: "5-7",
    });
    const parsed = JSON.parse(result);
    expect(parsed.content).toBe("line 5\nline 6\nline 7");
    expect(parsed.lines).toBe("5-7");
    expect(parsed.slice_lines).toBe(3);
    expect(parsed.total_lines).toBe(100);
  });

  it("supports multiple comma-separated ranges (Session 114)", async () => {
    const content = Array.from({ length: 50 }, (_, i) => `L${i + 1}`).join(
      "\n",
    );
    mockGet.mockReturnValueOnce({
      id: "y",
      path: "x.md",
      title: "x",
      content,
      tags: "[]",
      qualifier: "reference",
      condition: null,
      priority: 0,
      related_to: "[]",
      updated_at: "2026-04-29",
    });

    const result = await jarvisFileReadTool.execute({
      path: "x.md",
      lines: "1-2,10-11",
    });
    const parsed = JSON.parse(result);
    expect(parsed.content).toBe("L1\nL2\nL10\nL11");
    expect(parsed.slice_lines).toBe(4);
  });

  it("clamps out-of-range slices and flags clamped (Session 114)", async () => {
    const content = "L1\nL2\nL3";
    mockGet.mockReturnValueOnce({
      id: "z",
      path: "x.md",
      title: "x",
      content,
      tags: "[]",
      qualifier: "reference",
      condition: null,
      priority: 0,
      related_to: "[]",
      updated_at: "2026-04-29",
    });

    const result = await jarvisFileReadTool.execute({
      path: "x.md",
      lines: "1-1000",
    });
    const parsed = JSON.parse(result);
    expect(parsed.content).toBe("L1\nL2\nL3");
    expect(parsed.clamped).toBe(true);
  });

  it("returns error envelope for malformed lines spec (Session 114)", async () => {
    mockGet.mockReturnValueOnce({
      id: "z",
      path: "x.md",
      title: "x",
      content: "hello",
      tags: "[]",
      qualifier: "reference",
      condition: null,
      priority: 0,
      related_to: "[]",
      updated_at: "2026-04-29",
    });

    const result = await jarvisFileReadTool.execute({
      path: "x.md",
      lines: "garbage",
    });
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("Invalid lines spec");
    expect(parsed.content).toBeUndefined();
  });

  it("coerces numeric `lines` arg from the LLM rather than crashing (qa W3)", async () => {
    const content = "L1\nL2\nL3\nL4\nL5";
    mockGet.mockReturnValueOnce({
      id: "z",
      path: "x.md",
      title: "x",
      content,
      tags: "[]",
      qualifier: "reference",
      condition: null,
      priority: 0,
      related_to: "[]",
      updated_at: "2026-04-29",
    });

    // LLM occasionally passes lines as a number; the tool must coerce to
    // string rather than crash on .trim() inside parseLineRanges.
    const result = await jarvisFileReadTool.execute({ path: "x.md", lines: 3 });
    const parsed = JSON.parse(result);
    expect(parsed.content).toBe("L3");
    expect(parsed.lines).toBe("3");
  });
});

describe("jarvis_file_update", () => {
  it("appends content to existing file", async () => {
    const fileRow = {
      content: "# Original",
      tags: '["test"]',
      qualifier: "reference",
      priority: 50,
      related_to: "[]",
      condition: null,
      updated_at: "2026-04-02",
    };
    // Call 1: getFile in execute(), Call 2: appendToFile SELECT, Call 3: getFile at end
    mockGet.mockReturnValueOnce(fileRow);
    mockGet.mockReturnValueOnce({ content: "# Original" });
    mockGet.mockReturnValueOnce({
      ...fileRow,
      content: "# Original\n\n## New section",
    });

    const result = await jarvisFileUpdateTool.execute({
      path: "notes.md",
      append: "## New section",
    });
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(true);
    // Verify appendToFile triggered a DB write
    const prepareCalls = mockDb.prepare.mock.calls.map((c: unknown[]) =>
      String(c[0]),
    );
    expect(prepareCalls.some((s) => s.includes("UPDATE"))).toBe(true);
  });

  it("returns error for missing file", async () => {
    mockGet.mockReturnValueOnce(undefined);
    const result = await jarvisFileUpdateTool.execute({
      path: "missing.md",
      append: "data",
    });
    expect(JSON.parse(result).error).toContain("not found");
  });
});

describe("jarvis_file_list", () => {
  it("lists all files", async () => {
    mockAll.mockReturnValueOnce([
      {
        path: "DIRECTIVES.md",
        title: "Directives",
        tags: '["directive"]',
        qualifier: "enforce",
        priority: 0,
        size: 500,
        updated_at: "2026-04-02",
      },
    ]);

    const result = await jarvisFileListTool.execute({});
    // Now returns pre-formatted text, not JSON
    expect(result).toContain("1 files");
    expect(result).toContain("DIRECTIVES.md");
  });

  it("filters by qualifier", async () => {
    mockAll.mockReturnValueOnce([]);
    await jarvisFileListTool.execute({ qualifier: "enforce" });
    expect(mockDb.prepare).toHaveBeenCalledWith(
      expect.stringContaining("qualifier = ?"),
    );
  });
});

describe("jarvis_file_delete", () => {
  it("deletes an existing file", async () => {
    mockRun.mockReturnValueOnce({ changes: 1 });
    const result = await jarvisFileDeleteTool.execute({ path: "notes.md" });
    expect(JSON.parse(result).success).toBe(true);
  });

  it("returns error for missing file", async () => {
    mockRun.mockReturnValueOnce({ changes: 0 });
    const result = await jarvisFileDeleteTool.execute({
      path: "missing.md",
    });
    expect(JSON.parse(result).error).toContain("not found");
  });
});

describe("getFilesByQualifier", () => {
  it("queries files by qualifier ordered by priority", () => {
    mockAll.mockReturnValueOnce([
      {
        path: "DIRECTIVES.md",
        title: "Directives",
        content: "# Rules",
        qualifier: "enforce",
        condition: null,
        priority: 0,
      },
    ]);

    const files = getFilesByQualifier("always-read", "enforce");
    expect(files).toHaveLength(1);
    expect(mockDb.prepare).toHaveBeenCalledWith(
      expect.stringContaining("qualifier IN"),
    );
  });
});

// Queue #17 (2026-05-15) — Pattern A bulk-throughput throttle fix. These
// tools collapse N runner turns → 1 for bulk-write / bulk-delete workflows
// (NS reconstruction at 53× writes, NS bulk-delete at 54× deletes both hit
// MAX_ROUNDS_CODING=55 in May 2026 with one op per turn).

describe("jarvis_files_batch_write", () => {
  it("writes a batch of 3 files and reports all ok", async () => {
    mockRun.mockReturnValue({ changes: 1 });
    const result = await jarvisFilesBatchWriteTool.execute({
      files: [
        { path: "a.md", title: "A", content: "alpha" },
        { path: "b.md", title: "B", content: "beta" },
        { path: "c.md", title: "C", content: "gamma" },
      ],
    });
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(true);
    expect(parsed.total).toBe(3);
    expect(parsed.ok).toBe(3);
    expect(parsed.errors).toBe(0);
    expect(parsed.results).toHaveLength(3);
    expect(
      parsed.results.every((r: { status: string }) => r.status === "ok"),
    ).toBe(true);
    // Each item triggers an INSERT via upsertFile — exactly N prepare calls
    // for the INSERT statement (plus any mirror writes). Loose assertion is
    // fine — what we're pinning is "all 3 made it through."
    expect(mockRun).toHaveBeenCalledTimes(3);
  });

  it("partial failure: invalid .md path on item 2 does NOT abort items 1+3", async () => {
    mockRun.mockReturnValue({ changes: 1 });
    const result = await jarvisFilesBatchWriteTool.execute({
      files: [
        { path: "ok1.md", title: "OK1", content: "x" },
        { path: "bad.txt", title: "Bad", content: "x" }, // wrong extension
        { path: "ok2.md", title: "OK2", content: "x" },
      ],
    });
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(false);
    expect(parsed.ok).toBe(2);
    expect(parsed.errors).toBe(1);
    expect(parsed.results[0].status).toBe("ok");
    expect(parsed.results[1].status).toBe("error");
    expect(parsed.results[1].error).toContain(".md");
    expect(parsed.results[2].status).toBe("ok");
    // Only 2 INSERTs (item 2 short-circuited before upsertFile).
    expect(mockRun).toHaveBeenCalledTimes(2);
  });

  it("partial failure: logs/day-logs/ guard rejects without aborting batch", async () => {
    mockRun.mockReturnValue({ changes: 1 });
    const result = await jarvisFilesBatchWriteTool.execute({
      files: [
        { path: "ok.md", title: "OK", content: "x" },
        {
          path: "logs/day-logs/2026-05-15.md",
          title: "log",
          content: "x",
        },
      ],
    });
    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(1);
    expect(parsed.errors).toBe(1);
    expect(parsed.results[1].error).toContain("mechanically managed");
  });

  it("enforce qualifier is silently downgraded to reference per item", async () => {
    mockRun.mockReturnValue({ changes: 1 });
    const result = await jarvisFilesBatchWriteTool.execute({
      files: [{ path: "x.md", title: "X", content: "x", qualifier: "enforce" }],
    });
    expect(JSON.parse(result).ok).toBe(1);
    // The qualifier passed to the SQL row binding must be "reference", not
    // "enforce" — verified by inspecting the run call args.
    const firstRunArgs = mockRun.mock.calls[0];
    expect(firstRunArgs).toContain("reference");
    expect(firstRunArgs).not.toContain("enforce");
  });

  it("rejects empty array before doing any work", async () => {
    const result = await jarvisFilesBatchWriteTool.execute({ files: [] });
    expect(JSON.parse(result).error).toContain("non-empty");
    expect(mockRun).not.toHaveBeenCalled();
  });

  it("rejects > 50 items before doing any work (cap enforcement)", async () => {
    const files = Array.from({ length: 51 }, (_, i) => ({
      path: `f${i}.md`,
      title: `F${i}`,
      content: "x",
    }));
    const result = await jarvisFilesBatchWriteTool.execute({ files });
    expect(JSON.parse(result).error).toContain("cap exceeded");
    expect(mockRun).not.toHaveBeenCalled();
  });

  it("accepts exactly 50 items (boundary)", async () => {
    mockRun.mockReturnValue({ changes: 1 });
    const files = Array.from({ length: 50 }, (_, i) => ({
      path: `f${i}.md`,
      title: `F${i}`,
      content: "x",
    }));
    const result = await jarvisFilesBatchWriteTool.execute({ files });
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(true);
    expect(parsed.ok).toBe(50);
  });
});

describe("jarvis_files_batch_delete", () => {
  it("deletes a batch of 3 non-precious files and reports all ok", async () => {
    mockRun.mockReturnValue({ changes: 1 });
    const result = await jarvisFilesBatchDeleteTool.execute({
      paths: ["tmp/a.md", "tmp/b.md", "tmp/c.md"],
    });
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(true);
    expect(parsed.total).toBe(3);
    expect(parsed.ok).toBe(3);
    expect(parsed.errors).toBe(0);
    expect(parsed.not_found).toBe(0);
  });

  it("returns CONFIRMATION_REQUIRED when any path is precious (no deletes happen)", async () => {
    const result = await jarvisFilesBatchDeleteTool.execute({
      paths: ["tmp/a.md", "NorthStar/visions/x.md", "tmp/b.md"],
    });
    const parsed = JSON.parse(result);
    expect(parsed.error).toBe("CONFIRMATION_REQUIRED");
    expect(parsed.precious_paths).toHaveLength(1);
    expect(parsed.precious_paths[0].path).toBe("NorthStar/visions/x.md");
    // CRITICAL: no DELETE runs before confirmation — even non-precious
    // siblings are NOT deleted on the first call.
    expect(mockRun).not.toHaveBeenCalled();
  });

  it("with confirmed:true, precious paths are deleted alongside non-precious", async () => {
    mockRun.mockReturnValue({ changes: 1 });
    const result = await jarvisFilesBatchDeleteTool.execute({
      paths: ["tmp/a.md", "NorthStar/visions/x.md"],
      confirmed: true,
    });
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(true);
    expect(parsed.ok).toBe(2);
    expect(mockRun).toHaveBeenCalledTimes(2);
  });

  it("reports not_found separately from errors when file isn't in DB", async () => {
    // Two deletes: first succeeds (changes=1), second returns 0 (not found).
    mockRun
      .mockReturnValueOnce({ changes: 1 })
      .mockReturnValueOnce({ changes: 0 });
    const result = await jarvisFilesBatchDeleteTool.execute({
      paths: ["tmp/exists.md", "tmp/missing.md"],
    });
    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(1);
    expect(parsed.not_found).toBe(1);
    expect(parsed.errors).toBe(0);
    expect(parsed.results[0].status).toBe("ok");
    expect(parsed.results[1].status).toBe("not_found");
  });

  it("rejects empty array before scanning for precious paths", async () => {
    const result = await jarvisFilesBatchDeleteTool.execute({ paths: [] });
    expect(JSON.parse(result).error).toContain("non-empty");
    expect(mockRun).not.toHaveBeenCalled();
  });

  it("rejects > 50 paths before doing any work", async () => {
    const paths = Array.from({ length: 51 }, (_, i) => `tmp/f${i}.md`);
    const result = await jarvisFilesBatchDeleteTool.execute({ paths });
    expect(JSON.parse(result).error).toContain("cap exceeded");
    expect(mockRun).not.toHaveBeenCalled();
  });

  it("rejects non-string path entries with status:error, doesn't abort batch", async () => {
    mockRun.mockReturnValue({ changes: 1 });
    const result = await jarvisFilesBatchDeleteTool.execute({
      // Cast: simulate an LLM passing junk inside the array.
      paths: ["tmp/a.md", "" as unknown as string, "tmp/b.md"],
    });
    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(2);
    expect(parsed.errors).toBe(1);
    expect(parsed.results[1].status).toBe("error");
  });

  it("dedupes duplicate paths up front (audit W3)", async () => {
    mockRun.mockReturnValue({ changes: 1 });
    const result = await jarvisFilesBatchDeleteTool.execute({
      paths: ["tmp/a.md", "tmp/a.md", "tmp/b.md"],
    });
    const parsed = JSON.parse(result);
    // After dedup: total reflects what we actually attempted.
    expect(parsed.total).toBe(2);
    expect(parsed.ok).toBe(2);
    expect(mockRun).toHaveBeenCalledTimes(2);
  });

  it("precious-path scan sees the deduped set (one precious dup → one precious entry)", async () => {
    const result = await jarvisFilesBatchDeleteTool.execute({
      paths: ["NorthStar/x.md", "NorthStar/x.md"],
    });
    const parsed = JSON.parse(result);
    expect(parsed.error).toBe("CONFIRMATION_REQUIRED");
    expect(parsed.precious_paths).toHaveLength(1);
  });
});

describe("jarvis_files_batch_write — additional audit-driven cases", () => {
  it("dedupes duplicate file paths up front (audit W3)", async () => {
    mockRun.mockReturnValue({ changes: 1 });
    const result = await jarvisFilesBatchWriteTool.execute({
      files: [
        { path: "x.md", title: "X1", content: "a" },
        { path: "x.md", title: "X2", content: "b" },
        { path: "y.md", title: "Y", content: "c" },
      ],
    });
    const parsed = JSON.parse(result);
    // After dedup: 2 distinct paths attempted.
    expect(parsed.total).toBe(2);
    expect(parsed.ok).toBe(2);
    expect(mockRun).toHaveBeenCalledTimes(2);
  });
});

describe("batch tool annotations", () => {
  it("jarvis_files_batch_write has correct hints + deferred:true", () => {
    expect(jarvisFilesBatchWriteTool.readOnlyHint).toBe(false);
    expect(jarvisFilesBatchWriteTool.destructiveHint).toBe(true);
    expect(jarvisFilesBatchWriteTool.idempotentHint).toBe(true);
    expect(jarvisFilesBatchWriteTool.openWorldHint).toBe(true);
    expect(jarvisFilesBatchWriteTool.deferred).toBe(true);
  });

  it("jarvis_files_batch_delete has correct hints + requiresConfirmation + deferred", () => {
    expect(jarvisFilesBatchDeleteTool.readOnlyHint).toBe(false);
    expect(jarvisFilesBatchDeleteTool.destructiveHint).toBe(true);
    expect(jarvisFilesBatchDeleteTool.idempotentHint).toBe(true);
    expect(jarvisFilesBatchDeleteTool.openWorldHint).toBe(true);
    expect(jarvisFilesBatchDeleteTool.requiresConfirmation).toBe(true);
    expect(jarvisFilesBatchDeleteTool.deferred).toBe(true);
  });
});
