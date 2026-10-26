/**
 * Ritual scheduler tests — verify idempotency, scheduling, and task templates.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Hoist mocks so vi.mock factories can reference them
const { mockSchedule, mockGet, mockPrepare, mockSubmitTask } = vi.hoisted(
  () => ({
    mockSchedule: vi.fn().mockReturnValue({ stop: vi.fn(), on: vi.fn() }),
    mockGet: vi.fn(),
    mockPrepare: vi.fn().mockReturnValue({ get: vi.fn() }),
    mockSubmitTask: vi.fn().mockResolvedValue({
      taskId: "test-task-id",
      agentType: "fast",
      classification: { score: 0.9, reason: "test", explicit: true },
    }),
  }),
);

// Wire mockPrepare → mockGet + mockAll
const mockAll = vi.fn().mockReturnValue([]);
mockPrepare.mockReturnValue({ get: mockGet, all: mockAll });

vi.mock("node-cron", () => ({
  default: { schedule: mockSchedule },
  schedule: mockSchedule,
}));

// Usability Phase 5.5: `/rituales pausa` — a paused ritual is skipped BEFORE
// submitTask (no tokens).
const mockIsRitualPaused = vi.hoisted(() => vi.fn((_ritualId: string) => false));
vi.mock("./ritual-controls.js", () => ({
  isRitualPaused: mockIsRitualPaused,
}));

vi.mock("../db/index.js", () => ({
  getDatabase: () => ({ prepare: mockPrepare }),
}));

// JME Phase 4 (2026-09-18): the nightly callback dynamic-imports jme.js; the
// mock lets a test RUN the callback and pin the prune call (qa R1 W1 — the
// call site was the only line that made Phase 4 live and nothing executed it).
const mockJme = vi.hoisted(() => ({
  consolidateAll: vi.fn(),
  pruneStaleTurns: vi.fn(),
  pruneExpiredFacts: vi.fn(),
}));
vi.mock("../memory/jme.js", () => mockJme);

vi.mock("../dispatch/dispatcher.js", () => ({
  submitTask: mockSubmitTask,
}));

// The harness-loaded day-log / narrative (2026-10-03): the file layer returns
// a synthetic body naming its own path, so a test can tell WHICH file landed
// in the submitted description.
const mockGetFile = vi.hoisted(() =>
  vi.fn((path: string) => ({
    content: `# synthetic\n- [10:00:00] **USER**: contenido de ${path} — avance del DENUE 05/2026\n`,
  })),
);
vi.mock("../db/jarvis-fs.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../db/jarvis-fs.js")>()),
  getFile: mockGetFile,
}));

const mockConfig = vi.hoisted(
  () => ({ tuningEnabled: false }) as Record<string, unknown>,
);
vi.mock("../config.js", () => ({
  getConfig: () => mockConfig,
}));

const mockRunModelLoginWatch = vi.hoisted(() => vi.fn());
vi.mock("./model-login-watch.js", () => ({
  runModelLoginWatch: mockRunModelLoginWatch,
}));

// Event bus mock — test that ritual failures emit schedule.run_failed events
// (Dim-4 R5 fix). Without this mock getEventBus() throws because initEventBus
// is never called in tests; the stub captures emission calls for assertion.
const mockEmitEvent = vi.fn();
const mockSubscribe = vi.fn();
vi.mock("../lib/event-bus.js", () => ({
  getEventBus: () => ({ emitEvent: mockEmitEvent, subscribe: mockSubscribe }),
}));

// Pre-cycle tag, tag prune and stale-artifact prune run their git/docker
// children through promisified execFile (async since 2026-10-26,
// MCEventLoopBlock). Every other spawning child_process export is a stub that
// THROWS when called (modules in the import graph only bind them at load), so
// no test can spawn a real git/docker child.
const mockExecFile = vi.hoisted(() => vi.fn());
const mockStdinEnd = vi.hoisted(() => vi.fn());
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  const refuse =
    (name: string) =>
    (..._args: unknown[]): never => {
      throw new Error(`scheduler.test: real child_process.${name} reached`);
    };
  type ChildErr = Error & { stdout?: string; stderr?: string };
  type ChildCb = (err: ChildErr | null, stdout: string, stderr: string) => void;
  const fail = (cb: ChildCb, e: unknown) => {
    const err = e as ChildErr;
    setImmediate(() => cb(err, err.stdout ?? "", err.stderr ?? ""));
  };
  // Real `(…, cb) => cb(err, stdout, stderr)` shape; mockExecFile returns
  // stdout (or a promise of it, to hold the child open) or throws; delivery
  // on setImmediate like a real child. util.promisify.custom mirrors the real
  // `{stdout, stderr}` resolution with `.child` on the promise.
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
        { child: { stdin: { end: mockStdinEnd } } },
      ),
  });
  return {
    ...actual,
    exec: refuse("exec"),
    execSync: refuse("execSync"),
    execFileSync: refuse("execFileSync"),
    spawn: refuse("spawn"),
    spawnSync: refuse("spawnSync"),
    fork: refuse("fork"),
    execFile: child,
  };
});

// The evolution-log-commit cron's own work is pinned in its module's tests;
// here the cron callback's await + failure recording is what is under test.
const mockCommitEvolutionLog = vi.hoisted(() => vi.fn());
vi.mock("./evolution-log-commit.js", () => ({
  commitEvolutionLogIfDirty: mockCommitEvolutionLog,
}));

// autonomous-improvement cron dynamic-imports this; createImprovementTask is
// async (returns Promise<TaskSubmission | null>).
const mockCreateImprovementTask = vi.hoisted(() => vi.fn());
vi.mock("./autonomous-improvement.js", () => ({
  createImprovementTask: mockCreateImprovementTask,
}));

import {
  _resetRitualFailureAlertState,
  createPreCycleTag,
  notifyRitualFailure,
  pruneOldTags,
  selectStaleContainersForPrune,
  startRitualScheduler,
  stopRitualScheduler,
} from "./scheduler.js";
import { createMorningBriefing } from "./morning.js";
import { createNightlyClose } from "./nightly.js";
import { createEvolutionRitual } from "./evolution.js";
import { createSignalIntelligence } from "./signal-intelligence.js";
import { createEvolutionLogEntry } from "./evolution-log.js";
import { createDayNarrative } from "./day-narrative.js";
import { createWeeklyReview } from "./weekly-review.js";
import { nowMexIsoDate } from "../lib/timezone.js";

beforeEach(() => {
  vi.clearAllMocks();
  // Re-wire after clearAllMocks
  mockAll.mockReturnValue([]);
  mockPrepare.mockReturnValue({ get: mockGet, all: mockAll });
  // hindsight-cost-pull is gated on HINDSIGHT_ENABLED=true since 2026-05-18
  // to suppress 288 empty-pull log lines/day under the SDK cutover. Set
  // explicitly so the schedule-count assertion below stays at 18.
  process.env.HINDSIGHT_ENABLED = "true";
});

afterEach(() => {
  stopRitualScheduler();
  delete process.env.HINDSIGHT_ENABLED;
});

describe("startRitualScheduler", () => {
  it("should schedule enabled rituals", () => {
    startRitualScheduler();
    // 5 base rituals (+ day-narrative; weekly-review DISABLED 2026-06-23,
    //   NorthStar work-source; morning-briefing RETIRED 2026-08-03 —
    //   Morning Sync is the operator surface) + 2 F9 market rituals
    //   (morning-scan + eod-scan)
    //   + 1 KB backup + 1 KB reindex (2026-05-07) + 1 autonomous improvement + 1 diff digest
    //   + 1 canary + 1 memory consolidation + 1 stale-artifact-prune (v7.7.3)
    //   + 1 hindsight-cost-pull (2026-05-07, queue #4) — PM daily rebalance
    //   (F8.1c) ARCHIVED 2026-10-04, not scheduled
    //   + 1 evolution-log-commit (weekly durability, 2026-06-17)
    //   + 1 no-verdict-reminder (V8.5 4.6, 2026-07-14)
    //   + 1 jme-consolidate (JME Phase 2 nightly batch, 2026-07-14)
    expect(mockSchedule).toHaveBeenCalledTimes(18);
    // JME nightly consolidation runs pre-dawn MX (Phase 2, audit C3).
    expect(mockSchedule.mock.calls.some((c) => c[0] === "45 2 * * *")).toBe(
      true,
    );
    // The §17 reminder must run in the evening, MX time (V8.5 4.6).
    expect(mockSchedule.mock.calls.some((c) => c[0] === "0 20 * * *")).toBe(
      true,
    );
  });

  it("should pass timezone to cron.schedule", () => {
    startRitualScheduler();
    const calls = mockSchedule.mock.calls;
    for (const call of calls) {
      expect(call[2]).toEqual(
        expect.objectContaining({ timezone: expect.any(String) }),
      );
    }
  });

  it("skips hindsight-cost-pull when HINDSIGHT_ENABLED!=true", () => {
    // 2026-05-18: the */5min cost-pull was emitting series=0 cost=$0 logs
    // 288×/day under the SDK cutover (HINDSIGHT_ENABLED=false). Confirm the
    // gate fires when the env var is absent.
    const prior = process.env.HINDSIGHT_ENABLED;
    delete process.env.HINDSIGHT_ENABLED;
    try {
      startRitualScheduler();
      expect(mockSchedule).toHaveBeenCalledTimes(17);
    } finally {
      if (prior !== undefined) process.env.HINDSIGHT_ENABLED = prior;
    }
  });

  it("schedules hindsight-cost-pull when HINDSIGHT_COST_PULL_ENABLED=true overrides", () => {
    // Operator escape hatch: force-run cost-pull even with writes off.
    const priorEnabled = process.env.HINDSIGHT_ENABLED;
    const priorOverride = process.env.HINDSIGHT_COST_PULL_ENABLED;
    delete process.env.HINDSIGHT_ENABLED;
    process.env.HINDSIGHT_COST_PULL_ENABLED = "true";
    try {
      startRitualScheduler();
      expect(mockSchedule).toHaveBeenCalledTimes(18);
    } finally {
      if (priorEnabled !== undefined)
        process.env.HINDSIGHT_ENABLED = priorEnabled;
      if (priorOverride !== undefined) {
        process.env.HINDSIGHT_COST_PULL_ENABLED = priorOverride;
      } else {
        delete process.env.HINDSIGHT_COST_PULL_ENABLED;
      }
    }
  });
});

