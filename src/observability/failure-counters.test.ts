import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import client from "prom-client";
import {
  noteWriteFailure,
  writeFailuresTotal,
  _resetWriteFailureThrottle,
  type WriteFailureSite,
} from "./failure-counters.js";

async function count(site: WriteFailureSite): Promise<number> {
  const metric = client.register.getSingleMetric("mc_write_failures_total");
  if (!metric) return 0;
  const { values } = await metric.get();
  return values.find((v) => v.labels.site === site)?.value ?? 0;
}

describe("noteWriteFailure", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetWriteFailureThrottle();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("increments mc_write_failures_total for the site, every time", async () => {
    const before = await count("conversation");
    const other = await count("embedding");
    noteWriteFailure("conversation", new Error("SQLITE_BUSY"));
    noteWriteFailure("conversation", new Error("SQLITE_BUSY"));
    expect(await count("conversation")).toBe(before + 2);
    expect(await count("embedding")).toBe(other);
  });

  it("logs the site and the error message", () => {
    noteWriteFailure("project_log", new Error("no such table: project_log"));
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]).toEqual([
      "[write-failure] project_log: no such table: project_log",
    ]);
  });

  it("logs at most one line per site per minute; another site logs on its own", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    noteWriteFailure("mutation_log", new Error("a"));
    noteWriteFailure("mutation_log", new Error("b"));
    vi.advanceTimersByTime(59_999);
    noteWriteFailure("mutation_log", new Error("c"));
    expect(errorSpy).toHaveBeenCalledTimes(1);

    noteWriteFailure("cost_sdk", new Error("d"));
    expect(errorSpy).toHaveBeenCalledTimes(2);
    expect(errorSpy.mock.calls[1]).toEqual(["[write-failure] cost_sdk: d"]);

    vi.advanceTimersByTime(1);
    noteWriteFailure("mutation_log", new Error("e"));
    expect(errorSpy).toHaveBeenCalledTimes(3);
    expect(errorSpy.mock.calls[2]).toEqual([
      "[write-failure] mutation_log: e (+2 suppressed)",
    ]);
  });

  it("caps the message at 200 characters; the suppressed suffix stays outside the cap", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const long = new Error("x".repeat(1000));
    noteWriteFailure("user_evidence", long);
    expect(errorSpy.mock.calls[0]).toEqual([
      "[write-failure] user_evidence: " + "x".repeat(200),
    ]);
    noteWriteFailure("user_evidence", long);
    vi.advanceTimersByTime(60_000);
    noteWriteFailure("user_evidence", long);
    expect(errorSpy.mock.calls[1]).toEqual([
      "[write-failure] user_evidence: " + "x".repeat(200) + " (+1 suppressed)",
    ]);
  });

  it("still counts while the log line is throttled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const before = await count("unknown");
    noteWriteFailure("unknown", new Error("x"));
    noteWriteFailure("unknown", new Error("x"));
    noteWriteFailure("unknown", new Error("x"));
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(await count("unknown")).toBe(before + 3);
  });

  it("never throws, even when reading the error's message throws", async () => {
    const hostile = new Error("x");
    Object.defineProperty(hostile, "message", {
      get() {
        throw new Error("getter boom");
      },
    });
    const before = await count("embedding");
    expect(() => noteWriteFailure("embedding", hostile)).not.toThrow();
    expect(await count("embedding")).toBe(before + 1);
  });

  it("never throws when console.error itself throws", () => {
    errorSpy.mockImplementation(() => {
      throw new Error("stderr closed");
    });
    expect(() => noteWriteFailure("conversation", new Error("x"))).not.toThrow();
  });

  it("a second module identity reuses the registered counter", async () => {
    vi.resetModules();
    const again = await import("./failure-counters.js");
    expect(again.writeFailuresTotal).toBe(writeFailuresTotal);
  });
});
