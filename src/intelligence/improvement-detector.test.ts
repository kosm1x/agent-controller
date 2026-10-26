/**
 * Improvement detector tests — db-derived candidates plus the journalctl
 * guard/nudge/tool-failure scan, which runs through promisified execFile
 * (async since 2026-10-26, MCEventLoopBlock).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  // Records the journalctl call (args without the callback) and returns
  // stdout, a promise of it (held open until the test releases it), or throws.
  execFile: vi.fn().mockReturnValue(""),
  stdinEnd: vi.fn(),
  failures: [] as Array<{ error: string; cnt: number }>,
  missed: [] as Array<{ error: string; cnt: number }>,
  events: [] as string[],
}));

type ChildErr = Error & { stdout?: string; stderr?: string };
type ChildCb = (err: ChildErr | null, stdout: string, stderr: string) => void;

/**
 * Callback-style child mock with the real `(…, cb) => cb(err, stdout, stderr)`
 * shape, delivering on setImmediate like a real child; util.promisify.custom
 * resolves `{stdout, stderr}` with `.child` on the promise, like real execFile.
 */
vi.mock("child_process", () => {
  const fail = (cb: ChildCb, e: unknown) => {
    const err = e as ChildErr;
    setImmediate(() => cb(err, err.stdout ?? "", err.stderr ?? ""));
  };
  const child = (...args: unknown[]) => {
    const cb = args.pop() as ChildCb;
    mocks.events.push("journalctl");
    try {
      Promise.resolve(mocks.execFile(...args) as string).then(
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
        { child: { stdin: { end: mocks.stdinEnd } } },
      ),
  });
  return { execFile: child };
});

// Minimal prepared-statement stub routed by the two queries' SQL.
vi.mock("../db/index.js", () => ({
  getDatabase: () => ({
    prepare: (sql: string) => {
      if (sql.includes("Required tools not called")) {
        mocks.events.push("db:missed");
        return { all: () => mocks.missed };
      }
      mocks.events.push("db:failures");
      return { all: () => mocks.failures };
    },
  }),
}));

import { detectImprovements } from "./improvement-detector.js";

const rep = (line: string, n: number) => Array(n).fill(line).join("\n");

const DB_ROWS = () => {
  mocks.failures = [{ error: "ECONNRESET upstream", cnt: 4 }];
  mocks.missed = [{ error: "Required tools not called: jarvis_dev", cnt: 2 }];
};

const timeoutErr = () =>
  Object.assign(new Error("Command failed: journalctl (timed out)"), {
    killed: true,
    code: null,
    signal: "SIGTERM",
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.execFile.mockReturnValue("");
  mocks.failures = [];
  mocks.missed = [];
  mocks.events = [];
});

describe("detectImprovements", () => {
  it("turns journalctl guard/nudge/tool-failure lines into candidates", async () => {
    mocks.execFile.mockReturnValue(
      [
        rep("[fast] hallucination guard: narration detected", 3),
        rep("[fast] Post-nudge tool skip on task t1", 3),
        rep("[fast] Failed tool calls (excluded from ledger): [file_read]", 3),
      ].join("\n"),
    );
    const out = await detectImprovements(12);
    expect(out.map((c) => c.type).sort()).toEqual([
      "guard-trigger",
      "scope-miss",
      "tool-failure",
    ]);
    expect(out.find((c) => c.type === "guard-trigger")?.description).toBe(
      "Hallucination guard fired 3 times in 12h",
    );
    expect(out.find((c) => c.type === "tool-failure")?.description).toBe(
      'Tool "file_read" failed 3 times',
    );
    expect(mocks.execFile).toHaveBeenCalledWith(
      "journalctl",
      ["-u", "mission-control", "--since", "12 hours ago", "--no-pager"],
      { encoding: "utf-8", timeout: 10_000 },
    );
  });

  it("keeps the db queries before and after journalctl, in order", async () => {
    await detectImprovements();
    expect(mocks.events).toEqual(["db:failures", "journalctl", "db:missed"]);
  });

  it("keeps db-derived candidates when journalctl fails", async () => {
    DB_ROWS();
    mocks.execFile.mockImplementation(() => {
      throw Object.assign(new Error("spawn journalctl ENOENT"), {
        code: "ENOENT",
      });
    });
    const out = await detectImprovements();
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ type: "task-failure", frequency: 4 });
    expect(out[1]).toMatchObject({
      type: "scope-miss",
      description: "Required tools not called: jarvis_dev",
    });
  });

  it("a journalctl timeout lands in the same catch", async () => {
    DB_ROWS();
    mocks.execFile.mockImplementation(() => {
      throw timeoutErr();
    });
    const out = await detectImprovements();
    expect(out.map((c) => c.type)).toEqual(["task-failure", "scope-miss"]);
  });

  it("does not settle synchronously — journalctl is delivered on a later tick", async () => {
    let settled = false;
    const p = detectImprovements().then((r) => {
      settled = true;
      return r;
    });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(settled).toBe(false);
    expect(mocks.events).not.toContain("db:missed");
    await p;
    expect(settled).toBe(true);
  });

  it("waits for a held-open journalctl before the trailing db query", async () => {
    let release!: (out: string) => void;
    mocks.execFile.mockReturnValue(
      new Promise<string>((r) => {
        release = r;
      }),
    );
    let settled = false;
    const p = detectImprovements().then((r) => {
      settled = true;
      return r;
    });
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    expect(settled).toBe(false);
    expect(mocks.events).toEqual(["db:failures", "journalctl"]);

    release(rep("Failed-write hallucination on file_write", 3));
    const out = await p;
    expect(out.map((c) => c.type)).toEqual(["guard-trigger"]);
  });

  it("closes the journalctl child's stdin right after spawn", async () => {
    await detectImprovements();
    expect(mocks.stdinEnd).toHaveBeenCalledOnce();
  });
});
