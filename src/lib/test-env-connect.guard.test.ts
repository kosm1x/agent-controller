import { describe, expect, it } from "vitest";
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  recordOutsideConnections,
  type ConnectRecorder,
} from "../test-utils/outside-connect-record.js";

// Rule: every test process records each attempt to connect to a host other
// than this machine, and refuses none. The per-worker setup file
// (vitest.setup-env.ts) wraps net.Socket.prototype.connect once; each outside
// attempt adds one line (test file, test name, host, port) to
// mc-test-outside-connections.jsonl in the folder TMPDIR names, then proceeds
// unchanged. Nothing here dials anything but a closed loopback port: the
// outside case hands its attempt to a stand-in for the original connect.
const SUITE = "outside-connection record";
const RECORDED_CASE = "an attempt to an outside host is recorded with exactly file, test, host and port";

function installed(): ConnectRecorder {
  const recorder = (globalThis as typeof globalThis & { __outsideConnectRecorder?: ConnectRecorder })
    .__outsideConnectRecorder;
  if (!recorder) throw new Error("the test setup did not install the connection recorder");
  return recorder;
}

/** Runs `run` with the recorder's original and record file replaced, restoring both on every exit. */
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
    socket.once("error", resolve);
    socket.once("connect", () => {
      socket.destroy();
      resolve(new Error("unexpectedly connected"));
    });
  });
}

describe(SUITE, () => {
  it("the setup installed the recorder in this process, writing to the fixed file in TMPDIR", () => {
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

  it("an attempt to a closed loopback port reaches the original, is refused as before and is not recorded", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as net.AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const dir = mkdtempSync(join(tmpdir(), "outside-connect-pin-"));
    try {
      const recorder = installed();
      const real = recorder.original;
      const before = recorder.hits.length;
      let calls = 0;
      const err = await withStandIn(
        function passThrough(this: net.Socket, ...args: never[]) {
          calls++;
          return Reflect.apply(real, this, args);
        },
        join(dir, "record.jsonl"),
        () => attempt("127.0.0.1", port),
      );
      expect(calls).toBe(1);
      expect(err.code).toBe("ECONNREFUSED");
      expect(recorder.hits.length).toBe(before);
      expect(() => readFileSync(join(dir, "record.jsonl"))).toThrow(/ENOENT/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it(RECORDED_CASE, async () => {
    const dir = mkdtempSync(join(tmpdir(), "outside-connect-pin-"));
    try {
      const recorder = installed();
      const before = recorder.hits.length;
      const calls: unknown[][] = [];
      const err = await withStandIn(
        function notDialled(this: net.Socket, ...args: never[]) {
          calls.push(args);
          setImmediate(() => this.destroy(new Error("stand-in: not dialled")));
          return this;
        },
        join(dir, "record.jsonl"),
        () => attempt("192.0.2.10", 8443),
      );
      expect(calls).toHaveLength(1);
      expect(err.message).toBe("stand-in: not dialled");
      const expected = {
        file: `src/lib/${basename(fileURLToPath(import.meta.url))}`,
        test: `${SUITE} > ${RECORDED_CASE}`,
        host: "192.0.2.10",
        port: 8443,
      };
      expect(recorder.hits.slice(before)).toEqual([expected]);
      expect(readFileSync(join(dir, "record.jsonl"), "utf8")).toBe(`${JSON.stringify(expected)}\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
