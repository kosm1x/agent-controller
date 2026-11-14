import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import * as tls from "node:tls";
import { fileURLToPath } from "node:url";
import {
  installConnectRecorder,
  type ConnectRecorder,
  type RecorderOptions,
} from "./outside-connect-record.js";

// Rule: every attempt a test process makes to connect to a host other than
// this machine is recorded with the test file, the test name, the host and
// the port, and then proceeds exactly as before. Nothing in this file opens a
// connection to anything but a closed loopback port: an outside name is only
// ever handed to a stand-in for the original connect, which never resolves or
// dials it. The names are reserved (`.invalid`, the documentation ranges), so
// even a mistake could not reach a real host.
const OUTSIDE = "outside-host.invalid";
const DOC_ADDRESS = "192.0.2.10";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "outside-connect-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const recordFile = () => join(dir, "record.jsonl");
const lines = () =>
  existsSync(recordFile()) ? readFileSync(recordFile(), "utf8").split("\n").filter(Boolean) : [];

/** A target whose connect is a stand-in that logs each call and returns a fixed value. */
function fakeTarget(behave?: () => unknown) {
  const calls: { self: unknown; args: unknown[] }[] = [];
  const result = { from: "stand-in" };
  const target = {
    connect(this: unknown, ...args: unknown[]): unknown {
      calls.push({ self: this, args });
      return behave ? behave() : result;
    },
  };
  return { target, calls, result };
}

function install(
  target: { connect: (...args: never[]) => unknown },
  currentTest: RecorderOptions["currentTest"] = () => ({
    path: "/repo/src/area/sample.test.ts",
    name: "suite > case",
  }),
  file = recordFile(),
) {
  return installConnectRecorder(target, { recordFile: file, rootDir: "/repo", currentTest });
}

