import { afterEach, describe, expect, it, vi } from "vitest";
import { cpuMsPerCall, GROWTH_BOUND, growth4x } from "./cpu-time.js";

// Deterministic: process.cpuUsage is replaced by a script, nothing is measured.
// Each round's cost is scripted in microseconds (as Node reports it). The
// cheapest round sits in the middle, so the first, the last and the most
// expensive round each give a different answer from the minimum; in that
// round user alone, system alone and their sum also differ.
const ROUNDS = [
  { user: 3000, system: 1000 }, // 4 ms
  { user: 1000, system: 500 }, // 1.5 ms: the minimum
  { user: 4000, system: 2000 }, // 6 ms
];

const realCpuUsage = process.cpuUsage;

/** Scripts process.cpuUsage and logs its calls and the calls of `fn` in order. */
function scripted() {
  const log: string[] = [];
  const start = { user: 7_000_000, system: 9_000_000 };
  const rounds = [...ROUNDS];
  vi.spyOn(process, "cpuUsage").mockImplementation((prev?: NodeJS.CpuUsage) => {
    if (prev === undefined) {
      log.push("start");
      return start;
    }
    if (prev !== start) throw new Error("cpuUsage diff not taken from the round's start");
    const d = rounds.shift();
    if (!d) throw new Error("more than three measured rounds");
    log.push("end");
    return d;
  });
  const fn = () => {
    log.push("fn");
  };
  return { log, fn };
}

afterEach(() => {
  vi.restoreAllMocks();
  expect(process.cpuUsage).toBe(realCpuUsage);
});

describe("cpuMsPerCall", () => {
  it("one warm-up call before the first measurement, then three rounds of `reps` calls", () => {
    const { log, fn } = scripted();
    cpuMsPerCall(fn, 2);
    const round = ["start", "fn", "fn", "end"];
    expect(log).toEqual(["fn", ...round, ...round, ...round]);
  });

  it("reps omitted: one call per round", () => {
    const { log, fn } = scripted();
    expect(cpuMsPerCall(fn)).toBe(1.5);
    const round = ["start", "fn", "end"];
    expect(log).toEqual(["fn", ...round, ...round, ...round]);
  });

  it("returns the cheapest round's user + system time, microseconds to milliseconds", () => {
    const { fn } = scripted();
    // Not 4 (first round), 6 (last or most expensive), 1 (user only), 0.5
    // (system only), 1500 (microseconds) or 0.0015 (seconds).
    expect(cpuMsPerCall(fn)).toBe(1.5);
  });

  it("divides the cheapest round by `reps`", () => {
    const { fn } = scripted();
    expect(cpuMsPerCall(fn, 2)).toBe(0.75);
  });
});

const N = 5;
const SMALL_US = 3000; // 3 ms per call of the smaller input

/**
 * Scripts process.cpuUsage as a virtual processor clock: each call of `fn`
 * advances it by the cost of its input, nothing is measured. The smaller
 * input costs `smallUs` per call; the larger costs `ratios[k] * smallUs` in
 * attempt k + 1, an attempt ending after three measured runs of the larger
 * input. Each cost is split three parts user time to one part system time, so
 * user alone, system alone and their sum all differ. A reading in an attempt
 * beyond `ratios` throws. `runs` logs the calls of `fn` inside each measured
 * run, in order; `outside` counts the calls made outside a measured run.
 */
function growthScript(ratios: number[], smallUs = SMALL_US) {
  const runs: number[] = [];
  const clock = { user: 0, system: 0 };
  let calls = 0;
  let outside = 0;
  let inRun = false;
  let largeInRun = false;
  let largeRuns = 0;
  vi.spyOn(process, "cpuUsage").mockImplementation((prev?: NodeJS.CpuUsage) => {
    if (prev === undefined) {
      if (largeRuns / 3 >= ratios.length) throw new Error("reading in an attempt that was not scripted");
      calls = 0;
      inRun = true;
      largeInRun = false;
      return { ...clock };
    }
    runs.push(calls);
    inRun = false;
    if (largeInRun) largeRuns++;
    return { user: clock.user - prev.user, system: clock.system - prev.system };
  });
  const make = vi.fn((size: number) => ({ size }));
  const fn = (input: { size: number }) => {
    calls++;
    if (!inRun) outside++;
    let cost = smallUs;
    if (input.size !== N) {
      largeInRun = true;
      cost = ratios[Math.floor(largeRuns / 3)]! * smallUs;
    }
    clock.user += cost * 0.75;
    clock.system += cost * 0.25;
  };
  return { make, fn, runs, outside: () => outside };
}