describe("model-login-watch wiring", () => {
  const loginWatchCall = () =>
    mockSchedule.mock.calls.find((c) => c[2]?.name === "model-login-watch");

  afterEach(() => {
    delete mockConfig.inferencePrimaryProvider;
  });

  it("registers hourly only when claude-sdk is the primary provider", () => {
    startRitualScheduler();
    expect(loginWatchCall()).toBeUndefined();
    stopRitualScheduler();

    mockConfig.inferencePrimaryProvider = "claude-sdk";
    startRitualScheduler();
    expect(loginWatchCall()?.[0]).toBe("7 * * * *");
  });

  it("a throwing watch is recorded as a ritual failure", async () => {
    mockConfig.inferencePrimaryProvider = "claude-sdk";
    mockRunModelLoginWatch.mockRejectedValueOnce(new Error("not delivered"));
    startRitualScheduler();
    await (loginWatchCall()?.[1] as () => Promise<void>)();
    expect(mockEmitEvent).toHaveBeenCalledWith(
      "schedule.run_failed",
      expect.objectContaining({
        ritual_id: "model-login-watch",
        phase: "execute",
        error: expect.stringContaining("not delivered"),
      }),
    );
  });
});

describe("stopRitualScheduler", () => {
  it("should stop all scheduled jobs", () => {
    const mockStop = vi.fn();
    mockSchedule.mockReturnValue({ stop: mockStop, on: vi.fn() });

    startRitualScheduler();
    stopRitualScheduler();

    expect(mockStop).toHaveBeenCalledTimes(18);
  });
});

