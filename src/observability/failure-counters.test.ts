import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import client from "prom-client";
import {
  noteJobFailure,
  noteSendFailure,
  noteWriteFailure,
  writeFailuresTotal,
  _resetWriteFailureThrottle,
  type JobFailureId,
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

async function jobCount(job: string): Promise<number> {
  const metric = client.register.getSingleMetric("mc_job_failures_total");
  if (!metric) return 0;
  const { values } = await metric.get();
  return values.find((v) => v.labels.job === job)?.value ?? 0;
}

describe("noteJobFailure", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetWriteFailureThrottle();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("increments mc_job_failures_total for the job id, every time, per id", async () => {
    const before = await jobCount("cohort-rollup");
    const other = await jobCount("tasks-retention");
    noteJobFailure("cohort-rollup", new Error("SQLITE_BUSY"));
    noteJobFailure("cohort-rollup", new Error("SQLITE_BUSY"));
    expect(await jobCount("cohort-rollup")).toBe(before + 2);
    expect(await jobCount("tasks-retention")).toBe(other);
  });

  it("logs the job id and the error message", () => {
    noteJobFailure("checkpoint-prune", new Error("database is locked"));
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]).toEqual([
      "[job-failure] checkpoint-prune: database is locked",
    ]);
  });

  it("logs at most one line per job per minute, then the exact suppressed count", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const before = await jobCount("s3-hourly");
    noteJobFailure("s3-hourly", new Error("a"));
    noteJobFailure("s3-hourly", new Error("b"));
    vi.advanceTimersByTime(59_999);
    noteJobFailure("s3-hourly", new Error("c"));
    expect(errorSpy).toHaveBeenCalledTimes(1);

    noteJobFailure("s3-nightly", new Error("d"));
    expect(errorSpy).toHaveBeenCalledTimes(2);
    expect(errorSpy.mock.calls[1]).toEqual(["[job-failure] s3-nightly: d"]);

    vi.advanceTimersByTime(1);
    noteJobFailure("s3-hourly", new Error("e"));
    expect(errorSpy).toHaveBeenCalledTimes(3);
    expect(errorSpy.mock.calls[2]).toEqual([
      "[job-failure] s3-hourly: e (+2 suppressed)",
    ]);
    // The counter counts every failure, logged or suppressed.
    expect(await jobCount("s3-hourly")).toBe(before + 4);
  });

  it("caps the message at 200 characters", () => {
    noteJobFailure("intel-signal-prune", new Error("y".repeat(1000)));
    expect(errorSpy.mock.calls[0]).toEqual([
      "[job-failure] intel-signal-prune: " + "y".repeat(200),
    ]);
  });

  it("throttles apart from noteWriteFailure even when a job id equals a write site", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    // The types keep the two id sets apart; the throttle does not rely on it.
    noteWriteFailure("unknown", new Error("w"));
    noteJobFailure("unknown" as JobFailureId, new Error("j"));
    expect(errorSpy.mock.calls).toEqual([
      ["[write-failure] unknown: w"],
      ["[job-failure] unknown: j"],
    ]);
  });

  it("never throws, even when reading the error's message throws", async () => {
    const hostile = new Error("x");
    Object.defineProperty(hostile, "message", {
      get() {
        throw new Error("getter boom");
      },
    });
    const before = await jobCount("proactive-nudge");
    expect(() => noteJobFailure("proactive-nudge", hostile)).not.toThrow();
    expect(await jobCount("proactive-nudge")).toBe(before + 1);
    expect(errorSpy.mock.calls[0]).toEqual([
      "[job-failure] proactive-nudge: (unreadable error)",
    ]);
  });

  it("never throws when console.error itself throws", () => {
    errorSpy.mockImplementation(() => {
      throw new Error("stderr closed");
    });
    expect(() => noteJobFailure("idle-detect", new Error("x"))).not.toThrow();
  });
});

async function sendCount(channel: string, path: string): Promise<number> {
  const metric = client.register.getSingleMetric("mc_outbound_send_failures_total");
  if (!metric) return 0;
  const { values } = await metric.get();
  return (
    values.find((v) => v.labels.channel === channel && v.labels.path === path)
      ?.value ?? 0
  );
}