describe("the connection recorder on a stand-in target", () => {
  it("records an outside attempt with exactly file, test, host and port, and hands the call on unchanged", () => {
    const { target, calls, result } = fakeTarget();
    const recorder = install(target);
    const self = {};
    const opts = { host: OUTSIDE, port: 443 };
    const cb = () => {};
    expect(target.connect.call(self, opts, cb)).toBe(result);
    expect(calls).toHaveLength(1);
    expect(calls[0].self).toBe(self);
    expect(calls[0].args).toHaveLength(2);
    expect(calls[0].args[0]).toBe(opts);
    expect(calls[0].args[1]).toBe(cb);
    const expected = { file: "src/area/sample.test.ts", test: "suite > case", host: OUTSIDE, port: 443 };
    expect(recorder.hits).toEqual([expected]);
    expect(lines()).toEqual([JSON.stringify(expected)]);
  });

  it.each<[string, unknown[], string, number | null]>([
    ["options with a port string", [{ host: OUTSIDE, port: "8443" }], OUTSIDE, 8443],
    ["a port and a host", [8443, DOC_ADDRESS], DOC_ADDRESS, 8443],
    ["a port string, a host and a callback", ["8443", OUTSIDE, () => {}], OUTSIDE, 8443],
    ["the list net.connect has normalised", [[{ host: OUTSIDE, port: 25 }, null]], OUTSIDE, 25],
    ["an IPv6 documentation address", [{ host: "2001:db8::1", port: 443 }], "2001:db8::1", 443],
    ["a name that only starts like a loopback address", [{ host: `127.0.0.1.${OUTSIDE}`, port: 80 }], `127.0.0.1.${OUTSIDE}`, 80],
    ["options without a port", [{ host: OUTSIDE }], OUTSIDE, null],
  ])("reads %s the way Node does and records it", (_, args, host, port) => {
    const { target, calls } = fakeTarget();
    const recorder = install(target);
    target.connect(...args);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(args);
    expect(recorder.hits).toEqual([{ file: "src/area/sample.test.ts", test: "suite > case", host, port }]);
    expect(lines()).toHaveLength(1);
  });

  it.each<[string, unknown[]]>([
    ["127.0.0.1", [{ host: "127.0.0.1", port: 1 }]],
    ["another address in 127.0.0.0/8", [{ host: "127.8.9.10", port: 1 }]],
    ["::1", [{ host: "::1", port: 1 }]],
    ["::1 in brackets", [{ host: "[::1]", port: 1 }]],
    ["an IPv4-mapped loopback address", [{ host: "::ffff:127.0.0.1", port: 1 }]],
    ["localhost in capitals", [{ host: "LOCALHOST", port: 1 }]],
    ["localhost with a trailing dot", [{ host: "localhost.", port: 1 }]],
    ["the unspecified IPv4 address", [{ host: "0.0.0.0", port: 1 }]],
    ["the unspecified IPv6 address", [{ host: "::", port: 1 }]],
    ["options without a host (Node uses localhost)", [{ port: 1 }]],
    ["an empty host (Node uses localhost)", [{ host: "", port: 1 }]],
    ["a bare port", [1]],
    ["a port and a loopback host", [1, "127.0.0.1"]],
    ["a socket path in options", [{ path: "/run/sample.sock" }]],
    ["a socket path string", ["/run/sample.sock"]],
    ["a normalised socket path", [[{ path: "/run/sample.sock" }, null]]],
    // Node ignores the host and port when a socket path is given, so these
    // would be recorded if the path were not checked first.
    ["a socket path in options that also name an outside host", [{ path: "/run/sample.sock", host: OUTSIDE, port: 443 }]],
    ["a socket path string followed by an outside host", ["/run/sample.sock", OUTSIDE]],
  ])("does not record %s, and still hands the call on", (_, args) => {
    const { target, calls } = fakeTarget();
    const recorder = install(target);
    target.connect(...args);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(args);
    expect(recorder.hits).toEqual([]);
    expect(lines()).toEqual([]);
  });

  it("passes the original's error through unchanged, after recording the attempt", () => {
    const failure = new Error("original refused");
    const { target, calls } = fakeTarget(() => {
      throw failure;
    });
    const recorder = install(target);
    let caught: unknown;
    try {
      target.connect({ host: OUTSIDE, port: 443 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(failure);
    expect(calls).toHaveLength(1);
    expect(recorder.hits).toHaveLength(1);
  });

  it("never throws into the caller when the record cannot be written or the test is unknown", () => {
    const unwritable = fakeTarget();
    const kept = install(unwritable.target, undefined, join(dir, "missing-folder", "record.jsonl"));
    expect(unwritable.target.connect({ host: OUTSIDE, port: 443 })).toBe(unwritable.result);
    expect(unwritable.calls).toHaveLength(1);
    expect(kept.hits).toHaveLength(1);

    const unknown = fakeTarget();
    const none = install(unknown.target, () => {
      throw new Error("no current test");
    });
    expect(unknown.target.connect({ host: OUTSIDE, port: 443 })).toBe(unknown.result);
    expect(unknown.calls).toHaveLength(1);
    expect(none.hits).toEqual([]);
  });

  it("records null for a test file and name that are not known", () => {
    const { target } = fakeTarget();
    const recorder = install(target, () => ({}));
    target.connect({ host: OUTSIDE, port: 443 });
    expect(recorder.hits).toEqual([{ file: null, test: null, host: OUTSIDE, port: 443 }]);
  });

  // The record has a fixed name in a shared temporary folder, so another
  // process could plant a link there. Both cases work only in the test's own
  // private folder.
  it("does not follow a link at the record path, and still keeps the hit", () => {
    const own = mkdtempSync(join(tmpdir(), "outside-connect-link-"));
    try {
      const other = join(own, "other-file");
      writeFileSync(other, "");
      const link = join(own, "record.jsonl");
      symlinkSync(other, link);
      const { target, calls, result } = fakeTarget();
      const recorder = install(target, undefined, link);
      expect(target.connect({ host: OUTSIDE, port: 443 })).toBe(result);
      expect(calls).toHaveLength(1);
      expect(recorder.hits).toHaveLength(1);
      expect(readFileSync(other, "utf8")).toBe("");
    } finally {
      rmSync(own, { recursive: true, force: true });
    }
  });

  it("creates the record readable and writable by its owner only", () => {
    const own = mkdtempSync(join(tmpdir(), "outside-connect-mode-"));
    try {
      const file = join(own, "record.jsonl");
      const { target } = fakeTarget();
      install(target, undefined, file);
      target.connect({ host: OUTSIDE, port: 443 });
      // The process umask can only clear permission bits, never add them, so
      // it cannot widen 0o600; any group or other bit here came from the mode
      // the helper asked for.
      expect(statSync(file).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(own, { recursive: true, force: true });
    }
  });

  it("wraps once when installed twice", () => {
    const { target, calls } = fakeTarget();
    const first = install(target);
    const wrapped = target.connect;
    expect(install(target)).toBe(first);
    expect(target.connect).toBe(wrapped);
    target.connect({ host: OUTSIDE, port: 443 });
    expect(calls).toHaveLength(1);
    expect(first.hits).toHaveLength(1);
    expect(lines()).toHaveLength(1);
  });
});

// Rule: the one wrapped method is the lowest point every client connection
// passes through, so the recorder the setup installed on net.Socket.prototype
// sees attempts from net, tls, http, https and the built-in fetch alike.

function installed(): ConnectRecorder {
  const recorder = (globalThis as typeof globalThis & { __outsideConnectRecorder?: ConnectRecorder })
    .__outsideConnectRecorder;
  if (!recorder) throw new Error("the test setup did not install the connection recorder");
  return recorder;
}

/** Runs `run` with the installed recorder's original and record file replaced, restoring both on every exit. */
async function withStandIn<T>(
  standIn: (this: net.Socket, ...args: never[]) => unknown,
  run: () => Promise<T>,
): Promise<T> {
  const recorder = installed();
  const { original, recordFile: file } = recorder;
  recorder.original = standIn;
  recorder.recordFile = recordFile();
  try {
    return await run();
  } finally {
    recorder.original = original;
    recorder.recordFile = file;
  }
}

/** A loopback port that was bound and closed again, so an attempt on it is refused. */
async function closedLoopbackPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Settles with the error the attempt ends in; a connection or a response is itself an error here. */
function socketError(socket: net.Socket, connected: string): Promise<unknown> {
  return new Promise((resolve) => {
    socket.once("error", resolve);
    socket.once(connected, () => {
      socket.destroy();
      resolve(new Error("unexpectedly connected"));
    });
  });
}
function requestError(req: http.ClientRequest): Promise<unknown> {
  return new Promise((resolve) => {
    req.once("error", resolve);
    req.once("response", (res) => {
      res.destroy();
      resolve(new Error("unexpected response"));
    });
    req.end();
  });
}

const ENTRY_POINTS: [string, (host: string, port: number) => Promise<unknown>][] = [
  ["net.connect", (host, port) => socketError(net.connect({ host, port }), "connect")],
  ["tls.connect", (host, port) => socketError(tls.connect({ host, port }), "secureConnect")],
  ["http.request", (host, port) => requestError(http.request({ host, port, agent: new http.Agent() }))],
  ["https.request", (host, port) => requestError(https.request({ host, port, agent: new https.Agent() }))],
  [
    "fetch",
    (host, port) =>
      fetch(`http://${host}:${port}/`).then(
        () => new Error("unexpected response"),
        (err: unknown) => err,
      ),
  ],
];

/** The error itself or, for fetch, the cause it wraps. */
function rootError(err: unknown): NodeJS.ErrnoException {
  const e = err as NodeJS.ErrnoException & { cause?: NodeJS.ErrnoException };
  return e.cause ?? e;
}

describe("the recorder the setup installed", () => {
  it.each(ENTRY_POINTS)(
    "%s to a closed loopback port reaches the original, fails as before and is not recorded",
    async (_, attempt) => {
      const port = await closedLoopbackPort();
      const recorder = installed();
      const real = recorder.original;
      const before = recorder.hits.length;
      let calls = 0;
      const err = await withStandIn(
        function passThrough(this: net.Socket, ...args: never[]) {
          calls++;
          return Reflect.apply(real, this, args);
        },
        () => attempt("127.0.0.1", port),
      );
      expect(calls).toBe(1);
      expect(rootError(err).code).toBe("ECONNREFUSED");
      expect(recorder.hits.length).toBe(before);
      expect(lines()).toEqual([]);
    },
  );

  it.each(ENTRY_POINTS)(
    "%s to an outside host is recorded and handed to the original, which here never dials",
    async (_, attempt) => {
      const recorder = installed();
      const before = recorder.hits.length;
      const calls: unknown[][] = [];
      const err = await withStandIn(
        function notDialled(this: net.Socket, ...args: never[]) {
          calls.push(args);
          setImmediate(() => this.destroy(new Error("stand-in: not dialled")));
          return this;
        },
        () => attempt(OUTSIDE, 8443),
      );
      expect(calls).toHaveLength(1);
      // The attempt ends in the stand-in's error; http has already written the
      // request into the socket by then and reports the closed socket instead.
      expect(rootError(err).message).toMatch(/^(stand-in: not dialled|Socket is closed)$/);
      const expected = {
        file: relative(ROOT, fileURLToPath(import.meta.url)),
        test: expect.getState().currentTestName,
        host: OUTSIDE,
        port: 8443,
      };
      expect(expected.test).toContain("is recorded and handed to the original");
      expect(recorder.hits.slice(before)).toEqual([expected]);
      expect(lines()).toEqual([JSON.stringify(expected)]);
    },
  );
});