describe("growth4x", () => {
  it("measures make(n) against make(4 * n): the larger size's cost over the smaller's", () => {
    const { make, fn } = growthScript([4]);
    const g = growth4x(make, N, fn);
    expect(make.mock.calls).toEqual([[N], [4 * N]]);
    // Not 0.25 (smaller over larger).
    expect(g.ratio).toBe(4);
    expect(g.largeMs).toBe(12);
  });

  it("doubles the calls per run until one run of the smaller size reaches 40 ms, and stops there", () => {
    const { make, fn, runs } = growthScript([4]);
    const g = growth4x(make, N, fn);
    // 1, 2, 4 and 8 calls cost 3, 6, 12 and 24 ms; 16 calls cost 48 ms. Every
    // measured run of the attempt then uses those 16 calls. User time alone
    // would stop at 32 calls, system time alone at 64.
    expect(runs).toEqual([1, 2, 4, 8, 16, ...Array(6).fill(16)]);
    expect(g.label).toBe("12.000 ms / 3.000 ms per call, 16 calls per run, attempt 1");
  });

  it("keeps one call per run when the first run already reaches 40 ms", () => {
    const { make, fn, runs } = growthScript([4], 50_000);
    const g = growth4x(make, N, fn);
    expect(runs).toEqual([1, ...Array(6).fill(1)]);
    expect(g.label).toBe("200.000 ms / 50.000 ms per call, 1 calls per run, attempt 1");
  });

  it("keeps the smallest of three over-bound ratios; largeMs stays the first attempt's", () => {
    // The smallest sits in the middle: the first, the last and the largest
    // ratio each give a different answer.
    const { make, fn, outside } = growthScript([20, 10, 16]);
    const g = growth4x(make, N, fn);
    // One warm-up call before calibration, then cpuMsPerCall's warm-up of each
    // size in each of the three attempts.
    expect(outside()).toBe(1 + 2 * 3);
    expect(g.ratio).toBe(10);
    expect(g.largeMs).toBe(60);
    expect(g.label).toBe("30.000 ms / 3.000 ms per call, 16 calls per run, attempt 2");
  });

  it("measures at most three attempts", () => {
    // Each attempt improves on the last, so a fourth would be taken if it ran
    // (here it throws: only three are scripted); two would stop at 14.
    const { make, fn } = growthScript([16, 14, 12]);
    const g = growth4x(make, N, fn);
    expect(g.ratio).toBe(12);
    expect(g.label).toBe("36.000 ms / 3.000 ms per call, 16 calls per run, attempt 3");
  });

  it("stops at the first attempt under the bound", () => {
    expect(GROWTH_BOUND).toBe(8);
    // A third attempt would throw: only two are scripted.
    const { make, fn } = growthScript([10, 4]);
    const g = growth4x(make, N, fn);
    expect(g.ratio).toBe(4);
    expect(g.largeMs).toBe(30);
    expect(g.label).toBe("12.000 ms / 3.000 ms per call, 16 calls per run, attempt 2");
  });

  it("a ratio exactly at the bound is not under it: the next attempt runs", () => {
    const { make, fn, outside } = growthScript([GROWTH_BOUND, 4]);
    const g = growth4x(make, N, fn);
    expect(outside()).toBe(1 + 2 * 2);
    expect(g.ratio).toBe(4);
    expect(g.label).toBe("12.000 ms / 3.000 ms per call, 16 calls per run, attempt 2");
  });
});
