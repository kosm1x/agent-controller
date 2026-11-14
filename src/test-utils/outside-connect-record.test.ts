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
import { join } from "node:path";
import * as tls from "node:tls";
import {
  installConnectRecorder,
  takeRefusedConnections,
  type ConnectRecorder,
  type OutsideConnection,
  type RecorderOptions,
} from "./outside-connect-record.js";

// Rule: a test process connects only to this machine. Every attempt to
// another host is refused before anything is resolved or dialled, reaches the
// caller as an ordinary connection error, and is recorded with the test file,
// the test name, the host and the port; every other call is handed on
// unchanged. Nothing in this file opens a connection to anything: calls that
// reach the original connect reach a stand-in that never dials. The names are
// reserved (`.invalid`, the documentation ranges), so even a mistake could not
// reach a real host.
const OUTSIDE = "outside-host.invalid";
const DOC_ADDRESS = "192.0.2.10";
const REFUSED = /^test guard: connection to (\S+) port (\S+) refused; a test may connect only to this machine .*stand-in.*127\.0\.0\.1/;
const SAMPLE = { file: "src/area/sample.test.ts", test: "suite > case" };

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
const nextTick = () => new Promise<void>((resolve) => process.nextTick(resolve));

/**
 * A target whose connect is a stand-in that logs each call and returns a fixed
 * value. The target is also the receiver of its own calls, so it carries what
 * a refusal touches on a socket: `connecting` and `destroy`.
 */