describe("idempotency", () => {
  it("should skip if ritual already ran today", async () => {
    // Simulate existing task found in DB
    mockGet.mockReturnValue({ 1: 1 });

    startRitualScheduler();

    // Extract the callback from the first cron.schedule call and execute it
    const callback = mockSchedule.mock.calls[0][1] as () => Promise<void>;
    await callback();

    expect(mockSubmitTask).not.toHaveBeenCalled();
  });

  it("should submit if ritual has not run today", async () => {
    // No existing task
    mockGet.mockReturnValue(undefined);

    startRitualScheduler();

    const callback = mockSchedule.mock.calls[0][1] as () => Promise<void>;
    await callback();

    expect(mockSubmitTask).toHaveBeenCalledTimes(1);
  });

  // F9 audit W-R2-3: scheduler-level trading-day gate for market rituals.
  // On a non-trading day the scheduler must short-circuit before submitTask —
  // even if the LLM instruction to check market_calendar is ignored.
  it("should skip market rituals on NYSE non-trading days", async () => {
    mockGet.mockReturnValue(undefined); // alreadyRanToday = false

    // Spy on the calendar module so we force !isNyseTradingDay.
    const calendarModule = await import("../finance/market-calendar.js");
    const spy = vi
      .spyOn(calendarModule, "isNyseTradingDay")
      .mockReturnValue(false);

    startRitualScheduler();

    // Find the cron callback for market-morning-scan (index may shift if other
    // rituals change; look it up by inspecting the schedule registry.)
    const { rituals } = await import("./config.js");
    const morningIdx = rituals
      .filter((r) => (r.id === "overnight-tuning" ? false : r.enabled))
      .findIndex((r) => r.id === "market-morning-scan");
    expect(morningIdx).toBeGreaterThanOrEqual(0);
    const callback = mockSchedule.mock.calls[
      morningIdx
    ][1] as () => Promise<void>;
    await callback();

    expect(mockSubmitTask).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("delayed same-day retry of a failed ritual", () => {
  const DELAY = 20 * 60_000;
  const PLAIN = '{"tools":["a"],"ritualId":"x"}'; // every real ritual row
  const RETRIED = '{"tags":["ritual-retry"],"ritualId":"x"}';
  const fire = async (statuses: string[], at = "2026-09-19T18:00:00Z") => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(at));
    mockGet.mockReturnValue(undefined); // alreadyRanToday = false
    startRitualScheduler();
    (mockSchedule.mock.calls[0][1] as () => void)();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockSubmitTask).toHaveBeenCalledTimes(1);
    mockAll.mockReturnValue(statuses.map((status) => ({ status })));
  };

  afterEach(() => {
    vi.useRealTimers();
    mockIsRitualPaused.mockReturnValue(false);
  });

  it("re-runs once when every attempt failed, and never a second time", async () => {
    await fire(["failed", "blocked"]);
    await vi.advanceTimersByTimeAsync(DELAY - 1);
    expect(mockSubmitTask).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mockSubmitTask).toHaveBeenCalledTimes(2);
    expect(mockSubmitTask.mock.calls[1][0].title).toBe(
      mockSubmitTask.mock.calls[0][0].title,
    );
    expect(mockSubmitTask.mock.calls[0][0].tags ?? []).not.toContain(
      "ritual-retry",
    );
    expect(mockSubmitTask.mock.calls[1][0].tags).toContain("ritual-retry");
    await vi.advanceTimersByTimeAsync(DELAY * 3);
    expect(mockSubmitTask).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["one attempt succeeded", ["failed", "completed_with_concerns"]],
    ["an attempt is still in flight", ["failed", "running"]],
    ["the only task was cancelled (no rows)", []],
  ])("does not re-run when %s", async (_label, statuses) => {
    await fire(statuses);
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(mockSubmitTask).toHaveBeenCalledTimes(1);
  });

  it("does not re-run past midnight (the title would claim tomorrow's run)", async () => {
    await fire(["failed"], "2026-09-20T05:50:00Z"); // 23:50 America/Mexico_City
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(mockSubmitTask).toHaveBeenCalledTimes(1);
  });

  it("a paused ritual is not re-run", async () => {
    await fire(["failed"]);
    mockIsRitualPaused.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(mockSubmitTask).toHaveBeenCalledTimes(1);
  });

  it("a crash on the timer path is recorded as a ritual failure", async () => {
    await fire(["failed"]);
    mockAll.mockImplementation(() => {
      throw new Error("SQLITE_BUSY");
    });
    await vi.advanceTimersByTimeAsync(DELAY);
    mockAll.mockReset();
    expect(mockSubmitTask).toHaveBeenCalledTimes(1);
    expect(mockEmitEvent).toHaveBeenCalledWith(
      "schedule.run_failed",
      expect.objectContaining({
        phase: "execute",
        error: expect.stringContaining("SQLITE_BUSY"),
      }),
    );
  });

  it("stopRitualScheduler cancels a pending retry", async () => {
    await fire(["failed"]);
    stopRitualScheduler();
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(mockSubmitTask).toHaveBeenCalledTimes(1);
  });

  it("never re-runs a day that already carries a ritual-retry task", async () => {
    await fire(["failed"]);
    mockAll.mockReturnValue([
      { status: "failed", metadata: PLAIN },
      { status: "failed", metadata: RETRIED },
    ]);
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(mockSubmitTask).toHaveBeenCalledTimes(1);
  });

  // A restart drops the timers: boot re-arms the check from the task rows.
  const boot = (rows: Array<{ status: string; metadata?: string }>) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T18:00:00Z"));
    mockAll.mockReturnValueOnce(rows); // first ritual only; the rest see []
    startRitualScheduler();
  };

  it.each([
    ["every attempt failed", [{ status: "failed", metadata: PLAIN }]],
    [
      "a reaction retry was still in flight at boot",
      [{ status: "failed" }, { status: "pending" }],
    ],
  ])("boot re-arms the check when %s", async (_label, rows) => {
    boot(rows);
    mockAll.mockReturnValue([
      { status: "failed", metadata: PLAIN },
      { status: "failed", metadata: PLAIN },
    ]);
    await vi.advanceTimersByTimeAsync(DELAY - 1);
    expect(mockSubmitTask).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(mockSubmitTask).toHaveBeenCalledTimes(1);
    expect(mockSubmitTask.mock.calls[0][0].tags).toContain("ritual-retry");
    // The once-mock lands on the first enabled ritual; a config reorder fails here.
    expect(mockSubmitTask.mock.calls[0][0].ritualId).toBe(
      "signal-intelligence",
    );
  });

  it("boot never re-arms market-morning-scan (a late 'pre-mercado' scan is wrong-by-time)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-18T18:00:00Z")); // a Friday, NYSE open
    mockAll.mockImplementation((title: string) =>
      title.startsWith("Market morning scan") ? [{ status: "failed" }] : [],
    );
    startRitualScheduler();
    await vi.advanceTimersByTimeAsync(DELAY);
    mockAll.mockReset();
    expect(mockSubmitTask).not.toHaveBeenCalled();
  });

  it.each([
    ["an attempt completed", [{ status: "failed" }, { status: "completed" }]],
    ["the day was already re-run", [{ status: "failed", metadata: RETRIED }]],
    ["nothing failed", [{ status: "running" }]],
    ["the ritual has not run today", []],
  ])("boot does not re-arm when %s", async (_label, rows) => {
    boot(rows);
    mockAll.mockReturnValue([{ status: "failed" }]);
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(mockSubmitTask).not.toHaveBeenCalled();
  });

  it("a DB error in the boot check is recorded and does not stop scheduling", () => {
    mockAll.mockImplementationOnce(() => {
      throw new Error("SQLITE_BUSY");
    });
    startRitualScheduler();
    expect(mockSchedule).toHaveBeenCalledTimes(18);
    expect(mockEmitEvent).toHaveBeenCalledWith(
      "schedule.run_failed",
      expect.objectContaining({
        phase: "execute",
        error: expect.stringContaining("SQLITE_BUSY"),
      }),
    );
  });
});

describe("ritual failure events (Dim-4 R5 fix)", () => {
  it("emits schedule.run_failed when submitTask throws", async () => {
    mockGet.mockReturnValue(undefined); // alreadyRanToday = false
    mockSubmitTask.mockRejectedValueOnce(new Error("dispatcher dead"));

    startRitualScheduler();

    const callback = mockSchedule.mock.calls[0][1] as () => Promise<void>;
    await callback();

    expect(mockEmitEvent).toHaveBeenCalledWith(
      "schedule.run_failed",
      expect.objectContaining({
        phase: "submit",
        error: expect.stringContaining("dispatcher dead"),
        ritual_id: expect.any(String),
      }),
    );
  });

  it("does not emit schedule.run_failed on successful ritual submission", async () => {
    mockGet.mockReturnValue(undefined);
    mockSubmitTask.mockResolvedValueOnce({
      taskId: "t1",
      agentType: "fast",
      classification: { score: 0.9, reason: "ok", explicit: true },
    });

    startRitualScheduler();

    const callback = mockSchedule.mock.calls[0][1] as () => Promise<void>;
    await callback();

    expect(mockEmitEvent).not.toHaveBeenCalledWith(
      "schedule.run_failed",
      expect.anything(),
    );
  });
});

