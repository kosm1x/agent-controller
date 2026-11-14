/**
 * The check runner's two deadlines, observed as work done instead of elapsed
 * time: a check that outlives its limit has its process group stopped once at
 * the limit and is judged FAILED; an EXPECT regex that its sandbox deadline
 * ends is a non-match. Stand-ins only: `node:child_process` spawns a recorded
 * stand-in child (every other entry point throws), the group kill is handed in
 * and only recorded (`process.kill` itself throws if reached), and `node:vm`
 * records the sandbox call and either runs it or throws the vm's own timeout
 * error. Fake timers pass the limits.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { EventEmitter } from "node:events";

const fake = vi.hoisted(() => ({
  child: null as unknown,
  spawns: [] as unknown[][],
  vmCalls: [] as Array<{ context: unknown; options: unknown }>,
  vmTimesOut: false,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const refuse = (): never => {
    throw new Error("a real child process was requested");
  };
  const spawn = (...args: unknown[]): unknown => {
    if (fake.child === null) refuse();
    fake.spawns.push(args);
    const child = fake.child;
    fake.child = null; // one stand-in per arming
    return child;
  };
  const stubs = { spawn, exec: refuse, execFile: refuse, execSync: refuse, execFileSync: refuse, spawnSync: refuse, fork: refuse };
  return { ...actual, ...stubs, default: { ...actual, ...stubs } };
});

const REGEX_SANDBOX_CODE = "new RegExp(pattern, flags).test(haystack)";
vi.mock("node:vm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:vm")>();
  const runInNewContext = (code: string, context: Record<string, unknown>, options: unknown): unknown => {
    if (code !== REGEX_SANDBOX_CODE) throw new Error(`unexpected sandbox code: ${code}`);
    fake.vmCalls.push({ context: { ...context }, options });
    if (fake.vmTimesOut) {
      throw Object.assign(new Error("Script execution timed out after the deadline"), { code: "ERR_SCRIPT_EXECUTION_TIMEOUT" });
    }
    return actual.runInNewContext(code, context, options as never);
  };
  return { ...actual, runInNewContext, default: { ...actual, runInNewContext } };
});

import { expectMatches, runCheck, runShellCheck, safeRegexTest } from "./gate-check.js";
import { REGEX_DEADLINE_MS } from "./expect.js";

/**
 * A stand-in for the spawned shell. A stand-in id is one no real process can have:
 * above every process id Linux can assign (ids stay below 4_194_304), so even an
 * accidental real signal to it or its group could only fail with "no such process".
 */
function standInChild() {
  const kills: unknown[] = [];
  const child = Object.assign(new EventEmitter(), {
    pid: 4_194_305,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: (...a: unknown[]) => {
      kills.push(a);
      return true;
    },
  });
  return { child, kills };
}

let processKill: MockInstance<typeof process.kill>;
beforeEach(() => {
  fake.child = null;
  fake.spawns = [];
  fake.vmCalls = [];
  fake.vmTimesOut = false;
  // Backstop: the default group kill must never be reached from these cases.
  processKill = vi.spyOn(process, "kill").mockImplementation(() => {
    throw new Error("process.kill reached from a stand-in case");
  });
  vi.useFakeTimers({ now: Date.UTC(2030, 0, 1) });
});
afterEach(() => {
  vi.useRealTimers();
  processKill.mockRestore();
});