describe("noteSendFailure", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetWriteFailureThrottle();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("increments mc_outbound_send_failures_total per channel and path pair, every time", async () => {
    const before = await sendCount("whatsapp", "reply");
    const otherPath = await sendCount("whatsapp", "notice");
    const otherChannel = await sendCount("telegram", "reply");
    noteSendFailure("whatsapp", "reply", new Error("socket closed"));
    noteSendFailure("whatsapp", "reply", new Error("socket closed"));
    expect(await sendCount("whatsapp", "reply")).toBe(before + 2);
    expect(await sendCount("whatsapp", "notice")).toBe(otherPath);
    expect(await sendCount("telegram", "reply")).toBe(otherChannel);
  });

  it("every mailbox counts as channel=email, so the label never carries a mailbox id", async () => {
    const before = await sendCount("email", "briefing");
    noteSendFailure("email:acme", "briefing", new Error("SMTP 421"));
    noteSendFailure("email", "briefing", new Error("SMTP 421"));
    expect(await sendCount("email", "briefing")).toBe(before + 2);
    expect(await sendCount("email:acme", "briefing")).toBe(0);
    expect(errorSpy.mock.calls[0]).toEqual(["[send-failure] email/briefing: SMTP 421"]);
  });

  it("logs the channel, the kind of send and the error message", () => {
    noteSendFailure("telegram", "broadcast", new Error("Telegram bot not initialized"));
    expect(errorSpy.mock.calls).toEqual([
      ["[send-failure] telegram/broadcast: Telegram bot not initialized"],
    ]);
  });

  it("logs at most one line per channel/path per minute, then the exact suppressed count", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const before = await sendCount("telegram", "notice");
    noteSendFailure("telegram", "notice", new Error("a"));
    noteSendFailure("telegram", "notice", new Error("b"));
    vi.advanceTimersByTime(59_999);
    noteSendFailure("telegram", "notice", new Error("c"));
    expect(errorSpy).toHaveBeenCalledTimes(1);

    noteSendFailure("telegram", "reply", new Error("d"));
    expect(errorSpy).toHaveBeenCalledTimes(2);
    expect(errorSpy.mock.calls[1]).toEqual(["[send-failure] telegram/reply: d"]);

    vi.advanceTimersByTime(1);
    noteSendFailure("telegram", "notice", new Error("e"));
    expect(errorSpy).toHaveBeenCalledTimes(3);
    expect(errorSpy.mock.calls[2]).toEqual([
      "[send-failure] telegram/notice: e (+2 suppressed)",
    ]);
    // The counter counts every failure, logged or suppressed.
    expect(await sendCount("telegram", "notice")).toBe(before + 4);
  });

  it("caps the message at 200 characters", () => {
    noteSendFailure("whatsapp", "broadcast", new Error("z".repeat(1000)));
    expect(errorSpy.mock.calls[0]).toEqual([
      "[send-failure] whatsapp/broadcast: " + "z".repeat(200),
    ]);
  });

  it("throttles apart from noteWriteFailure and noteJobFailure", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    noteWriteFailure("unknown", new Error("w"));
    noteJobFailure("unknown" as JobFailureId, new Error("j"));
    noteSendFailure("whatsapp", "notice", new Error("s"));
    noteWriteFailure("unknown", new Error("w2"));
    noteJobFailure("unknown" as JobFailureId, new Error("j2"));
    noteSendFailure("whatsapp", "notice", new Error("s2"));
    expect(errorSpy.mock.calls).toEqual([
      ["[write-failure] unknown: w"],
      ["[job-failure] unknown: j"],
      ["[send-failure] whatsapp/notice: s"],
    ]);
  });

  it("never throws, even when reading the error's message throws", async () => {
    const hostile = new Error("x");
    Object.defineProperty(hostile, "message", {
      get() {
        throw new Error("getter boom");
      },
    });
    const before = await sendCount("whatsapp", "briefing");
    expect(() => noteSendFailure("whatsapp", "briefing", hostile)).not.toThrow();
    expect(await sendCount("whatsapp", "briefing")).toBe(before + 1);
    expect(errorSpy.mock.calls[0]).toEqual([
      "[send-failure] whatsapp/briefing: (unreadable error)",
    ]);
  });

  it("never throws when console.error itself throws", () => {
    errorSpy.mockImplementation(() => {
      throw new Error("stderr closed");
    });
    expect(() => noteSendFailure("telegram", "reply", new Error("x"))).not.toThrow();
  });
});