// Lane C: the schedule.run_failed event previously had ZERO consumers. These
// pin (a) that startRitualScheduler subscribes a consumer, and (b) that the
// consumer pages the operator once per ritual within the debounce window.
describe("schedule.run_failed notifier", () => {
  beforeEach(() => {
    _resetRitualFailureAlertState();
  });

  it("startRitualScheduler subscribes a consumer to schedule.run_failed", () => {
    startRitualScheduler();
    expect(mockSubscribe).toHaveBeenCalledWith(
      "schedule.run_failed",
      expect.any(Function),
    );
  });

  it("delivers an operator alert containing the ritual id + phase", async () => {
    const send = vi.fn().mockResolvedValue({ sent: 1, failed: 0 });
    await notifyRitualFailure(
      { ritual_id: "kb-reindex", error: "boom", phase: "execute" },
      { send, now: () => 1_000_000 },
    );
    expect(send).toHaveBeenCalledTimes(1);
    const text = send.mock.calls[0][0] as string;
    expect(text).toContain("kb-reindex");
    expect(text).toContain("execute");
    expect(text).toContain("boom");
  });

  it("debounces repeat failures of the SAME ritual within the cooldown", async () => {
    const send = vi.fn().mockResolvedValue({ sent: 1, failed: 0 });
    const payload = {
      ritual_id: "hindsight-cost-pull",
      error: "x",
      phase: "execute" as const,
    };
    await notifyRitualFailure(payload, { send, now: () => 1_000_000 });
    // 1 minute later — still inside the 30-min cooldown → suppressed.
    await notifyRitualFailure(payload, { send, now: () => 1_060_000 });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("re-alerts a DIFFERENT ritual immediately (debounce is per ritual_id)", async () => {
    const send = vi.fn().mockResolvedValue({ sent: 1, failed: 0 });
    await notifyRitualFailure(
      { ritual_id: "a", error: "x", phase: "execute" },
      { send, now: () => 1_000_000 },
    );
    await notifyRitualFailure(
      { ritual_id: "b", error: "y", phase: "submit" },
      { send, now: () => 1_000_100 },
    );
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("zero-delivery clears the debounce so the next failure retries", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ sent: 0, failed: 0 }) // nobody got it
      .mockResolvedValueOnce({ sent: 1, failed: 0 });
    const payload = {
      ritual_id: "morning-briefing",
      error: "x",
      phase: "execute" as const,
    };
    await notifyRitualFailure(payload, { send, now: () => 1_000_000 });
    await notifyRitualFailure(payload, { send, now: () => 1_060_000 });
    expect(send).toHaveBeenCalledTimes(2);
  });
});

// 2026-10-03: the PRODUCTION path — the scheduler loads the right file and
// the submitted description carries it (audit W1: the template tests alone
// let "scheduler passes null" and "morning loads today" mutants survive).
describe("scheduler embeds the harness-loaded log in the submitted task", () => {
  async function submitted(id: string) {
    mockGet.mockReturnValue(undefined); // alreadyRanToday = false
    mockSubmitTask.mockClear();
    const { rituals } = await import("./config.js");
    const r = rituals.find((x) => x.id === id)!;
    const wasEnabled = r.enabled;
    r.enabled = true; // morning-briefing is retired (enabled: false)
    try {
      startRitualScheduler();
      const enabled = rituals.filter((x) =>
        x.id === "overnight-tuning" ? false : x.enabled,
      );
      const idx = enabled.findIndex((x) => x.id === id);
      const callback = mockSchedule.mock.calls[idx][1] as () => unknown;
      await callback();
    } finally {
      r.enabled = wasEnabled;
    }
    expect(mockSubmitTask).toHaveBeenCalledTimes(1);
    const date = new Date().toLocaleDateString("en-CA", {
      timeZone: r.timezone ?? "America/Mexico_City",
    });
    return { sub: mockSubmitTask.mock.calls[0][0], date };
  }

  it.each([
    ["nightly-close", "logs/day-logs"],
    ["day-narrative", "logs/day-logs"],
    ["evolution-log", "logs/day-narratives"],
  ])("%s embeds today's %s file", async (id, dir) => {
    const { sub, date } = await submitted(id);
    const path = `${dir}/${date}.md`;
    expect(mockGetFile).toHaveBeenCalledWith(path);
    expect(sub.description).toContain(`contenido de ${path}`);
    expect(sub.description).toContain(`⟦BEGIN `);
  });

  it("morning-briefing embeds YESTERDAY's narrative", async () => {
    const { previousDateLabel } = await import("./morning.js");
    const { sub, date } = await submitted("morning-briefing");
    const path = `logs/day-narratives/${previousDateLabel(date)}.md`;
    expect(mockGetFile).toHaveBeenCalledWith(path);
    expect(mockGetFile).not.toHaveBeenCalledWith(
      `logs/day-narratives/${date}.md`,
    );
    expect(sub.description).toContain(`contenido de ${path}`);
  });

  // Audit C1: the embedded log mentions DENUE; the fast runner's guard falls
  // back to title+description without detectionText, and evolution-log holds
  // shell_exec (variant "full").
  it.each(["nightly-close", "day-narrative", "evolution-log", "morning-briefing"])(
    "%s: a DENUE mention in the embedded log does not arm the DENUE guard",
    async (id) => {
      // denueGuardText prefers detectionText (fast-runner.test.ts pins that a
      // ritual-shaped input with detectionText = title is not guarded).
      const { sub } = await submitted(id);
      expect(sub.description).toContain("DENUE 05/2026");
      expect(sub.detectionText).toBe(sub.title);
      expect(sub.title).not.toMatch(/denue/i);
    },
  );
});

describe("task templates", () => {
  it("morning briefing has correct structure", () => {
    const task = createMorningBriefing("2026-03-13");
    expect(task.title).toBe("Morning briefing — 2026-03-13");
    expect(task.agentType).toBe("fast");
    expect(task.tools).toContain("jarvis_file_read");
    expect(task.description).toContain("Jarvis");
    expect(task.description).toContain("Eisenhower");
  });

  it("nightly close has correct structure", () => {
    const task = createNightlyClose("2026-03-13", "# Day Log: 2026-03-13\n");
    expect(task.title).toBe("Nightly close — 2026-03-13");
    expect(task.agentType).toBe("fast");
    // 2026-10-03: the harness embeds the day-log; no model-side read.
    expect(task.tools).toEqual(["project_list", "gmail_send"]);
    expect(task.description).toContain("Jarvis");
    // Converted 2026-06-23: grounded in the day-log (work-truth), not NorthStar.
    expect(task.description).toContain("day-log");
    expect(task.description).toContain("Do NOT");
  });

  it("signal intelligence has correct structure", () => {
    const task = createSignalIntelligence("2026-03-25");
    expect(task.title).toBe("Signal intelligence — 2026-03-25");
    expect(task.agentType).toBe("fast");
    expect(task.tools).toContain("exa_search");
    expect(task.tools).toContain("web_search");
    expect(task.tools).toContain("gmail_send");
    expect(task.requiredTools).toContain("exa_search");
    expect(task.description).toContain("signal");
  });

  it("signal intelligence does not store the digest as a user fact (queue 3v 2c)", () => {
    const task = createSignalIntelligence("2026-10-15", "");
    expect(task.description).not.toContain("user_fact_set");
    expect(task.description).not.toContain("signal_digest");
    expect(task.tools).not.toContain("user_fact_set");
    expect(task.requiredTools).not.toContain("user_fact_set");
    expect(task.requiredTools).toEqual(
      expect.arrayContaining(["exa_search", "gmail_send"]),
    );
  });

  it("evolution ritual has correct structure", () => {
    const task = createEvolutionRitual("2026-03-18");
    expect(task.title).toBe("Skill evolution — 2026-03-18");
    expect(task.agentType).toBe("heavy");
    expect(task.tools).toContain("evolution_get_data");
    expect(task.tools).toContain("evolution_deactivate_skill");
    // memory_store removed 2026-06-28: persistence is now deterministic via
    // persistResult (the agent skipped the discretionary store ~100% of the
    // time on Sonnet). See evolution.test.ts for the full coverage.
    expect(task.tools).not.toContain("memory_store");
    expect(task.persistResult).toEqual({
      bank: "mc-operational",
      tags: ["evolution", "ritual"],
    });
    expect(task.description).toContain("evolution mode");
  });

  it("evolution log has correct structure", () => {
    const task = createEvolutionLogEntry("2026-04-05", null);
    expect(task.title).toBe("Evolution log — 2026-04-05");
    expect(task.agentType).toBe("fast");
    expect(task.tools).toContain("jarvis_file_read");
    expect(task.tools).toContain("file_read");
    // Mechanical count injected — no LLM estimation
    expect(task.description).toContain("Pre-computed metrics");
    expect(task.description).toContain("Conversations today: 0");
  });

  it("day narrative has correct structure", () => {
    const task = createDayNarrative("2026-04-17", "# Day Log: 2026-04-17\n");
    expect(task.title).toBe("Day log narrative — 2026-04-17");
    expect(task.agentType).toBe("fast");
    // 2026-10-03: the harness embeds the raw log; the model only writes.
    expect(task.tools).toEqual(["jarvis_file_write"]);
    // Source path — raw log — must be embedded, never modified
    expect(task.description).toContain("logs/day-logs/2026-04-17.md");
    // Companion path — narrative output
    expect(task.description).toContain("logs/day-narratives/2026-04-17.md");
    // Immutability rule must be stated in the prompt
    expect(task.description).toMatch(/inmutable|Do NOT modify/i);
  });

  it("weekly review has correct structure", () => {
    const task = createWeeklyReview("2026-04-05");
    expect(task.title).toBe("Weekly review — 2026-04-05");
    expect(task.agentType).toBe("fast");
    expect(task.tools).toContain("jarvis_file_read");
    expect(task.tools).toContain("gmail_send");
  });

  // F9 audit R1: end-to-end reachability — every tool name referenced in
  // market-ritual templates MUST resolve in the real builtin registry. This
  // catches regressions like round-1 C1 (telegram_send doesn't exist).
  // Tools registered dynamically at runtime (MCP servers, Google Workspace
  // bridge, etc.) — not part of BuiltinToolSource. Rituals are allowed to
  // reference these; the regression we're guarding against is *phantom* tool
  // names that exist nowhere (like F9 round-1 C1's `telegram_send`).
  const RUNTIME_REGISTERED_TOOLS = new Set<string>([
    "gmail_send",
    "gmail_read",
    "gmail_search",
    "gdocs_read",
    "gdocs_read_full",
    "gsheets_read",
    "gsheets_write",
    "gdrive_list",
    "calendar_list",
    "calendar_create",
  ]);

  it("market-morning-scan tools all exist in the registry", async () => {
    const { createMarketMorningScan } =
      await import("./market-morning-scan.js");
    const { ToolRegistry } = await import("../tools/registry.js");
    const { BuiltinToolSource } = await import("../tools/sources/builtin.js");
    const reg = new ToolRegistry();
    await new BuiltinToolSource().registerTools(reg);
    const tpl = createMarketMorningScan("2026-04-20");
    for (const t of tpl.tools ?? []) {
      if (RUNTIME_REGISTERED_TOOLS.has(t)) continue;
      expect(reg.get(t), `tool missing: ${t}`).toBeDefined();
    }
    for (const t of tpl.requiredTools ?? []) {
      expect(
        tpl.tools,
        `requiredTools entry ${t} must appear in tools`,
      ).toContain(t);
    }
  });

  it("market-eod-scan tools all exist in the registry", async () => {
    const { createMarketEodScan } = await import("./market-eod-scan.js");
    const { ToolRegistry } = await import("../tools/registry.js");
    const { BuiltinToolSource } = await import("../tools/sources/builtin.js");
    const reg = new ToolRegistry();
    await new BuiltinToolSource().registerTools(reg);
    const tpl = createMarketEodScan("2026-04-20");
    for (const t of tpl.tools ?? []) {
      if (RUNTIME_REGISTERED_TOOLS.has(t)) continue;
      expect(reg.get(t), `tool missing: ${t}`).toBeDefined();
    }
    for (const t of tpl.requiredTools ?? []) {
      expect(
        tpl.tools,
        `requiredTools entry ${t} must appear in tools`,
      ).toContain(t);
    }
  });

  // F8.1c — PM daily rebalance ritual
  it("pm-daily-rebalance tools all exist in the registry", async () => {
    const { createPmDailyRebalance } = await import("./pm-daily-rebalance.js");
    const { ToolRegistry } = await import("../tools/registry.js");
    const { BuiltinToolSource } = await import("../tools/sources/builtin.js");
    const reg = new ToolRegistry();
    await new BuiltinToolSource().registerTools(reg);
    const tpl = createPmDailyRebalance("2026-04-21");
    for (const t of tpl.tools ?? []) {
      if (RUNTIME_REGISTERED_TOOLS.has(t)) continue;
      expect(reg.get(t), `tool missing: ${t}`).toBeDefined();
    }
    for (const t of tpl.requiredTools ?? []) {
      expect(
        tpl.tools,
        `requiredTools entry ${t} must appear in tools`,
      ).toContain(t);
    }
  });

  it("pm-daily-rebalance dispatch case is wired in getTaskTemplate", async () => {
    // startRitualScheduler iterates rituals[] and dispatches via getTaskTemplate.
    // Confirm the scheduler actually calls createPmDailyRebalance for the new id.
    // R2 MAJ-1: the cron callback is `() => void executeRitual(ritual)` — the
    // void wrapper swallows rejected promises, so a not-toThrow check is a
    // false-positive. Instead assert that submitTask was called (i.e. the
    // dispatch path resolved the template successfully and reached submission)
    // by forcing alreadyRanToday=false.
    mockGet.mockReturnValue(undefined); // alreadyRanToday = false
    mockSubmitTask.mockClear();

    const { rituals } = await import("./config.js");
    const r = rituals.find((x) => x.id === "pm-daily-rebalance");
    expect(r).toBeDefined();

    // ARCHIVED 2026-10-04 (enabled: false); the case stays wired so that
    // re-enabling is a flag flip — flip it for this test only.
    r!.enabled = true;
    try {
      startRitualScheduler();
      const enabled = rituals.filter((x) =>
        x.id === "overnight-tuning" ? false : x.enabled,
      );
      const idx = enabled.findIndex((x) => x.id === "pm-daily-rebalance");
      expect(idx).toBeGreaterThanOrEqual(0);
      const callback = mockSchedule.mock.calls[idx][1] as () => unknown;
      // Drive the callback and await its async work. If getTaskTemplate's
      // switch is missing the pm-daily-rebalance case, executeRitual throws
      // "Unknown ritual" and submitTask is never called.
      await callback();
    } finally {
      r!.enabled = false;
    }
    expect(mockSubmitTask).toHaveBeenCalled();
    // And confirm the submitted task title came from createPmDailyRebalance,
    // not some other ritual template — tight binding of dispatch → template.
    const submission = mockSubmitTask.mock.calls[0][0];
    expect(submission.title).toMatch(/PM daily rebalance/);
  });

  // F8.1c N-R2-2: confirm PM daily rebalance is NOT gated by NYSE trading-day
  // check — PM markets don't follow equity calendar. Force non-trading-day
  // and assert the PM ritual still submits.
  it("pm-daily-rebalance is NOT gated by NYSE trading-day check", async () => {
    mockGet.mockReturnValue(undefined);
    mockSubmitTask.mockClear();
    const calendarModule = await import("../finance/market-calendar.js");
    const spy = vi
      .spyOn(calendarModule, "isNyseTradingDay")
      .mockReturnValue(false);

    const { rituals } = await import("./config.js");
    const r = rituals.find((x) => x.id === "pm-daily-rebalance");
    // ARCHIVED 2026-10-04 (enabled: false) — flip it for this test only.
    r!.enabled = true;
    try {
      startRitualScheduler();
      const enabled = rituals.filter((x) =>
        x.id === "overnight-tuning" ? false : x.enabled,
      );
      const idx = enabled.findIndex((x) => x.id === "pm-daily-rebalance");
      expect(idx).toBeGreaterThanOrEqual(0);
      const callback = mockSchedule.mock.calls[idx][1] as () => unknown;
      await callback();
    } finally {
      r!.enabled = false;
    }
    expect(mockSubmitTask).toHaveBeenCalled();
    spy.mockRestore();
  });
});

// v7.7.4 audit follow-up — the stale-artifact prune filter MUST NOT
// match long-running monitoring containers that share the `mc-` prefix
// (mc-grafana, mc-prometheus, mc-node-exporter). The strict
// mc-<prefix>-<13-digit-timestamp> name regex from
// generateContainerName() is the safety boundary.
describe("selectStaleContainersForPrune", () => {
  const now = Date.parse("2026-04-14T23:00:00Z");
  const oldCreatedAt = "2026-04-04 18:45:36 +0000 UTC"; // 10 days old
  const freshCreatedAt = "2026-04-14 22:30:00 +0000 UTC"; // 30 min old

  it("protects mc-grafana from deletion (the blocker from audit C1)", () => {
    const out = selectStaleContainersForPrune(
      `f7b72b232513\tmc-grafana\t${oldCreatedAt}`,
      now,
    );
    expect(out).toEqual([]);
  });

  it("protects mc-prometheus from deletion", () => {
    const out = selectStaleContainersForPrune(
      `abc123\tmc-prometheus\t${oldCreatedAt}`,
      now,
    );
    expect(out).toEqual([]);
  });

  it("protects mc-node-exporter from deletion", () => {
    const out = selectStaleContainersForPrune(
      `abc124\tmc-node-exporter\t${oldCreatedAt}`,
      now,
    );
    expect(out).toEqual([]);
  });

  it("protects any mc- prefix container without the 13-digit timestamp suffix", () => {
    const out = selectStaleContainersForPrune(
      `abc125\tmc-somebody-else\t${oldCreatedAt}\nabc126\tmc-foo\t${oldCreatedAt}`,
      now,
    );
    expect(out).toEqual([]);
  });

  it("removes runner containers matching mc-<prefix>-<13-digit-timestamp>", () => {
    const ts = "1776123456789"; // exactly 13 digits
    const out = selectStaleContainersForPrune(
      `deadbeef\tmc-task-${ts}\t${oldCreatedAt}`,
      now,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("deadbeef");
    expect(out[0]!.name).toBe(`mc-task-${ts}`);
  });

  it("removes runner containers with sanitized multi-word prefix", () => {
    const out = selectStaleContainersForPrune(
      `id1\tmc-heavy-runner-task-1776123456789\t${oldCreatedAt}`,
      now,
    );
    expect(out).toHaveLength(1);
  });

  it("does not remove runner containers younger than 6 hours", () => {
    const out = selectStaleContainersForPrune(
      `id1\tmc-task-1776123456789\t${freshCreatedAt}`,
      now,
    );
    expect(out).toEqual([]);
  });

  it("handles mixed output — grafana survives, orphan gets removed", () => {
    const mixed = [
      `f7b72b232513\tmc-grafana\t${oldCreatedAt}`,
      `deadbeef0001\tmc-task-1776000000000\t${oldCreatedAt}`,
      `deadbeef0002\tmc-prometheus\t${oldCreatedAt}`,
      `deadbeef0003\tmc-node-exporter\t${oldCreatedAt}`,
      `deadbeef0004\tmc-heavy-1776000000001\t${oldCreatedAt}`,
    ].join("\n");
    const out = selectStaleContainersForPrune(mixed, now);
    expect(out.map((c) => c.name)).toEqual([
      "mc-task-1776000000000",
      "mc-heavy-1776000000001",
    ]);
  });

  it("skips lines with malformed CreatedAt (NaN from Date.parse)", () => {
    const out = selectStaleContainersForPrune(
      `id1\tmc-task-1776000000000\tnot-a-date`,
      now,
    );
    expect(out).toEqual([]);
  });

  it("skips empty lines and lines with missing columns", () => {
    const out = selectStaleContainersForPrune(
      `\nid1\tmc-task-1776000000000\nid2\t\t${oldCreatedAt}\n`,
      now,
    );
    expect(out).toEqual([]);
  });

  it("caps the batch at PRUNE_BATCH_CAP=50 to prevent arg-list overflow", () => {
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) {
      const ts = (1776000000000 + i).toString();
      lines.push(`id${i}\tmc-task-${ts}\t${oldCreatedAt}`);
    }
    const out = selectStaleContainersForPrune(lines.join("\n"), now);
    expect(out).toHaveLength(50);
  });

  it("rejects names with invalid chars (uppercase, underscore)", () => {
    const lines = [
      `id1\tmc-Task-1776000000000\t${oldCreatedAt}`, // uppercase T
      `id2\tmc_task-1776000000000\t${oldCreatedAt}`, // underscore
      `id3\tmc-task-177600000000a\t${oldCreatedAt}`, // letter in timestamp
    ].join("\n");
    const out = selectStaleContainersForPrune(lines, now);
    expect(out).toEqual([]);
  });
});

describe("usability Phase 5.5 — paused rituals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsRitualPaused.mockReturnValue(false);
  });
  afterEach(() => {
    stopRitualScheduler();
  });

  it("a paused ritual never reaches submitTask; unpausing restores it", async () => {
    mockGet.mockReturnValue(undefined); // alreadyRanToday = false
    mockIsRitualPaused.mockImplementation((id: string) => id === "signal-intelligence");
    startRitualScheduler();
    const { rituals } = await import("./config.js");
    const idx = rituals
      .filter((r) => (r.id === "overnight-tuning" ? false : r.enabled))
      .findIndex((r) => r.id === "signal-intelligence");
    const callback = mockSchedule.mock.calls[idx][1] as () => Promise<void>;
    await callback();
    expect(mockSubmitTask).not.toHaveBeenCalled();

    mockIsRitualPaused.mockReturnValue(false);
    await callback();
    expect(mockSubmitTask).toHaveBeenCalledTimes(1);
  });
});