describe("runShellCheck — a check that outlives its limit", () => {
  // The whole group gets SIGKILL (negative pid), so a backgrounded grandchild
  // holding the pipes dies with the shell; the stop happens AT the limit, once.
  it("stops the process group once at the limit and reports timedOut with what it printed", async () => {
    const { child, kills: childKills } = standInChild();
    fake.child = child;
    const groupKills: Array<[number, NodeJS.Signals]> = [];
    const pending = runShellCheck("sleep 5 & wait", { timeoutMs: 200 }, (pid, signal) => {
      groupKills.push([pid, signal]);
    });
    expect(fake.spawns).toHaveLength(1);
    const [file, args, options] = fake.spawns[0]!;
    expect(file).toBe("/bin/sh");
    expect(args).toEqual(["-c", "sleep 5 & wait"]);
    // Only the two fields under test: the env option carries the child's environment.
    const { detached, stdio } = options as { detached?: unknown; stdio?: unknown };
    expect({ detached, stdio }).toEqual({ detached: true, stdio: ["ignore", "pipe", "pipe"] });

    child.stdout.emit("data", Buffer.from("partial line\n"));
    vi.advanceTimersByTime(199);
    expect(groupKills).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(groupKills).toEqual([[-4_194_305, "SIGKILL"]]);

    child.emit("close", null);
    const r = await pending;
    expect(r).toEqual({ output: "partial line\n", exitCode: null, timedOut: true });
    vi.advanceTimersByTime(60_000);
    expect(groupKills).toHaveLength(1);
    expect(childKills).toEqual([]);
    expect(processKill).not.toHaveBeenCalled();
  });

  it("runCheck hands its limit to the runner and judges the timed-out check FAILED with that fact as evidence", async () => {
    const { child } = standInChild();
    fake.child = child;
    const groupKills: number[] = [];
    const limits: number[] = [];
    const pending = runCheck(
      { check_cmd: "sleep 5", expect: null },
      {
        timeoutMs: 200,
        exec: (command, opts) => {
          limits.push(opts.timeoutMs);
          return runShellCheck(command, opts, (pid) => {
            groupKills.push(pid);
          });
        },
      },
    );
    await vi.advanceTimersByTimeAsync(199);
    expect(limits).toEqual([200]);
    expect(groupKills).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(groupKills).toEqual([-4_194_305]);
    child.emit("close", null);
    const outcome = await pending;
    expect(outcome).toMatchObject({ ok: false, timedOut: true, exitCode: null });
    expect(outcome.notRunnable).toBeUndefined();
    expect(outcome.evidence).toBe("timed out after 200ms | (no output)");
    expect(processKill).not.toHaveBeenCalled();
  });
});

describe("EXPECT regex — the sandbox deadline ends a runaway match as a non-match", () => {
  it("a regex run that the deadline ends is false, armed with the regex deadline; it never throws", () => {
    fake.vmTimesOut = true;
    const haystack = "a".repeat(40);
    expect(expectMatches("/(a|aa)+b/", haystack)).toBe(false);
    expect(fake.vmCalls).toEqual([{ context: { pattern: "(a|aa)+b", flags: "", haystack }, options: { timeout: REGEX_DEADLINE_MS } }]);
  });

  it("a gate whose EXPECT regex is ended by the deadline FAILS even when the check exits 0", async () => {
    fake.vmTimesOut = true;
    const out = "aaaa";
    const outcome = await runCheck(
      { check_cmd: "cat out.txt", expect: "/(a|aa)+b/" },
      {
        timeoutMs: 1000,
        exec: async (command) => {
          if (command !== "cat out.txt") throw new Error(`unexpected command ${command}`);
          return { output: `${out}\n`, exitCode: 0, timedOut: false };
        },
      },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.notRunnable).toBeUndefined();
    expect(outcome.evidence).toBe(`${out} (exit 0)`);
    expect(fake.vmCalls).toHaveLength(1);
    expect(fake.vmCalls[0]!.options).toEqual({ timeout: REGEX_DEADLINE_MS });
  });

  it("nested quantifiers are refused before the sandbox; a sane pattern runs in it under the same deadline", () => {
    expect(safeRegexTest("(a+)+b", "", "aaab")).toBe(false);
    expect(safeRegexTest("x**", "", "x")).toBe(false);
    expect(fake.vmCalls).toEqual([]);
    expect(safeRegexTest("(\\d+) passed", "", "Tests 12 passed")).toBe(true);
    expect(safeRegexTest("PASSED", "i", "3 passed")).toBe(true);
    expect(fake.vmCalls.map((c) => c.options)).toEqual([{ timeout: REGEX_DEADLINE_MS }, { timeout: REGEX_DEADLINE_MS }]);
  });
});
