import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mockRun = vi.fn();
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
}));

import {
  jarvisFileReadTool,
  jarvisFileWriteTool,
  jarvisFileUpdateTool,
  jarvisFileListTool,
  jarvisFileDeleteTool,
  getFilesByQualifier,
} from "./jarvis-files.js";

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
});

describe("jarvis_file_update", () => {
  it("appends content to existing file", async () => {
    mockGet.mockReturnValueOnce({
      content: "# Original",
      tags: '["test"]',
      qualifier: "reference",
      priority: 50,
    });

    const result = await jarvisFileUpdateTool.execute({
      path: "notes.md",
      append: "## New section",
    });
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(true);
    // Verify the content was concatenated
    expect(mockRun).toHaveBeenCalledWith(
      expect.stringContaining("# Original\n\n## New section"),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      "notes.md",
    );
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
    const parsed = JSON.parse(result);
    expect(parsed.total).toBe(1);
    expect(parsed.files[0].tags).toEqual(["directive"]);
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
    mockGet.mockReturnValueOnce({ id: "notes" });
    const result = await jarvisFileDeleteTool.execute({ path: "notes.md" });
    expect(JSON.parse(result).success).toBe(true);
  });

  it("returns error for missing file", async () => {
    mockGet.mockReturnValueOnce(undefined);
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
