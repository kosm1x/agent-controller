/**
 * The optional scheduled jobs registered at boot. Every job module is replaced
 * by a mock that supplies only its register function as a spy, so no real job
 * module loads and nothing is scheduled; the switches are driven through env
 * stubs, read when the function runs. A mock factory's module is cached for
 * the whole file, so a failing job is a register spy that throws: its block's
 * catch is the same one a failed load reaches.
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerOptionalCrons } from "./optional-crons.js";

const h = vi.hoisted(() => {
  const spies = {
    decay: vi.fn(),
    s3: vi.fn(),
    sweep: vi.fn(),
    cohort: vi.fn(),
    prune: vi.fn(),
    weekly: vi.fn(),
    retention: vi.fn(),
    sycophancy: vi.fn(),
    xProbe: vi.fn(),
    triage: vi.fn(),
  };
  /** A job module: exports only its register function, as a spy. */
  const mod = (job: keyof typeof spies, name: string) => ({ [name]: spies[job] });
  return { spies, mod };
});

vi.mock("./memory/lesson-decay.js", () => h.mod("decay", "registerDecayCron"));
vi.mock("./lib/s3/scheduler.js", () => h.mod("s3", "registerS3CronJobs"));
vi.mock("./skills/test-sweep.js", () => h.mod("sweep", "registerSkillsTestSweepCron"));
vi.mock("./cohort/rollup-cron.js", () => h.mod("cohort", "registerCohortRollupCron"));
vi.mock("./runners/checkpoint-prune-cron.js", () => h.mod("prune", "registerCheckpointPruneCron"));
vi.mock("./finance/weekly-refresh-cron.js", () => h.mod("weekly", "registerWeeklyRefreshCron"));
vi.mock("./db/retention-cron.js", () => h.mod("retention", "registerRetentionCron"));
vi.mock("./lib/v8-2/probe-cron.js", () => h.mod("sycophancy", "registerSycophancyProbeCron"));
vi.mock("./lib/x-poster/probe-cron.js", () => h.mod("xProbe", "registerXProbeCron"));
vi.mock("./lib/self-healing/triage-cron.js", () => h.mod("triage", "registerTriageCron"));

type Job = keyof typeof h.spies;
const JOBS = Object.keys(h.spies) as Job[];

/** The same module requests as the function's, to wait on a positive signal instead of a clock. */
const IMPORTS: Record<Job, () => Promise<unknown>> = {
  decay: () => import("./memory/lesson-decay.js"),
  s3: () => import("./lib/s3/scheduler.js"),
  sweep: () => import("./skills/test-sweep.js"),
  cohort: () => import("./cohort/rollup-cron.js"),
  prune: () => import("./runners/checkpoint-prune-cron.js"),
  weekly: () => import("./finance/weekly-refresh-cron.js"),
  retention: () => import("./db/retention-cron.js"),
  sycophancy: () => import("./lib/v8-2/probe-cron.js"),
  xProbe: () => import("./lib/x-poster/probe-cron.js"),
  triage: () => import("./lib/self-healing/triage-cron.js"),
};

/** Every switch in its ON position. */
const ALL_ON: Record<string, string | undefined> = {
  JARVIS_SKILLS_TEST_SWEEP_DISABLED: undefined,
  JARVIS_COHORT_ROLLUP_DISABLED: undefined,
  V82_JUDGMENT_PRODUCER_ENABLED: "true",
  X_PROBE_ENABLED: "true",
  SELF_HEALING_TRIAGE_ENABLED: "true",
};

/** The warning each block logs when its load or registration fails. */
const WARNINGS: Record<Job, string> = {
  decay: "[lesson-decay] Registration failed (non-fatal):",
  s3: "[s3] Cron registration failed (non-fatal):",
  sweep: "[skills] Test sweep cron registration failed (non-fatal)",
  cohort: "[cohort] Roll-up cron registration failed (non-fatal)",
  prune: "[checkpoint] prune cron registration failed (non-fatal)",
  weekly: "[weekly-refresh] cron registration failed (non-fatal)",
  retention: "[retention] cron registration failed (non-fatal)",
  sycophancy: "[v8.2] sycophancy probe cron registration failed (non-fatal)",
  xProbe: "[x-probe] cron registration failed (non-fatal)",
  triage: "[self-healing] triage cron registration failed (non-fatal)",
};
/** The two blocks that warn through the console, not the logger. */
const CONSOLE_WARNED = new Set<Job>(["decay", "s3"]);

let log: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
let consoleWarn: ReturnType<typeof vi.spyOn>;

function setSwitches(env: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
}

