import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const mocks = vi.hoisted(() => ({
  schedule: vi.fn(),
  emitEvent: vi.fn(),
  busError: null as Error | null,
}));

vi.mock("node-cron", () => ({
  default: { schedule: mocks.schedule },
}));
vi.mock("./event-bus.js", () => ({
  getEventBus: () => {
    if (mocks.busError) throw mocks.busError;
    return { emitEvent: mocks.emitEvent };
  },
}));

import { scheduleCron, MISSED_EXECUTION_TOLERANCE_MS } from "./cron.js";

type MissedHandler = (ctx: { dateLocalIso: string }) => void;

function makeTask() {
  return { on: vi.fn(), stop: vi.fn() };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("scheduleCron", () => {
  it("schedules with the 60s missed-execution tolerance and the id as name", () => {
    mocks.schedule.mockReturnValue(makeTask());
    const fn = vi.fn();
    scheduleCron("my-job", "0 6 * * *", fn, {
      timezone: "America/Mexico_City",
    });
    expect(mocks.schedule).toHaveBeenCalledWith("0 6 * * *", fn, {
      name: "my-job",
      missedExecutionTolerance: MISSED_EXECUTION_TOLERANCE_MS,
      timezone: "America/Mexico_City",
    });
    expect(MISSED_EXECUTION_TOLERANCE_MS).toBe(60_000);
  });

  it("lets caller options override the tolerance default", () => {
    mocks.schedule.mockReturnValue(makeTask());
    scheduleCron("custom", "* * * * *", vi.fn(), {
      missedExecutionTolerance: 5_000,
    });
    expect(mocks.schedule).toHaveBeenCalledWith(
      "* * * * *",
      expect.any(Function),
      expect.objectContaining({ missedExecutionTolerance: 5_000 }),
    );
  });

  it("records a missed execution on the event bus with phase 'missed'", () => {
    const task = makeTask();
    mocks.schedule.mockReturnValue(task);
    const errSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    scheduleCron("morning-surface", "0 6 * * *", vi.fn());

    expect(task.on).toHaveBeenCalledWith(
      "execution:missed",
      expect.any(Function),
    );
    const handler = task.on.mock.calls[0][1] as MissedHandler;
    handler({ dateLocalIso: "2026-07-14T06:00:00" });

    expect(mocks.emitEvent).toHaveBeenCalledWith("schedule.run_failed", {
      ritual_id: "morning-surface",
      error: expect.stringContaining("missed execution"),
      phase: "missed",
    });
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("swallows an event-bus throw (missed-record is best-effort)", () => {
    const task = makeTask();
    mocks.schedule.mockReturnValue(task);
    mocks.emitEvent.mockImplementation(() => {
      throw new Error("bus not initialized");
    });
    const errSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    scheduleCron("j", "* * * * *", vi.fn());
    const handler = task.on.mock.calls[0][1] as MissedHandler;
    expect(() => handler({ dateLocalIso: "x" })).not.toThrow();
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("event bus unavailable"),
    );
    errSpy.mockRestore();
  });
});

type FailedHandler = (ctx: { execution?: { error?: unknown } }) => void;

/** The listener scheduleCron attached for `event` on the faked task. */
function listenerFor(task: ReturnType<typeof makeTask>, event: string) {
  const call = task.on.mock.calls.find((c) => c[0] === event);
  if (!call) throw new Error(`no listener for ${event}`);
  return call[1] as FailedHandler;
}

describe("scheduleCron — a failed execution is recorded", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mocks.emitEvent.mockReset();
    mocks.busError = null;
    errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    mocks.busError = null;
    vi.restoreAllMocks();
  });

  it("a job that throws or rejects gives one id-tagged console line and one run_failed event with phase 'execute'", () => {
    const task = makeTask();
    mocks.schedule.mockReturnValue(task);
    scheduleCron("cohort-rollup", "0 5 * * *", vi.fn());

    listenerFor(task, "execution:failed")({
      execution: { error: new Error("x".repeat(1500)) },
    });

    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0]).toEqual([
      "[cron] cohort-rollup: execution failed: " + "x".repeat(200),
    ]);
    expect(mocks.emitEvent).toHaveBeenCalledTimes(1);
    expect(mocks.emitEvent).toHaveBeenCalledWith("schedule.run_failed", {
      ritual_id: "cohort-rollup",
      error: "x".repeat(1000),
      phase: "execute",
    });
  });

  it("an unavailable event bus does not throw: the failure line plus one bus line", () => {
    const task = makeTask();
    mocks.schedule.mockReturnValue(task);
    mocks.busError = new Error("bus not initialized");
    scheduleCron("j", "* * * * *", vi.fn());
    const handler = listenerFor(task, "execution:failed");

    expect(() =>
      handler({ execution: { error: new Error("boom") } }),
    ).not.toThrow();
    expect(mocks.emitEvent).not.toHaveBeenCalled();
    expect(errSpy.mock.calls).toEqual([
      ["[cron] j: execution failed: boom"],
      [
        "[cron] j: event bus unavailable for failed-execution record (bus not initialized)",
      ],
    ]);
  });

  it.each([
    [
      "a message getter that throws",
      Object.defineProperty(new Error(), "message", {
        get() {
          throw new Error("getter");
        },
      }),
    ],
    ["a null-prototype object", Object.create(null) as object],
  ])("an unreadable error (%s) still gives the line and the event", (_label, error) => {
    const task = makeTask();
    mocks.schedule.mockReturnValue(task);
    scheduleCron("j", "* * * * *", vi.fn());

    listenerFor(task, "execution:failed")({ execution: { error } });

    expect(errSpy.mock.calls).toEqual([
      ["[cron] j: execution failed: (unreadable error)"],
    ]);
    expect(mocks.emitEvent).toHaveBeenCalledWith("schedule.run_failed", {
      ritual_id: "j",
      error: "(unreadable error)",
      phase: "execute",
    });
  });

  it("never throws, even when console.error throws", () => {
    const task = makeTask();
    mocks.schedule.mockReturnValue(task);
    errSpy.mockImplementation(() => {
      throw new Error("stderr closed");
    });
    scheduleCron("j", "* * * * *", vi.fn());
    expect(() =>
      listenerFor(task, "execution:failed")({ execution: { error: "s" } }),
    ).not.toThrow();
  });

  it("leaves the missed-execution listener in place", () => {
    const task = makeTask();
    mocks.schedule.mockReturnValue(task);
    scheduleCron("j", "* * * * *", vi.fn());
    expect(task.on.mock.calls.map((c) => c[0])).toEqual([
      "execution:missed",
      "execution:failed",
    ]);
  });
});

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Non-test .ts files under `dir`, skipping node_modules. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(abs));
    else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts")
    )
      out.push(abs);
  }
  return out;
}