describe("jme-consolidate cron (JME Phase 4 wiring)", () => {
  it("runs consolidateAll → pruneStaleTurns → pruneExpiredFacts and logs the expired count", async () => {
    mockGet.mockReturnValue(undefined);
    mockJme.consolidateAll.mockResolvedValue({
      turnsProcessed: 3,
      factsExtracted: 2,
      factsInserted: 1,
      factsSkipped: 1,
      factsSuperseded: 0,
    });
    mockJme.pruneStaleTurns.mockReturnValue(4);
    mockJme.pruneExpiredFacts.mockReturnValue(7);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    startRitualScheduler();
    const call = mockSchedule.mock.calls.find((c) => c[0] === "45 2 * * *");
    expect(call).toBeDefined();
    await (call![1] as () => Promise<void>)();

    expect(mockJme.consolidateAll).toHaveBeenCalledTimes(1);
    expect(mockJme.pruneStaleTurns).toHaveBeenCalledTimes(1);
    expect(mockJme.pruneExpiredFacts).toHaveBeenCalledTimes(1);
    expect(
      logSpy.mock.calls.some((c) => String(c[0]).includes("4 stale pruned, 7 expired facts pruned")),
    ).toBe(true);
    logSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Queue 4ao sweep part 2 (2026-10-26): the ritual-time git/docker children run
// async (MCEventLoopBlock). Each site must yield the loop, keep its sequence,
// close stdin, and keep its failure handling.
// ---------------------------------------------------------------------------

/** Args (without the callback) of every recorded child, in call order. */
const childArgs = () => mockExecFile.mock.calls.map((c) => c[1] as string[]);
const flush = async (n = 5) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};
// Console spies restored individually: vi.restoreAllMocks() would also wipe
// the shared mockSchedule return value that startRitualScheduler needs.
let consoleSpies: Array<{ mockRestore: () => void }> = [];
const silenceConsole = () => {
  consoleSpies = [
    vi.spyOn(console, "log").mockImplementation(() => {}),
    vi.spyOn(console, "error").mockImplementation(() => {}),
  ];
};
const restoreConsole = () => consoleSpies.forEach((s) => s.mockRestore());
const cronCallback = (id: string) => {
  const call = mockSchedule.mock.calls.find((c) => c[2]?.name === id);
  expect(call).toBeDefined();
  return call![1] as () => Promise<void>;
};

describe("createPreCycleTag (async git)", () => {
  const tagName = () => `pre-auto-${nowMexIsoDate()}`;

  beforeEach(() => {
    mockExecFile.mockReset();
    mockExecFile.mockReturnValue("");
    silenceConsole();
  });
  afterEach(() => restoreConsole());

  it("skips `tag -a` when the tag already exists", async () => {
    mockExecFile.mockReturnValueOnce(`${tagName()}\n`);
    await createPreCycleTag();
    expect(childArgs()).toEqual([["tag", "-l", tagName()]]);
    expect(mockExecFile.mock.calls[0][0]).toBe("git");
  });

  it("creates the annotated tag in MC_DIR when absent, then prunes", async () => {
    mockExecFile
      .mockReturnValueOnce("") // tag -l <name> → absent
      .mockReturnValueOnce("") // tag -a
      .mockReturnValueOnce(""); // tag -l pre-auto-* (prune list)
    await createPreCycleTag();
    expect(childArgs()).toEqual([
      ["tag", "-l", tagName()],
      ["tag", "-a", tagName(), "-m", "Pre-autonomous-improvement snapshot"],
      ["tag", "-l", "pre-auto-*", "--sort=-version:refname"],
    ]);
    expect(mockExecFile.mock.calls[1][2]).toMatchObject({
      cwd: "/root/claude/mission-control",
      timeout: 10_000,
      encoding: "utf-8",
    });
    // Every child's stdin is closed exactly once.
    expect(mockStdinEnd).toHaveBeenCalledTimes(3);
  });

  it("yields the event loop: a setImmediate queued before the call runs first", async () => {
    const order: string[] = [];
    setImmediate(() => order.push("tick"));
    await createPreCycleTag();
    order.push("done");
    expect(order).toEqual(["tick", "done"]);
  });

  it("does not run `tag -a` until the `tag -l` check has returned", async () => {
    let release!: (out: string) => void;
    mockExecFile.mockImplementationOnce(
      () => new Promise<string>((r) => (release = r)),
    );
    let settled = false;
    const p = createPreCycleTag().then(() => (settled = true));
    await flush();
    expect(childArgs()).toEqual([["tag", "-l", tagName()]]);
    expect(settled).toBe(false);
    release("");
    await p;
    expect(childArgs()[1]?.slice(0, 2)).toEqual(["tag", "-a"]);
  });

  it("does not settle until the tag prune has finished", async () => {
    let release!: (out: string) => void;
    mockExecFile
      .mockReturnValueOnce("") // tag -l <name> → absent
      .mockReturnValueOnce("") // tag -a
      .mockImplementationOnce(() => new Promise<string>((r) => (release = r))); // prune list held
    let settled = false;
    const p = createPreCycleTag().then(() => (settled = true));
    await vi.waitFor(() => expect(childArgs()).toHaveLength(3));
    await flush();
    expect(settled).toBe(false);
    release("");
    await p;
    expect(settled).toBe(true);
  });

  it("a git failure stays non-fatal: logged, never rethrown or recorded", async () => {
    mockExecFile.mockImplementationOnce(() => {
      throw Object.assign(new Error("fatal: not a git repository"), {
        code: 128,
      });
    });
    await expect(createPreCycleTag()).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith(
      "[rituals] Failed to create pre-cycle tag:",
      expect.objectContaining({ message: "fatal: not a git repository" }),
    );
    expect(childArgs()).toHaveLength(1); // no tag -a after the failed check
    expect(mockEmitEvent).not.toHaveBeenCalledWith(
      "schedule.run_failed",
      expect.anything(),
    );
  });
});

describe("pruneOldTags (async git)", () => {
  // Sorted newest-first, as `--sort=-version:refname` returns them; all far
  // older than 30 days.
  const tags = Array.from(
    { length: 12 },
    (_, i) => `pre-auto-2020-01-${String(12 - i).padStart(2, "0")}`,
  );

  beforeEach(() => {
    mockExecFile.mockReset();
    mockExecFile.mockReturnValue("");
    silenceConsole();
  });
  afterEach(() => restoreConsole());

  it("deletes nothing when 10 or fewer tags exist", async () => {
    mockExecFile.mockReturnValueOnce(tags.slice(0, 10).join("\n") + "\n");
    await pruneOldTags();
    expect(childArgs()).toEqual([
      ["tag", "-l", "pre-auto-*", "--sort=-version:refname"],
    ]);
  });

  it("deletes the tags beyond the newest 10, oldest-listed last, in order", async () => {
    mockExecFile.mockReturnValueOnce(tags.join("\n") + "\n");
    await pruneOldTags();
    expect(childArgs().slice(1)).toEqual([
      ["tag", "-d", "pre-auto-2020-01-02"],
      ["tag", "-d", "pre-auto-2020-01-01"],
    ]);
    expect(mockStdinEnd).toHaveBeenCalledTimes(3);
  });

  it("deletes sequentially: a held-open first delete blocks the second", async () => {
    let release!: (out: string) => void;
    mockExecFile
      .mockReturnValueOnce(tags.join("\n") + "\n")
      .mockImplementationOnce(() => new Promise<string>((r) => (release = r)));
    let settled = false;
    const p = pruneOldTags().then(() => (settled = true));
    await flush();
    expect(childArgs().slice(1)).toEqual([
      ["tag", "-d", "pre-auto-2020-01-02"],
    ]);
    expect(settled).toBe(false);
    release("");
    await p;
    expect(childArgs().slice(1)).toEqual([
      ["tag", "-d", "pre-auto-2020-01-02"],
      ["tag", "-d", "pre-auto-2020-01-01"],
    ]);
  });
});

describe("autonomous-improvement cron (async tag + task)", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
    mockExecFile.mockReturnValue("");
    mockCreateImprovementTask.mockReset();
    silenceConsole();
  });
  afterEach(() => restoreConsole());

  it("finishes the pre-cycle tag before building the improvement task", async () => {
    let release!: (out: string) => void;
    mockExecFile.mockImplementationOnce(
      () => new Promise<string>((r) => (release = r)),
    );
    mockCreateImprovementTask.mockResolvedValue(null);
    startRitualScheduler();
    const run = cronCallback("autonomous-improvement")();
    await flush();
    expect(mockCreateImprovementTask).not.toHaveBeenCalled();
    release("pre-auto-exists\n"); // tag exists → no tag -a
    await run;
    expect(mockCreateImprovementTask).toHaveBeenCalledTimes(1);
    expect(mockSubmitTask).not.toHaveBeenCalled(); // null → nothing submitted
  });

  it("awaits createImprovementTask and submits the resolved task non-interactively", async () => {
    mockExecFile.mockReturnValueOnce("pre-auto-exists\n");
    mockCreateImprovementTask.mockResolvedValue({
      title: "fix",
      description: "d",
    });
    startRitualScheduler();
    await cronCallback("autonomous-improvement")();
    expect(mockSubmitTask).toHaveBeenCalledWith(
      expect.objectContaining({ title: "fix", interactive: false }),
    );
  });
});