function fakeTarget(behave?: () => unknown) {
  const calls: { self: unknown; args: unknown[] }[] = [];
  const result = { from: "stand-in" };
  const target = {
    connecting: false,
    destroyed: [] as unknown[],
    destroy(error?: unknown) {
      target.destroyed.push(error);
    },
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

describe("the connection guard on a stand-in target", () => {
  it("refuses an outside attempt without calling the original: destroys the receiver with the refusal on the next tick and records exactly file, test, host and port", async () => {
    const { target, calls } = fakeTarget();
    const recorder = install(target);
    expect(target.connect({ host: OUTSIDE, port: 443 }, () => {})).toBe(target);
    expect(calls).toEqual([]);
    // Held as a pending lookup holds it, then destroyed on the next tick, so
    // code that finishes setting the socket up after connect returns still can.
    expect(target.connecting).toBe(true);
    expect(target.destroyed).toEqual([]);
    await nextTick();
    expect(target.destroyed).toHaveLength(1);
    const error = target.destroyed[0] as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(REFUSED);
    expect(error.message).toContain(`connection to ${OUTSIDE} port 443 refused`);
    const expected = { ...SAMPLE, host: OUTSIDE, port: 443 };
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
  ])("reads %s the way Node does, refuses it and records it", async (_, args, host, port) => {
    const { target, calls } = fakeTarget();
    const recorder = install(target);
    target.connect(...args);
    expect(calls).toEqual([]);
    expect(recorder.hits).toEqual([{ ...SAMPLE, host, port }]);
    expect(lines()).toHaveLength(1);
    await nextTick();
    expect(target.destroyed).toHaveLength(1);
    expect((target.destroyed[0] as Error).message).toContain(`connection to ${host} port ${port ?? "(none)"} refused`);
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
    // would be refused if the path were not checked first.
    ["a socket path in options that also name an outside host", [{ path: "/run/sample.sock", host: OUTSIDE, port: 443 }]],
    ["a socket path string followed by an outside host", ["/run/sample.sock", OUTSIDE]],
  ])("hands %s on unchanged and records nothing", async (_, args) => {
    const { target, calls, result } = fakeTarget();
    const recorder = install(target);
    expect(target.connect(...args)).toBe(result);
    expect(calls).toHaveLength(1);
    expect(calls[0].self).toBe(target);
    expect(calls[0].args).toEqual(args);
    expect(recorder.hits).toEqual([]);
    expect(lines()).toEqual([]);
    await nextTick();
    expect(target.destroyed).toEqual([]);
  });

  // Each form of this machine sits next to a neighbour that only looks like it:
  // the rule is decided by parsing the address (Node's own parser, plus the
  // short IPv4 forms the system resolver reads), not by matching strings.
  it.each<[string, string, string]>([
    ["a name under .localhost", "app.localhost", "localhost.example"],
    ["a deeper name under .localhost, with a trailing dot", "a.b.LOCALHOST.", "xlocalhost"],
    ["the loopback alias ip6-localhost", "ip6-localhost", "ip6-localhostx"],
    ["the loopback alias ip6-loopback", "IP6-LOOPBACK", "ip6-loopback.example"],
    ["IPv4 loopback written short", "127.1", "128.1"],
    ["IPv4 loopback as one number", "2130706433", "2147483649"],
    ["IPv4 loopback in hex and octal parts", "0x7f.0.0.01", "0x80.0.0.01"],
    ["IPv4 loopback with an octal first part", "0177.0.0.1", "0127.0.0.1"],
    ["the top of the IPv4 loopback range", "127.255.255.255", "126.255.255.255"],
    ["IPv6 loopback with a leading zero group", "0::1", "::2"],
    ["IPv6 loopback written out, in brackets", "[0:0:0:0:0:0:0:1]", "[0:0:0:0:0:0:0:2]"],
    ["IPv6 loopback with a zone", "::1%lo", "fe80::1%lo"],
    ["IPv4-mapped loopback in hex groups", "::ffff:7f00:1", "::ffff:8000:1"],
  ])("%s (%s) is this machine; its neighbour %s is not", async (_, local, neighbour) => {
    const near = fakeTarget();
    const nearRecorder = install(near.target);
    expect(near.target.connect({ host: local, port: 1 })).toBe(near.result);
    expect(near.calls).toHaveLength(1);
    expect(nearRecorder.hits).toEqual([]);

    const far = fakeTarget();
    const farRecorder = install(far.target);
    far.target.connect({ host: neighbour, port: 1 });
    expect(far.calls).toEqual([]);
    expect(farRecorder.hits).toEqual([{ ...SAMPLE, host: neighbour, port: 1 }]);
    await nextTick();
    expect(near.target.destroyed).toEqual([]);
    expect(far.target.destroyed).toHaveLength(1);
  });

  it("passes the original's error for a call to this machine through unchanged", () => {
    const failure = new Error("original refused");
    const { target, calls } = fakeTarget(() => {
      throw failure;
    });
    const recorder = install(target);
    let caught: unknown;
    try {
      target.connect({ host: "127.0.0.1", port: 1 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(failure);
    expect(calls).toHaveLength(1);
    expect(recorder.hits).toEqual([]);
  });

  it("still refuses and keeps the hit when the record cannot be written or the test is unknown", async () => {
    const unwritable = fakeTarget();
    const kept = install(unwritable.target, undefined, join(dir, "missing-folder", "record.jsonl"));
    expect(unwritable.target.connect({ host: OUTSIDE, port: 443 })).toBe(unwritable.target);
    expect(unwritable.calls).toEqual([]);
    expect(kept.hits).toEqual([{ ...SAMPLE, host: OUTSIDE, port: 443 }]);

    const unknown = fakeTarget();
    const none = install(unknown.target, () => {
      throw new Error("no current test");
    });
    expect(unknown.target.connect({ host: OUTSIDE, port: 443 })).toBe(unknown.target);
    expect(unknown.calls).toEqual([]);
    expect(none.hits).toEqual([{ file: null, test: null, host: OUTSIDE, port: 443 }]);
    await nextTick();
    expect(unwritable.target.destroyed).toHaveLength(1);
    expect(unknown.target.destroyed).toHaveLength(1);
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
      const { target, calls } = fakeTarget();
      const recorder = install(target, undefined, link);
      expect(target.connect({ host: OUTSIDE, port: 443 })).toBe(target);
      expect(calls).toEqual([]);
      expect(recorder.hits).toHaveLength(1);
      expect(readFileSync(other, "utf8")).toBe("");
    } finally {
      rmSync(own, { recursive: true, force: true });
    }
  });

  it("creates a new record readable and writable by its owner only", () => {
    const own = mkdtempSync(join(tmpdir(), "outside-connect-mode-"));
    // A restrictive file-mode mask would clear the group and other bits by
    // itself and hide a missing mode argument, so the mask is cleared for this
    // case: the 0o600 seen here can then only come from the mode the helper
    // asks for.
    const mask = process.umask(0);
    try {
      const file = join(own, "record.jsonl");
      const { target } = fakeTarget();
      install(target, undefined, file);
      target.connect({ host: OUTSIDE, port: 443 });
      expect(statSync(file).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(mask);
      rmSync(own, { recursive: true, force: true });
    }
  });

  it("wraps once when installed twice", () => {
    const { target } = fakeTarget();
    const first = install(target);
    const wrapped = target.connect;
    expect(install(target)).toBe(first);
    expect(target.connect).toBe(wrapped);
    target.connect({ host: OUTSIDE, port: 443 });
    expect(first.hits).toHaveLength(1);
    expect(lines()).toHaveLength(1);
  });
});

// Rule: the setup fails the test that made a refused attempt even when the
// caller swallowed the error, and only that test: the check empties the list
// it reads, so the next test starts clean.
describe("taking the refused attempts after a test", () => {
  it("returns a failure naming host, port and test file of each attempt, and empties the list", () => {
    const hits: OutsideConnection[] = [
      { file: "src/area/a.test.ts", test: "a > one", host: OUTSIDE, port: 443 },
      { file: null, test: null, host: DOC_ADDRESS, port: null },
    ];
    const failure = takeRefusedConnections(hits, "in this test");
    expect(failure).toMatch(/^test guard: 2 connection attempt\(s\) to another machine refused in this test: /);
    expect(failure).toContain(`${OUTSIDE} port 443 from src/area/a.test.ts; ${DOC_ADDRESS} port (none) from an unknown test file.`);
    expect(failure).toMatch(/Rule: a test may connect only to this machine .*stand-in.*127\.0\.0\.1/);
    expect(hits).toEqual([]);
    expect(takeRefusedConnections(hits, "in this test")).toBeNull();
  });

  it("returns null and leaves an empty list empty", () => {
    const hits: OutsideConnection[] = [];
    expect(takeRefusedConnections(hits, "after the last test")).toBeNull();
    expect(hits).toEqual([]);
  });
});

// Rule: the one wrapped method is the lowest point every client connection
// passes through, so a guard on net.Socket.prototype refuses attempts from
// net, tls, http, https and the built-in fetch alike, each as an ordinary
// error where that entry point reports a failed connection. Each case puts a
// fresh guard around a stand-in original on the real prototype and restores
// the prototype on every exit; the stand-in never dials.

/** Runs `run` with a guard around `standIn` installed on net.Socket.prototype. */
async function throughPrototype<T>(
  standIn: (this: net.Socket, ...args: never[]) => unknown,
  run: () => Promise<T>,
): Promise<{ value: T; recorder: ConnectRecorder }> {
  const holder = { connect: standIn as (...args: never[]) => unknown };
  const recorder = install(holder);
  const saved = net.Socket.prototype.connect;
  net.Socket.prototype.connect = holder.connect as unknown as typeof saved;
  try {
    return { value: await run(), recorder };
  } finally {
    net.Socket.prototype.connect = saved;
  }
}

/** Settles with the first error the attempt ends in; a connection is itself an error here. */
function socketError(socket: net.Socket, connected: string): Promise<unknown> {
  return new Promise((resolve) => {
    socket.on("error", resolve);
    socket.once(connected, () => {
      socket.destroy();
      resolve(new Error("unexpectedly connected"));
    });
  });
}
function requestError(req: http.ClientRequest): Promise<unknown> {
  return new Promise((resolve) => {
    req.on("error", resolve);
    req.once("response", (res) => {
      res.destroy();
      resolve(new Error("unexpected response"));
    });
    req.end();
  });
}

const ENTRY_POINTS: [string, (host: string, port: number) => Promise<unknown>][] = [
  ["net.connect with options", (host, port) => socketError(net.connect({ host, port }), "connect")],
  ["net.connect with a port and a host", (host, port) => socketError(net.connect(port, host), "connect")],
  ["tls.connect with a server name", (host, port) => socketError(tls.connect({ host, port, servername: "sni.example" }), "secureConnect")],
  ["tls.connect with a port and a host", (host, port) => socketError(tls.connect(port, host), "secureConnect")],
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
function rootError(err: unknown): Error {
  const e = err as Error & { cause?: Error };
  return e.cause ?? e;
}

describe("the guard on net.Socket.prototype, through every entry point", () => {
  it.each(ENTRY_POINTS)(
    "%s to an outside host is refused before the original runs, and the refusal reaches the caller",
    async (_, attempt) => {
      let calls = 0;
      const { value: err, recorder } = await throughPrototype(
        function original() {
          calls++;
          throw new Error("the original connect was called");
        },
        () => attempt(OUTSIDE, 8443),
      );
      expect(calls).toBe(0);
      expect(rootError(err).message).toMatch(REFUSED);
      expect(rootError(err).message).toContain(`connection to ${OUTSIDE} port 8443 refused`);
      const expected = { ...SAMPLE, host: OUTSIDE, port: 8443 };
      expect(recorder.hits).toEqual([expected]);
      expect(lines()).toEqual([JSON.stringify(expected)]);
    },
  );

  it.each(ENTRY_POINTS)(
    "%s to a loopback address reaches the original, which here never dials, and is not recorded",
    async (_, attempt) => {
      const calls: unknown[][] = [];
      const { value: err, recorder } = await throughPrototype(
        function notDialled(this: net.Socket, ...args: never[]) {
          calls.push(args);
          (this as { connecting: boolean }).connecting = true;
          process.nextTick(() => this.destroy(new Error("stand-in: not dialled")));
          return this;
        },
        () => attempt("127.0.0.1", 8443),
      );
      expect(calls).toHaveLength(1);
      expect(rootError(err).message).toBe("stand-in: not dialled");
      expect(recorder.hits).toEqual([]);
      expect(lines()).toEqual([]);
    },
  );
});
