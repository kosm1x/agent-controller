import { afterEach, describe, expect, it, vi } from "vitest";
import { format, inspect } from "util";
import { installJournalPriority } from "./journal-priority.js";

function fakeConsole() {
  return {
    error: vi.fn<(...args: unknown[]) => void>(),
    warn: vi.fn<(...args: unknown[]) => void>(),
    log: vi.fn<(...args: unknown[]) => void>(),
  };
}

const MATCH_ENV = { JOURNAL_STREAM: "8:12345" };
const matchStat = () => ({ dev: 8n, ino: 12345n });

function installed() {
  const target = fakeConsole();
  const origError = target.error;
  const origWarn = target.warn;
  const origLog = target.log;
  installJournalPriority({ env: MATCH_ENV, fstat: matchStat, target });
  return { target, origError, origWarn, origLog };
}

describe("installJournalPriority", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does nothing when JOURNAL_STREAM is unset", () => {
    const target = fakeConsole();
    const { error, warn, log } = target;
    const fstat = vi.fn(matchStat);
    installJournalPriority({ env: {}, fstat, target });
    expect(target.error).toBe(error);
    expect(target.warn).toBe(warn);
    expect(target.log).toBe(log);
  });

  it("does nothing when stderr's device:inode differs from JOURNAL_STREAM", () => {
    const target = fakeConsole();
    const { error, warn } = target;
    installJournalPriority({
      env: MATCH_ENV,
      fstat: () => ({ dev: 8n, ino: 99999n }),
      target,
    });
    expect(target.error).toBe(error);
    expect(target.warn).toBe(warn);
  });

  it("does nothing when the device differs and the inode is equal", () => {
    const target = fakeConsole();
    const { error, warn } = target;
    installJournalPriority({
      env: MATCH_ENV,
      fstat: () => ({ dev: 9n, ino: 12345n }),
      target,
    });
    expect(target.error).toBe(error);
    expect(target.warn).toBe(warn);
  });

  it("does nothing on a malformed JOURNAL_STREAM", () => {
    const target = fakeConsole();
    const { error } = target;
    installJournalPriority({ env: { JOURNAL_STREAM: "8-12345" }, fstat: matchStat, target });
    expect(target.error).toBe(error);
  });

  it("does nothing (and does not throw) when fstat throws", () => {
    const target = fakeConsole();
    const { error, warn } = target;
    expect(() =>
      installJournalPriority({
        env: MATCH_ENV,
        fstat: () => {
          throw new Error("EBADF");
        },
        target,
      }),
    ).not.toThrow();
    expect(target.error).toBe(error);
    expect(target.warn).toBe(warn);
  });

  it("asks fstat about file descriptor 2 with bigint stats", () => {
    const target = fakeConsole();
    const fstat = vi.fn(matchStat);
    installJournalPriority({ env: MATCH_ENV, fstat, target });
    expect(fstat).toHaveBeenCalledWith(2, { bigint: true });
  });

  it("error prefixes every line with <3> and passes one string to the original", () => {
    const { target, origError } = installed();
    expect(target.error).not.toBe(origError);
    target.error("a\nb", 1);
    expect(format("a\nb", 1)).toBe("a\nb 1");
    expect(origError).toHaveBeenCalledTimes(1);
    expect(origError.mock.calls[0]).toEqual(["<3>a\n<3>b 1"]);
  });

  it("warn prefixes every line with <4>", () => {
    const { target, origWarn } = installed();
    target.warn("x\ny");
    expect(origWarn.mock.calls[0]).toEqual(["<4>x\n<4>y"]);
  });

  it("log is untouched", () => {
    const { target, origLog } = installed();
    expect(target.log).toBe(origLog);
  });

  it("a second install does not add a second prefix", () => {
    const { target, origError, origWarn } = installed();
    installJournalPriority({ env: MATCH_ENV, fstat: matchStat, target });
    target.error("once");
    target.warn("once");
    expect(origError.mock.calls[0]).toEqual(["<3>once"]);
    expect(origWarn.mock.calls[0]).toEqual(["<4>once"]);
  });

  it("format placeholders behave as console's", () => {
    const { target, origError } = installed();
    target.error("%s=%d (%j)", "x", 5, { k: 1 });
    expect(format("%s=%d (%j)", "x", 5, { k: 1 })).toBe('x=5 ({"k":1})');
    expect(origError.mock.calls[0]).toEqual(['<3>x=5 ({"k":1})']);
  });

  it("an Error object is formatted as console does, every stack line prefixed", () => {
    const { target, origError } = installed();
    const err = new Error("boom");
    target.error("failed:", err);
    const expected = format("failed:", err);
    const got = origError.mock.calls[0]![0] as string;
    expect(got.split("\n")).toEqual(expected.split("\n").map((l) => `<3>${l}`));
    expect(got.startsWith("<3>failed: Error: boom\n<3>    at ")).toBe(true);
  });

  it("an argument whose formatting throws reaches the original unchanged, and the call returns normally", () => {
    const { target, origError } = installed();
    const hostile = {
      [inspect.custom]() {
        throw new Error("inspect boom");
      },
    };
    expect(() => format("x", hostile)).toThrow("inspect boom");
    expect(() => target.error("x", hostile)).not.toThrow();
    expect(origError).toHaveBeenCalledTimes(1);
    expect(origError.mock.calls[0]).toHaveLength(2);
    expect(origError.mock.calls[0]![0]).toBe("x");
    expect(origError.mock.calls[0]![1]).toBe(hostile);
  });
});
