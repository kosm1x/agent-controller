import { afterEach, describe, expect, it, vi } from "vitest";
import { cpuMsPerCall } from "./cpu-time.js";

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
