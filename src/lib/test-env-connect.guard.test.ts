import { beforeAll, describe, expect, it, onTestFailed } from "vitest";
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  recordOutsideConnections,
  type ConnectRecorder,
} from "../test-utils/outside-connect-record.js";

// Rule: no test process connects to another machine. The per-worker setup
// file (vitest.setup-env.ts) wraps net.Socket.prototype.connect once: an
// attempt to a host that is not this machine never reaches the original
// connect, the caller gets an ordinary connection error naming the host, the
// port and the rule, and the attempt is recorded (one line in
// mc-test-outside-connections.jsonl in the folder TMPDIR names, and the
// in-process list). The setup's afterEach fails the test that made it even
// when the caller swallowed the error, and empties the list for the next test.
// Nothing here dials anything: every call that would reach the original
// connect reaches a stand-in, and the outside address is a documentation one.
const SUITE = "outside-connection guard";
const REFUSED_CASE = "an attempt to an outside host is refused before the original runs, and recorded with exactly file, test, host and port";
const THIS_FILE = `src/lib/${basename(fileURLToPath(import.meta.url))}`;
const OUTSIDE = "192.0.2.10";

function installed(): ConnectRecorder {
  const recorder = (globalThis as typeof globalThis & { __outsideConnectRecorder?: ConnectRecorder })
    .__outsideConnectRecorder;
  if (!recorder) throw new Error("the test setup did not install the connection guard");
  return recorder;
}

/** Runs `run` with the guard's original and record file replaced, restoring both on every exit. */
async function withStandIn<T>(
  standIn: (this: net.Socket, ...args: never[]) => unknown,
  file: string,
  run: () => Promise<T>,
): Promise<T> {
  const recorder = installed();
  const saved = { original: recorder.original, recordFile: recorder.recordFile };
  recorder.original = standIn;
  recorder.recordFile = file;
  try {
    return await run();
  } finally {
    recorder.original = saved.original;
    recorder.recordFile = saved.recordFile;
  }
}

/** Settles with the error the attempt ends in; a connection is itself an error here. */
function attempt(host: string, port: number): Promise<NodeJS.ErrnoException> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    socket.on("error", resolve);
    socket.once("connect", () => {
      socket.destroy();
      resolve(new Error("unexpectedly connected"));
    });
  });
}