describe("evolution-log-commit cron (async)", () => {
  beforeEach(() => {
    mockCommitEvolutionLog.mockReset();
    silenceConsole();
  });
  afterEach(() => restoreConsole());

  it("awaits the commit result before logging it", async () => {
    mockCommitEvolutionLog.mockResolvedValue({
      committed: true,
      reason: "committed",
      hash: "abc1234",
    });
    startRitualScheduler();
    await cronCallback("evolution-log-commit")();
    expect(mockCommitEvolutionLog).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith(
      "[rituals] evolution-log-commit: committed docs/EVOLUTION-LOG.md (abc1234)",
    );
  });

  it("a rejected commit reaches recordRitualFailure", async () => {
    mockCommitEvolutionLog.mockRejectedValue(new Error("fatal: index.lock"));
    startRitualScheduler();
    await cronCallback("evolution-log-commit")();
    expect(console.error).toHaveBeenCalledWith(
      "[rituals] evolution-log-commit failed:",
      expect.objectContaining({ message: "fatal: index.lock" }),
    );
    expect(mockEmitEvent).toHaveBeenCalledWith(
      "schedule.run_failed",
      expect.objectContaining({
        ritual_id: "evolution-log-commit",
        phase: "execute",
        error: expect.stringContaining("fatal: index.lock"),
      }),
    );
  });
});