/**
 * `text` split on `sep` where it stands outside strings, comments and
 * brackets, up to the first unmatched close bracket.
 */
function splitTopLevel(text: string, sep: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: string | null = null;
  let end = text.length;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      i = text.indexOf("\n", i);
      if (i === -1) break;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
      if (i === 0) break;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) {
        end = i;
        break;
      }
      depth--;
    } else if (ch === sep && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start, end));
  return parts;
}

/**
 * `text` with strings, comments and everything inside brackets dropped, so
 * only the statement's own outer chain is left: `a(x).catch((e) => {...})`
 * reads `a().catch()`, `try {...} catch (e) {...}` reads `try {} catch () {}`.
 */
function outerText(text: string): string {
  let out = "";
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      i = text.indexOf("\n", i);
      if (i === -1) break;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
      if (i === 0) break;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "(" || ch === "[" || ch === "{") {
      if (depth === 0) out += ch;
      depth++;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) out += ch;
    } else if (depth === 0) out += ch;
  }
  return out;
}

/** Leading whitespace and comments are not part of a function or statement. */
const LEADING = /^(?:\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*/;

/** The third argument (the job function) of every `scheduleCron(` call. */
function jobFunctionArgs(text: string): string[] {
  const out: string[] = [];
  const re = /\bscheduleCron\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const args = splitTopLevel(text.slice(m.index + m[0].length), ",");
    if (args.length >= 3) out.push(args[2].replace(LEADING, ""));
  }
  return out;
}

