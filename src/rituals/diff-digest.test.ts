import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockAll = vi.hoisted(() => ({
  db: {
    prepare: vi.fn().mockReturnValue({ all: vi.fn().mockReturnValue([]) }),
  },
  execFileSync: vi.fn().mockReturnValue(""),
  broadcastToAll: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../db/index.js", () => ({
  getDatabase: () => mockAll.db,
}));

vi.mock("child_process", () => ({
  execFileSync: mockAll.execFileSync,
}));

vi.mock("../messaging/index.js", () => ({
  getRouter: () => ({
    broadcastToAll: mockAll.broadcastToAll,
  }),
}));

import { executeDiffDigest } from "./diff-digest.js";

describe("diff-digest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset default mocks
    mockAll.db.prepare.mockReturnValue({
      all: vi.fn().mockReturnValue([]),
    });
    mockAll.execFileSync.mockReturnValue("");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends 'no autonomous activity' when all queries return empty", async () => {
    const result = await executeDiffDigest();
    expect(result.sent).toBe(true);
    expect(result.sections).toBe(0);
    expect(mockAll.broadcastToAll).toHaveBeenCalledOnce();
    expect(mockAll.broadcastToAll.mock.calls[0][0]).toContain(
      "No autonomous activity this week",
    );
  });

  it("includes auto-improvement tasks section", async () => {
    let callIndex = 0;
    mockAll.db.prepare.mockImplementation(() => ({
      all: vi.fn().mockImplementation(() => {
        callIndex++;
        if (callIndex === 1) {
          return [
            {
              task_id: "t1",
              title: "🤖 Auto-improvement: fix scope regex",
              status: "completed",
              created_at: "2026-04-05 01:30:00",
            },
          ];
        }
        return [];
      }),
    }));

    const result = await executeDiffDigest();
    expect(result.sections).toBe(1);
    const html = mockAll.broadcastToAll.mock.calls[0][0] as string;
    expect(html).toContain("Auto-improvement Tasks");
    expect(html).toContain("fix scope regex");
    expect(html).toContain("✅");
  });

  it("includes KB changes section", async () => {
    let callIndex = 0;
    mockAll.db.prepare.mockImplementation(() => ({
      all: vi.fn().mockImplementation(() => {
        callIndex++;
        if (callIndex === 2) {
          return [
            {
              path: "knowledge/execution-patterns/2026-04-05-scope-fix.md",
              title: "Scope fix pattern",
              updated_at: "2026-04-05 02:00:00",
            },
          ];
        }
        return [];
      }),
    }));

    const result = await executeDiffDigest();
    expect(result.sections).toBe(1);
    const html = mockAll.broadcastToAll.mock.calls[0][0] as string;
    expect(html).toContain("Directive / Pattern Changes");
    expect(html).toContain("execution-patterns");
  });

  it("includes git commits section", async () => {
    mockAll.execFileSync.mockReturnValue(
      "abc1234 fix: scope regex for plurals\ndef5678 feat: new intel adapter",
    );

    const result = await executeDiffDigest();
    expect(result.sections).toBe(1);
    const html = mockAll.broadcastToAll.mock.calls[0][0] as string;
    expect(html).toContain("Git Commits");
    expect(html).toContain("scope regex");
  });

  it("handles all three sections populated", async () => {
    let callIndex = 0;
    mockAll.db.prepare.mockImplementation(() => ({
      all: vi.fn().mockImplementation(() => {
        callIndex++;
        if (callIndex === 1) {
          return [
            {
              task_id: "t1",
              title: "Auto-improvement: X",
              status: "failed",
              created_at: "2026-04-05 01:30:00",
            },
          ];
        }
        if (callIndex === 2) {
          return [
            {
              path: "directives/core.md",
              title: "Core",
              updated_at: "2026-04-04",
            },
          ];
        }
        return [];
      }),
    }));
    mockAll.execFileSync.mockReturnValue("abc1234 jarvis/fix/test");

    const result = await executeDiffDigest();
    expect(result.sections).toBe(3);
    expect(result.sent).toBe(true);
  });

  it("returns sent=false when broadcastToAll throws", async () => {
    mockAll.broadcastToAll.mockRejectedValue(new Error("network"));
    const result = await executeDiffDigest();
    expect(result.sent).toBe(false);
  });

  it("handles DB errors gracefully", async () => {
    mockAll.db.prepare.mockImplementation(() => {
      throw new Error("DB locked");
    });
    const result = await executeDiffDigest();
    expect(result.sent).toBe(true);
    expect(result.sections).toBe(0);
  });

  it("escapes HTML in task titles", async () => {
    let callIndex = 0;
    mockAll.db.prepare.mockImplementation(() => ({
      all: vi.fn().mockImplementation(() => {
        callIndex++;
        if (callIndex === 1) {
          return [
            {
              task_id: "t1",
              title: "Auto-improvement: fix <script> injection",
              status: "completed",
              created_at: "2026-04-05",
            },
          ];
        }
        return [];
      }),
    }));

    await executeDiffDigest();
    const html = mockAll.broadcastToAll.mock.calls[0][0] as string;
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
});
