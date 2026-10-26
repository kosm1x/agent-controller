import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockAll = vi.hoisted(() => ({
  db: {
    prepare: vi.fn().mockReturnValue({ all: vi.fn().mockReturnValue([]) }),
  },
  // `git log` runs through promisified execFile (async since 2026-10-26,
  // MCEventLoopBlock). Records the call (args without the callback) and
  // returns stdout, a promise of it (held open until the test releases it),
  // or throws.
  execFile: vi.fn().mockReturnValue(""),
  // stdin.end() of every async child (a prompting child must fail fast).
  stdinEnd: vi.fn(),
  broadcastToAll: vi.fn().mockResolvedValue(undefined),
}));

type ChildErr = Error & { stdout?: string; stderr?: string };
type ChildCb = (err: ChildErr | null, stdout: string, stderr: string) => void;

/**
 * Callback-style child mock with the real `(…, cb) => cb(err, stdout, stderr)`
 * shape, delivering on setImmediate like a real child. Real execFile carries
 * util.promisify.custom resolving `{stdout, stderr}` with `.child` on the
 * promise — mirrored here so promisify() sees the same shape.
 */
vi.mock("child_process", () => {
  const fail = (cb: ChildCb, e: unknown) => {
    const err = e as ChildErr;
    setImmediate(() => cb(err, err.stdout ?? "", err.stderr ?? ""));
  };
  const child = (...args: unknown[]) => {
    const cb = args.pop() as ChildCb;
    try {
      Promise.resolve(mockAll.execFile(...args) as string).then(
        (out) => setImmediate(() => cb(null, out, "")),
        (e) => fail(cb, e),
      );
    } catch (e) {
      fail(cb, e);
    }
  };
  Object.defineProperty(child, Symbol.for("nodejs.util.promisify.custom"), {
    value: (...args: unknown[]) =>
      Object.assign(
        new Promise((res, rej) =>
          child(...args, ((err, stdout, stderr) =>
            err ? rej(err) : res({ stdout, stderr })) as ChildCb),
        ),
        { child: { stdin: { end: mockAll.stdinEnd } } },
      ),
  });
  return { execFile: child };
});

vi.mock("../db/index.js", () => ({
  getDatabase: () => mockAll.db,
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
    mockAll.execFile.mockReturnValue("");
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
    mockAll.execFile.mockReturnValue(
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
    mockAll.execFile.mockReturnValue("abc1234 jarvis/fix/test");

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
  it("passes the same git log args, cwd, timeout and encoding", async () => {
    await executeDiffDigest();
    expect(mockAll.execFile).toHaveBeenCalledOnce();
    expect(mockAll.execFile).toHaveBeenCalledWith(
      "git",
      ["log", "--oneline", "--since=7.days.ago", "--all", "--grep=jarvis/"],
      {
        cwd: "/root/claude/mission-control",
        timeout: 10_000,
        encoding: "utf-8",
      },
    );
  });

  it("does not settle synchronously — git log is delivered on a later tick", async () => {
    mockAll.execFile.mockReturnValue("abc1234 jarvis/fix/x");
    let settled = false;
    const p = executeDiffDigest().then((r) => {
      settled = true;
      return r;
    });
    // Microtasks only: a sync child would already have produced the digest.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(settled).toBe(false);
    expect(mockAll.broadcastToAll).not.toHaveBeenCalled();
    const result = await p;
    expect(result.sections).toBe(1);
    expect(mockAll.broadcastToAll).toHaveBeenCalledOnce();
  });

  it("waits for a held-open git log before building and sending the digest", async () => {
    let release!: (out: string) => void;
    mockAll.execFile.mockReturnValue(
      new Promise<string>((r) => {
        release = r;
      }),
    );
    let settled = false;
    const p = executeDiffDigest().then((r) => {
      settled = true;
      return r;
    });
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    expect(settled).toBe(false);
    expect(mockAll.broadcastToAll).not.toHaveBeenCalled();

    release("def5678 jarvis/feat/held");
    const result = await p;
    expect(result.sections).toBe(1);
    expect(mockAll.broadcastToAll.mock.calls[0][0]).toContain(
      "jarvis/feat/held",
    );
  });

  it("closes the git child's stdin right after spawn", async () => {
    await executeDiffDigest();
    expect(mockAll.stdinEnd).toHaveBeenCalledOnce();
  });

  it("treats a failing git log as an empty commit list (catch → [])", async () => {
    mockAll.execFile.mockImplementation(() => {
      throw Object.assign(new Error("fatal: not a git repository"), {
        code: 128,
      });
    });
    const result = await executeDiffDigest();
    expect(result.sent).toBe(true);
    expect(result.sections).toBe(0);
    const html = mockAll.broadcastToAll.mock.calls[0][0] as string;
    expect(html).not.toContain("Git Commits");
    expect(html).toContain("No autonomous activity this week");
  });
});