describe("stale-artifact-prune cron (async docker)", () => {
  const old = "2020-01-01 00:00:00 +0000 UTC";
  const listing = [
    `aaa111\tmc-grafana\t${old}`, // guard: must survive
    `bbb222\tmc-task-1776123456789\t${old}`,
    `ccc333\tmc-heavy-1776123456790\t${old}`,
  ].join("\n");

  beforeEach(() => {
    mockExecFile.mockReset();
    mockExecFile.mockReturnValue("");
    silenceConsole();
  });
  afterEach(() => restoreConsole());

  it("does not settle while `docker container ls` is held open", async () => {
    let release!: (out: string) => void;
    mockExecFile.mockImplementationOnce(
      () => new Promise<string>((r) => (release = r)),
    );
    startRitualScheduler();
    let settled = false;
    const run = cronCallback("stale-artifact-prune")().then(
      () => (settled = true),
    );
    await flush();
    expect(settled).toBe(false);
    expect(mockExecFile.mock.calls[0][0]).toBe("docker");
    expect(childArgs()[0]?.slice(0, 3)).toEqual(["container", "ls", "-a"]);
    release("");
    await run;
    expect(childArgs()).toHaveLength(1); // empty listing → no rm
  });

  it("removes only guard-approved candidates, one rm at a time", async () => {
    let releaseRm!: (out: string) => void;
    mockExecFile
      .mockReturnValueOnce(listing)
      .mockImplementationOnce(
        () => new Promise<string>((r) => (releaseRm = r)),
      );
    startRitualScheduler();
    const run = cronCallback("stale-artifact-prune")();
    await flush();
    // First rm held open → second not started.
    expect(childArgs().slice(1)).toEqual([["container", "rm", "bbb222"]]);
    releaseRm("");
    await run;
    // mc-grafana never reaches rm (selectStaleContainersForPrune guard).
    expect(childArgs().slice(1)).toEqual([
      ["container", "rm", "bbb222"],
      ["container", "rm", "ccc333"],
    ]);
    expect(mockStdinEnd).toHaveBeenCalledTimes(3);
    expect(console.log).toHaveBeenCalledWith(
      "[rituals] stale-artifact-prune: removed 2 orphaned runner container(s)",
    );
  });

  it("a docker-unavailable list error is silent; any other is recorded", async () => {
    mockExecFile.mockImplementationOnce(() => {
      throw new Error("spawn docker ENOENT");
    });
    startRitualScheduler();
    await cronCallback("stale-artifact-prune")();
    expect(mockEmitEvent).not.toHaveBeenCalledWith(
      "schedule.run_failed",
      expect.anything(),
    );

    mockExecFile.mockImplementationOnce(() => {
      throw new Error("Command failed: docker container ls\nboom");
    });
    await cronCallback("stale-artifact-prune")();
    expect(mockEmitEvent).toHaveBeenCalledWith(
      "schedule.run_failed",
      expect.objectContaining({
        ritual_id: "stale-artifact-prune",
        phase: "execute",
      }),
    );
  });
});