/** An outside attempt whose refusal the caller swallows; the original must not be reached. */
async function swallowedAttempt(): Promise<{ message: string; calls: number }> {
  const dir = mkdtempSync(join(tmpdir(), "outside-connect-pin-"));
  let calls = 0;
  try {
    const err = await withStandIn(
      function original() {
        calls++;
        throw new Error("the original connect was called");
      },
      join(dir, "record.jsonl"),
      () => attempt(OUTSIDE, 8443),
    );
    return { message: err.message, calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// What the setup's afterEach says about when the attempt happened.
const AFTER_EACH = "in this test \\(or while the file loaded, or in a hook before it\\)";
const GUARD_FAILURE = new RegExp(
  `^test guard: 1 connection attempt\\(s\\) to another machine refused ${AFTER_EACH}: ` +
    `192\\.0\\.2\\.10 port 8443 from ${THIS_FILE.replace(/\./g, "\\.")}\\. Rule: a test may connect only to this machine`,
);

describe(SUITE, () => {
  it("the setup installed the guard in this process, writing to the fixed file in TMPDIR", () => {
    const recorder = installed();
    const marked = net.Socket.prototype.connect as unknown as Record<symbol, unknown>;
    expect(marked[Symbol.for("test.outsideConnectRecorder")]).toBe(recorder);
    expect(recorder.recordFile).toBe(join(tmpdir(), "mc-test-outside-connections.jsonl"));
  });

  it("installing again wraps nothing more", () => {
    const recorder = installed();
    const wrapped = net.Socket.prototype.connect;
    expect(recordOutsideConnections(() => ({}))).toBe(recorder);
    expect(net.Socket.prototype.connect).toBe(wrapped);
  });

  it("an attempt to a loopback address reaches the original, which here never dials, and is not recorded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "outside-connect-pin-"));
    try {
      const recorder = installed();
      const calls: unknown[][] = [];
      const err = await withStandIn(
        function notDialled(this: net.Socket, ...args: never[]) {
          calls.push(args);
          (this as { connecting: boolean }).connecting = true;
          process.nextTick(() => this.destroy(new Error("stand-in: not dialled")));
          return this;
        },
        join(dir, "record.jsonl"),
        () => attempt("127.0.0.1", 8443),
      );
      expect(calls).toHaveLength(1);
      expect(err.message).toBe("stand-in: not dialled");
      expect(recorder.hits).toEqual([]);
      expect(() => readFileSync(join(dir, "record.jsonl"))).toThrow(/ENOENT/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it(REFUSED_CASE, async () => {
    const dir = mkdtempSync(join(tmpdir(), "outside-connect-pin-"));
    try {
      const recorder = installed();
      expect(recorder.hits).toEqual([]);
      let calls = 0;
      const err = await withStandIn(
        function original() {
          calls++;
          throw new Error("the original connect was called");
        },
        join(dir, "record.jsonl"),
        () => attempt(OUTSIDE, 8443),
      );
      expect(calls).toBe(0);
      expect(err.message).toMatch(
        /^test guard: connection to 192\.0\.2\.10 port 8443 refused; a test may connect only to this machine .*stand-in.*127\.0\.0\.1/,
      );
      const expected = { file: THIS_FILE, test: `${SUITE} > ${REFUSED_CASE}`, host: OUTSIDE, port: 8443 };
      expect(recorder.hits).toEqual([expected]);
      expect(readFileSync(join(dir, "record.jsonl"), "utf8")).toBe(`${JSON.stringify(expected)}\n`);
      // This case wants the refusal, so it empties the record itself.
      recorder.hits.splice(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The two cases below pin the setup's afterEach by its effect. `it.fails`
  // passes only when its test fails, the flip comes after the afterEach hooks,
  // and the onTestFailed handler sees the failures before the flip: so the
  // pair passes only if the guard alone failed the first test and the record
  // was empty again for the second.
  describe("a refusal the test swallows", () => {
    const seen: { failures?: string[]; refusal?: { message: string; calls: number } } = {};
    it.fails("fails the test that made it", async () => {
      onTestFailed(({ task }) => {
        seen.failures = (task.result?.errors ?? []).map((e) => e.message);
      });
      seen.refusal = await swallowedAttempt();
    });
    it("…through the setup's afterEach alone, naming host, port and test file, and the next test starts with an empty record", () => {
      expect(seen.refusal).toEqual({ message: expect.stringMatching(/^test guard: connection to 192\.0\.2\.10 port 8443 refused;/), calls: 0 });
      expect(seen.failures).toEqual([expect.stringMatching(GUARD_FAILURE)]);
      expect(installed().hits).toEqual([]);
    });
  });

  describe("a refusal swallowed in a beforeAll", () => {
    const seen: { failures?: string[]; refusal?: { message: string; calls: number } } = {};
    beforeAll(async () => {
      seen.refusal = await swallowedAttempt();
    });
    it.fails("fails the first test after it", () => {
      onTestFailed(({ task }) => {
        seen.failures = (task.result?.errors ?? []).map((e) => e.message);
      });
    });
    it("…through the setup's afterEach, and the record is empty again for the next test", () => {
      expect(seen.refusal?.calls).toBe(0);
      expect(seen.failures).toEqual([expect.stringMatching(GUARD_FAILURE)]);
      expect(installed().hits).toEqual([]);
    });
  });

  // A file-level failure cannot be pinned by its effect without failing this
  // file, so the setup's text is read for the afterAll that catches an attempt
  // made after the last test.
  it("the setup also fails the file for an attempt made after its last test", () => {
    const setup = readFileSync(new URL("../../vitest.setup-env.ts", import.meta.url), "utf8");
    expect(setup).toMatch(
      /\nafterAll\(\(\) => \{\n {2}const failure = takeRefusedConnections\(connectGuard\.hits, "after the last test"\);\n {2}if \(failure\) throw new Error\(failure\);\n\}\);\n/,
    );
  });
});