/** Starts the jobs and waits until the expected modules' requests have settled. */
async function start(expected: Job[]): Promise<void> {
  registerOptionalCrons(log as unknown as Parameters<typeof registerOptionalCrons>[0]);
  await Promise.allSettled(expected.map((j) => IMPORTS[j]()));
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const spy of Object.values(h.spies)) spy.mockReset();
  log = { info: vi.fn(), warn: vi.fn() };
  consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("registerOptionalCrons", () => {
  it("registers every job once, each with the options its block passes, and warns about nothing", async () => {
    setSwitches(ALL_ON);
    await start(JOBS);

    for (const j of JOBS) expect(h.spies[j], j).toHaveBeenCalledTimes(1);
    expect(h.spies.decay).toHaveBeenCalledWith();
    expect(h.spies.s3).toHaveBeenCalledWith();
    // The (msg, fields) blocks hand the logger its arguments the other way round.
    for (const j of ["sweep", "cohort", "prune", "weekly", "retention", "sycophancy", "triage"] as const) {
      const opts = h.spies[j].mock.calls[0][0] as {
        info: (msg: string, fields?: object) => void;
        warn: (msg: string, fields?: object) => void;
      };
      expect(Object.keys(opts).sort(), j).toEqual(["info", "warn"]);
      opts.info("an info line", { n: 1 });
      expect(log.info, j).toHaveBeenLastCalledWith({ n: 1 }, "an info line");
      opts.warn("a warn line");
      expect(log.warn, j).toHaveBeenLastCalledWith({}, "a warn line");
    }
    // The x probe's log takes the message only.
    const x = h.spies.xProbe.mock.calls[0][0] as { info: (msg: string) => void; warn: (msg: string) => void };
    expect(Object.keys(x).sort()).toEqual(["info", "warn"]);
    x.info("x info");
    expect(log.info).toHaveBeenLastCalledWith("x info");
    x.warn("x warn");
    expect(log.warn).toHaveBeenLastCalledWith("x warn");

    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it.each([
    ["sweep", "JARVIS_SKILLS_TEST_SWEEP_DISABLED", "true"],
    ["cohort", "JARVIS_COHORT_ROLLUP_DISABLED", "true"],
    ["sycophancy", "V82_JUDGMENT_PRODUCER_ENABLED", undefined],
    ["xProbe", "X_PROBE_ENABLED", undefined],
    ["triage", "SELF_HEALING_TRIAGE_ENABLED", undefined],
  ] as const)("%s: its switch %s in the OFF position keeps the job from loading; the others register", async (job, name, off) => {
    setSwitches({ ...ALL_ON, [name]: off });
    const others = JOBS.filter((j) => j !== job);
    await start(others);

    expect(h.spies[job]).not.toHaveBeenCalled();
    for (const j of others) expect(h.spies[j], j).toHaveBeenCalledTimes(1);
  });

  it('every switch set to "false": the jobs off unless enabled stay off, the jobs on unless disabled register', async () => {
    setSwitches({
      JARVIS_SKILLS_TEST_SWEEP_DISABLED: "false",
      JARVIS_COHORT_ROLLUP_DISABLED: "false",
      V82_JUDGMENT_PRODUCER_ENABLED: "false",
      X_PROBE_ENABLED: "false",
      SELF_HEALING_TRIAGE_ENABLED: "false",
    });
    const off: Job[] = ["sycophancy", "xProbe", "triage"];
    const on = JOBS.filter((j) => !off.includes(j));
    await start(on);

    for (const j of off) expect(h.spies[j], j).not.toHaveBeenCalled();
    for (const j of on) expect(h.spies[j], j).toHaveBeenCalledTimes(1);
  });

  it("requests the job modules in the order the blocks are written", () => {
    // The requests are fire-and-forget and their mocks are cached, so their order
    // cannot be observed at run time; reading the source is the honest check.
    const text = readFileSync(new URL("./optional-crons.ts", import.meta.url), "utf8");
    expect([...text.matchAll(/\bimport\("([^"]+)"\)/g)].map((m) => m[1])).toEqual([
      "./memory/lesson-decay.js",
      "./lib/s3/scheduler.js",
      "./skills/test-sweep.js",
      "./cohort/rollup-cron.js",
      "./runners/checkpoint-prune-cron.js",
      "./finance/weekly-refresh-cron.js",
      "./db/retention-cron.js",
      "./lib/v8-2/probe-cron.js",
      "./lib/x-poster/probe-cron.js",
      "./lib/self-healing/triage-cron.js",
    ]);
  });

  it.each(JOBS)("%s: a failing job logs its block's warning and does not stop the other jobs", async (job) => {
    setSwitches(ALL_ON);
    h.spies[job].mockImplementation(() => {
      throw new Error(`${job} failed to register`);
    });
    await start(JOBS);

    for (const j of JOBS) expect(h.spies[j], j).toHaveBeenCalledTimes(1);
    if (CONSOLE_WARNED.has(job)) {
      expect(consoleWarn).toHaveBeenCalledTimes(1);
      expect(consoleWarn).toHaveBeenCalledWith(WARNINGS[job], `${job} failed to register`);
      expect(log.warn).not.toHaveBeenCalled();
    } else {
      expect(log.warn).toHaveBeenCalledTimes(1);
      expect(log.warn).toHaveBeenCalledWith({ err: new Error(`${job} failed to register`) }, WARNINGS[job]);
      expect(consoleWarn).not.toHaveBeenCalled();
    }
  });
});
