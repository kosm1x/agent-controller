import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The tag helpers run git through promisified execFile (async since
// 2026-10-26, MCEventLoopBlock). mockExecFile records each call (args without
// the callback) and returns stdout or throws.
const mockExecFile = vi.hoisted(() => vi.fn());

// Partial mock: scheduler.js now reaches shell.ts (V8.4 gate-check imports the
// shell guard), which imports `exec`/`spawn` — keep the real module and
// override only what this test drives. execFile has the real callback shape,
// delivers on setImmediate, and carries util.promisify.custom resolving
// `{stdout, stderr}` with `.child` on the promise, like the real one.
vi.mock("child_process", async (importOriginal) => {
  type ChildErr = Error & { stdout?: string; stderr?: string };
  type ChildCb = (err: ChildErr | null, stdout: string, stderr: string) => void;
  const fail = (cb: ChildCb, e: unknown) => {
    const err = e as ChildErr;
    setImmediate(() => cb(err, err.stdout ?? "", err.stderr ?? ""));
  };
  const child = (...args: unknown[]) => {
    const cb = args.pop() as ChildCb;
    try {
      Promise.resolve(mockExecFile(...args)).then(
        (out) => setImmediate(() => cb(null, (out as string) ?? "", "")),
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
        { child: { stdin: { end: vi.fn() } } },
      ),
  });
  return {
    ...(await importOriginal<typeof import("child_process")>()),
    execFile: child,
  };
});

// Mock other scheduler deps to prevent side effects
vi.mock("node-cron", () => ({
  default: { schedule: vi.fn().mockReturnValue({ stop: vi.fn(), on: vi.fn() }) },
}));
vi.mock("../db/index.js", () => ({
  getDatabase: () => ({ prepare: vi.fn().mockReturnValue({ get: vi.fn() }) }),
}));
vi.mock("../dispatch/dispatcher.js", () => ({
  submitTask: vi.fn(),
}));
vi.mock("../config.js", () => ({
  getConfig: () => ({ tuningEnabled: false }),
}));

import { createPreCycleTag, pruneOldTags } from "./scheduler.js";
import { nowMexIsoDate } from "../lib/timezone.js";

describe("SG5: Pre-cycle git tags", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFile.mockReturnValue("");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("createPreCycleTag", () => {
    it("creates tag with correct name format", async () => {
      // Tag names carry the Mexico-City calendar date (logic audit F21).
      const date = nowMexIsoDate();
      // First call: tag -l (check existing) returns empty
      // Second call: tag -a (create)
      mockExecFile
        .mockReturnValueOnce("") // tag -l
        .mockReturnValueOnce("") // tag -a
        .mockReturnValueOnce(""); // pruneOldTags tag -l

      await createPreCycleTag();

      expect(mockExecFile).toHaveBeenCalledWith(
        "git",
        ["tag", "-l", `pre-auto-${date}`],
        expect.objectContaining({ cwd: "/root/claude/mission-control" }),
      );
      expect(mockExecFile).toHaveBeenCalledWith(
        "git",
        [
          "tag",
          "-a",
          `pre-auto-${date}`,
          "-m",
          "Pre-autonomous-improvement snapshot",
        ],
        expect.objectContaining({ cwd: "/root/claude/mission-control" }),
      );
    });

    it("skips if tag already exists for today", async () => {
      const date = new Date().toISOString().slice(0, 10);
      mockExecFile.mockReturnValueOnce(`pre-auto-${date}`);

      await createPreCycleTag();

      // Should only call tag -l, not tag -a
      expect(mockExecFile).toHaveBeenCalledTimes(1);
    });

    it("does not throw on git failure", async () => {
      mockExecFile.mockImplementation(() => {
        throw new Error("git not found");
      });

      await expect(createPreCycleTag()).resolves.toBeUndefined();
    });
  });

  describe("pruneOldTags", () => {
    it("keeps all tags when 10 or fewer exist", async () => {
      mockExecFile.mockReturnValueOnce(
        "pre-auto-2026-04-01\npre-auto-2026-04-02\npre-auto-2026-04-03",
      );

      await pruneOldTags();

      // Only the list call, no deletes
      expect(mockExecFile).toHaveBeenCalledTimes(1);
    });

    it("deletes old tags beyond the 10 newest when older than 30 days", async () => {
      // Generate 12 tags — 10 recent + 2 old
      const tags: string[] = [];
      for (let i = 0; i < 10; i++) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        tags.push(`pre-auto-${d.toISOString().slice(0, 10)}`);
      }
      // Add 2 old tags (> 30 days)
      const old1 = new Date();
      old1.setDate(old1.getDate() - 40);
      const old2 = new Date();
      old2.setDate(old2.getDate() - 50);
      tags.push(`pre-auto-${old1.toISOString().slice(0, 10)}`);
      tags.push(`pre-auto-${old2.toISOString().slice(0, 10)}`);

      mockExecFile.mockReturnValueOnce(tags.join("\n"));

      await pruneOldTags();

      // 1 list + 2 deletes
      expect(mockExecFile).toHaveBeenCalledTimes(3);
      expect(mockExecFile).toHaveBeenCalledWith(
        "git",
        ["tag", "-d", `pre-auto-${old1.toISOString().slice(0, 10)}`],
        expect.any(Object),
      );
      expect(mockExecFile).toHaveBeenCalledWith(
        "git",
        ["tag", "-d", `pre-auto-${old2.toISOString().slice(0, 10)}`],
        expect.any(Object),
      );
    });

    it("does not delete tags beyond 10 that are within 30 days", async () => {
      const tags: string[] = [];
      for (let i = 0; i < 12; i++) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        tags.push(`pre-auto-${d.toISOString().slice(0, 10)}`);
      }

      mockExecFile.mockReturnValueOnce(tags.join("\n"));

      await pruneOldTags();

      // Only list call — tags beyond 10 are within 30 days so not deleted
      expect(mockExecFile).toHaveBeenCalledTimes(1);
    });

    it("does not throw on failure", async () => {
      mockExecFile.mockImplementation(() => {
        throw new Error("permission denied");
      });

      await expect(pruneOldTags()).resolves.toBeUndefined();
    });
  });
});