/** Arrow parameters: a parenthesised list (optionally typed) or one bare name. */
const PARAMS = String.raw`(?:\([^)]*\)(?:\s*:[^=]*)?|[\w$]+)\s*=>`;
/** An arrow whose expression body is `void …`. */
const VOID_ARROW = new RegExp(String.raw`^(?:async\s+)?${PARAMS}\s*void\b`);
/** A function whose body is a block: arrow (with or without parentheses) or `function`. */
const BLOCK_HEAD = new RegExp(
  String.raw`^(?:async\s+)?(?:${PARAMS}|function\b[^(]*\([^)]*\)[^{]*)\s*\{`,
);
/** A statement that hands its promise on (returns, awaits or keeps it). */
const KEEPS_PROMISE = /^(?:return|await|const|let|var)\b/;

/**
 * True when the job function detaches a promise: an arrow whose body is
 * `void …`, or a top-level statement of a block body that is a `void`
 * statement or whose own outer chain calls `.catch(` without returning,
 * awaiting or keeping the result.
 */
function detachesPromise(fn: string): boolean {
  if (VOID_ARROW.test(fn)) return true;
  const head = BLOCK_HEAD.exec(fn);
  if (!head) return false;
  return splitTopLevel(fn.slice(head[0].length), ";").some((raw) => {
    const outer = outerText(raw.replace(LEADING, ""));
    if (/(?:^|\})\s*void\b/.test(outer)) return true;
    return !KEEPS_PROMISE.test(outer) && /\.\s*catch\s*\(/.test(outer);
  });
}

describe("no scheduled job detaches its promise", () => {
  // A job function returns its promise: node-cron only sees a rejection it
  // was handed, and only then does scheduleCron's failed-execution record fire.
  it("no non-test file under src/ passes a scheduleCron job function that detaches a promise", () => {
    const offenders: string[] = [];
    let calls = 0;
    for (const file of sourceFiles(join(REPO, "src"))) {
      for (const fn of jobFunctionArgs(readFileSync(file, "utf8"))) {
        calls++;
        if (detachesPromise(fn)) {
          offenders.push(`${relative(REPO, file)}: ${fn.split("\n")[0]}`);
        }
      }
    }
    // Guards against a scan that reads nothing.
    expect(calls).toBeGreaterThan(25);
    expect(offenders).toEqual([]);
  });

  it("the scan reads a call that spans lines and one with a string holding a comma", () => {
    const text = [
      "scheduleCron(",
      '  "a, b",',
      "  EXPR, // a comment, with a comma",
      "  () =>",
      "    void run(x, y).catch(() => {}),",
      "  { timezone: TZ },",
      ");",
      "scheduleCron(`s3-${c}`, EXPR, () => run(c), { timezone: TZ });",
    ].join("\n");
    const fns = jobFunctionArgs(text);
    expect(fns).toHaveLength(2);
    expect(detachesPromise(fns[0])).toBe(true);
    expect(detachesPromise(fns[1])).toBe(false);
  });

  it.each([
    "() => { void tick(); }",
    "x => void tick()",
    "async () => {\n  void tick();\n}",
    "function () { void tick(); }",
    "() => {\n  tick().catch((err) => log(err));\n}",
    "() => {\n  // first\n  a().catch(() => {});\n  return b();\n}",
    "function job() {\n  tick()\n    .then(next)\n    .catch(() => {});\n}",
    "() => {\n  if (on) {\n    run();\n  }\n  void tick();\n}",
    "() => {\n  const s = \"; void\";\n  tick().catch(() => {});\n}",
  ])("refuses a job function that detaches: %s", (fn) => {
    expect(detachesPromise(fn)).toBe(true);
  });

  it.each([
    "() => tick()",
    "() => tick().catch((err) => log(err))",
    "x => tick(x)",
    "() => {\n  return tick().catch((err) => log(err));\n}",
    "async () => {\n  await tick().catch(() => {});\n}",
    "() => {\n  return Promise.all([a().catch(() => {}), b().catch(() => {})]);\n}",
    "() => {\n  const p = tick().catch(() => {});\n  return p;\n}",
    "runTick",
  ])("accepts a job function that hands its promise on: %s", (fn) => {
    expect(detachesPromise(fn)).toBe(false);
  });

  it("reads only top-level statements: a `void` or `.catch(` nested in a try block is not read", () => {
    const fn =
      "async () => {\n  try {\n    await run();\n    void beat().catch(() => {});\n    notify().catch(() => {});\n  } catch (err) {\n    log(err);\n  }\n}";
    expect(detachesPromise(fn)).toBe(false);
  });
});
