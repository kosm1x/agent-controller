import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  listFiles: vi.fn(),
  getFile: vi.fn(),
  upsertFile: vi.fn(),
  deleteFile: vi.fn(),
}));

vi.mock("../db/jarvis-fs.js", () => ({
  listFiles: mocks.listFiles,
  getFile: mocks.getFile,
  upsertFile: mocks.upsertFile,
  deleteFile: mocks.deleteFile,
}));

vi.mock("../inference/adapter.js", () => ({ infer: vi.fn() }));

import { findRelevantPatterns, extractPattern } from "./execution-patterns.js";

describe("findRelevantPatterns", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns empty when no patterns exist", () => {
    mocks.listFiles.mockReturnValue([]);
    expect(findRelevantPatterns("cuantos hoteles denue", ["coding"])).toBe("");
  });

  it("ranks a domain-relevant pattern above a generic same-scope one (anti-dilution)", () => {
    // Both tied on scope (coding) and on title (no overlap) — only the lesson
    // BODY distinguishes them. The DENUE one must win on the body keywords.
    mocks.listFiles.mockReturnValue([
      {
        path: "p/generic.md",
        title: "Pattern: build deploy",
        tags: ["execution-pattern", "coding"],
        updated_at: "2026-06-01",
      },
      {
        path: "p/denue.md",
        title: "Pattern: conteo salones",
        tags: ["execution-pattern", "coding"],
        updated_at: "2026-06-02",
      },
    ]);
    mocks.getFile.mockImplementation((path: string) => {
      if (path === "p/generic.md")
        return {
          content:
            "# h\n**Scope:** coding\n\ncoding: corre npm build y reinicia el servicio con cuidado",
        };
      if (path === "p/denue.md")
        return {
          content:
            "# h\n**Scope:** coding\n\ncrm: consulta DENUE establecimientos directo con entidad codigo, no shell",
        };
      return null;
    });

    const out = findRelevantPatterns("cuantos hoteles denue establecimientos", [
      "coding",
    ]);
    expect(out).toContain("DENUE establecimientos");
    // domain pattern outranks the generic one (appears first in the block)
    expect(out.indexOf("DENUE establecimientos")).toBeLessThan(
      out.indexOf("npm build"),
    );
  });

  it("still scores title-keyword overlap without scope overlap (regression)", () => {
    mocks.listFiles.mockReturnValue([
      {
        path: "p/h.md",
        title: "Pattern: hoteles inventory",
        tags: ["execution-pattern", "crm"],
        updated_at: "2026-06-01",
      },
    ]);
    mocks.getFile.mockReturnValue({
      content: "# h\n\ncrm: lesson body unrelated",
    });
    const out = findRelevantPatterns("cuantos hoteles hay", ["coding"]);
    expect(out).toContain("lesson body unrelated");
  });

  it("excludes patterns with no scope, title, or body signal", () => {
    mocks.listFiles.mockReturnValue([
      {
        path: "p/x.md",
        title: "Pattern: unrelated thing",
        tags: ["execution-pattern", "crm"],
        updated_at: "2026-06-01",
      },
    ]);
    mocks.getFile.mockReturnValue({
      content: "# h\n\ncrm: totally different topic",
    });
    expect(findRelevantPatterns("cuantos hoteles denue", ["coding"])).toBe("");
  });

  it("caps the body-score so a long pattern can't dominate on length (cap=3)", () => {
    // A: scope(+2) + 6 body-keyword hits. Uncapped that is +8 and wins;
    // capped at +3 it is 5 and LOSES to B (scope+2 + 4 title hits = 6).
    // If the Math.min(_,3) cap is deleted, A ranks first and this fails.
    mocks.listFiles.mockReturnValue([
      {
        path: "p/a.md",
        title: "Pattern: misc",
        tags: ["execution-pattern", "coding"],
        updated_at: "2026-06-01",
      },
      {
        path: "p/b.md",
        title: "Pattern: alpha beta gamma delta",
        tags: ["execution-pattern", "coding"],
        updated_at: "2026-06-02",
      },
    ]);
    mocks.getFile.mockImplementation((path: string) => {
      if (path === "p/a.md")
        return { content: "# h\n\nalpha beta gamma delta epsilon zeta extra" };
      if (path === "p/b.md") return { content: "# h\n\nlecciones generales" };
      return null;
    });
    const out = findRelevantPatterns("alpha beta gamma delta epsilon zeta", [
      "coding",
    ]);
    expect(out.indexOf("lecciones generales")).toBeLessThan(
      out.indexOf("alpha beta gamma"),
    );
  });

  it("tolerates a candidate whose getFile returns null without blocking a sibling", () => {
    mocks.listFiles.mockReturnValue([
      {
        path: "p/missing.md",
        title: "Pattern: gone",
        tags: ["execution-pattern", "coding"],
        updated_at: "2026-06-01",
      },
      {
        path: "p/good.md",
        title: "Pattern: ok",
        tags: ["execution-pattern", "coding"],
        updated_at: "2026-06-02",
      },
    ]);
    mocks.getFile.mockImplementation((path: string) =>
      path === "p/good.md"
        ? { content: "# h\n\ncrm: consulta DENUE establecimientos directo" }
        : null,
    );
    const out = findRelevantPatterns("denue establecimientos", ["coding"]);
    expect(out).toContain("DENUE establecimientos directo");
  });
});

describe("extractPattern", () => {
  beforeEach(() => vi.clearAllMocks());

  it("skips extraction when fewer than 2 tools were called", async () => {
    await extractPattern({
      taskId: "t1",
      title: "x",
      toolsCalled: ["shell_exec"],
      scopeGroups: ["coding"],
      userMessage: "hi",
      result: "a".repeat(200),
    });
    expect(mocks.listFiles).not.toHaveBeenCalled();
    expect(mocks.upsertFile).not.toHaveBeenCalled();
  });
});
