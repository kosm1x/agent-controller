/**
 * Test helper, not a test file: refuses every attempt a test process makes to
 * open a connection to a host other than this machine, and records it.
 *
 * Every client connection Node opens from JavaScript ends in
 * `net.Socket.prototype.connect`: `net.connect` / `net.createConnection`,
 * `tls.connect` (a TLS socket is a `net.Socket` and connects through the same
 * method), the `http` and `https` agents (through those two), and the built-in
 * `fetch` (its bundled client calls `net.connect` / `tls.connect`); `http2.connect`
 * also calls one of those two unless the caller supplies its own
 * `createConnection`. The method runs before the host name is looked up, so
 * wrapping it sees every attempt without resolving anything itself. It does not
 * see name lookups that open no connection, datagram sockets, a socket built
 * from an existing descriptor or handle (already connected, it never calls
 * connect), connections opened in worker threads or child processes, or native
 * code that opens its own sockets.
 *
 * This machine is: a loopback or unspecified address in any form Node or the
 * system resolver reads as one (`127.1`, `0::1`, `::ffff:7f00:1`, brackets, a
 * zone), `localhost` and any name under `.localhost`, the two conventional
 * loopback aliases `ip6-localhost` and `ip6-loopback`, and a local socket path.
 * Nothing else is, not even the machine's own interface addresses: a test has
 * no reason to use them.
 *
 * Limits of that rule. The guard judges the host handed to the socket, never
 * the address it resolves to: a caller-supplied lookup function decides the
 * address, so a local-looking name with its own lookup is dialled wherever
 * that lookup points. `localhost`, the two aliases and names under
 * `.localhost` are this machine only through the host's name configuration.
 * A numeric loopback form with a trailing dot or in brackets counts as this
 * machine, although the operating system would hand it to a name lookup
 * rather than dial it. The record is per process, not per test: with
 * concurrent tests in one file a refused attempt fails whichever test's check
 * runs next.
 *
 * A refused attempt never reaches the original method, so no handle, lookup or
 * connection is started. The socket is left as a pending lookup leaves it
 * (`connecting`, writes held back) and destroyed with the refusal on the next
 * tick, the way Node reports its own connect-stage errors: the caller sees an
 * ordinary connection error on the socket's `error` event, and code that keeps
 * setting the socket up after connect returns (tls.connect sets the server
 * name on its handle) still can. A synchronous destroy would make that code
 * throw.
 *
 * A caller may swallow the error, so each refused attempt is also kept in the
 * recorder's `hits` and appended as one JSON line to its `recordFile`: the
 * test file relative to the repository root, the current test's name, the host
 * and the port, and nothing else (no request path, header or body). The test
 * setup fails the test that made it (`takeRefusedConnections`). One short
 * append per attempt keeps lines whole when many test processes write at once.
 * The record sits under a fixed name in a shared temporary folder, so it is
 * opened without following a link and without blocking on a planted pipe, and
 * a NEW record is created readable and writable by its owner only (an existing
 * one keeps the mode it has). Recording never throws into the caller: a
 * failure to name the test or to append is ignored.
 *
 * Imports only Node built-ins and does no work on import.
 */
import { closeSync, constants, openSync, writeSync } from "node:fs";
import { BlockList, isIPv6, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** File name of the record, in the folder `os.tmpdir()` names when a test process starts. */
export const OUTSIDE_CONNECTIONS_FILE = "mc-test-outside-connections.jsonl";

/** One refused attempt; also the exact shape of one line of the record file. */
export interface OutsideConnection {
  file: string | null;
  test: string | null;
  host: string;
  port: number | null;
}

// Accepts any of Node's connect overloads; calls go through Reflect.apply unchanged.
type Connect = (...args: never[]) => unknown;

export interface ConnectRecorder {
  /** Calls to this machine are handed to this function unchanged; a test may swap in a stand-in for one case. */
  original: Connect;
  /** Each line is appended here; a test may point it at a throwaway file for one case. */
  recordFile: string;
  /** The attempts refused in this process and not yet taken by `takeRefusedConnections`. */
  hits: OutsideConnection[];
}

export interface RecorderOptions {
  recordFile: string;
  /** Recorded test file paths are relative to this folder. */
  rootDir: string;
  /** The running test's file (absolute) and name, when known. */
  currentTest: () => { path?: string; name?: string };
}

const RULE =
  "a test may connect only to this machine (a loopback address, localhost or a name under .localhost, " +
  "a local socket path): hand the code a stand-in for the connection, or a listener on 127.0.0.1";

const RECORD_FLAGS =
  constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK;

// Shared by every copy of this module in a process, so a second install finds the first.
const RECORDER = Symbol.for("test.outsideConnectRecorder");

/**
 * Wraps `target.connect` so every attempt to a host other than this machine is
 * refused and recorded, and every other call is handed on unchanged. Installing
 * on a target that is already wrapped wraps nothing and returns the recorder
 * already in place.
 */
export function installConnectRecorder(
  target: { connect: Connect },
  options: RecorderOptions,
): ConnectRecorder {
  const existing = (target.connect as { [RECORDER]?: ConnectRecorder })[RECORDER];
  if (existing) return existing;
  const recorder: ConnectRecorder = {
    original: target.connect,
    recordFile: options.recordFile,
    hits: [],
  };
  const connect = function connect(this: unknown, ...args: unknown[]): unknown {
    const outside = outsideTarget(args);
    if (outside === null) return Reflect.apply(recorder.original, this, args);
    record(recorder, options, outside);
    const socket = this as { connecting: boolean; destroy(error: Error): unknown };
    socket.connecting = true;
    process.nextTick(() =>
      socket.destroy(new Error(`test guard: connection to ${hostPort(outside)} refused; ${RULE}`)),
    );
    return socket;
  };
  Object.defineProperty(connect, RECORDER, { value: recorder });
  target.connect = connect;
  return recorder;
}

/**
 * Installs the recorder on `net.Socket.prototype` for this process: the record
 * file sits in the folder `os.tmpdir()` names now, test files are recorded
 * relative to the repository root, and the recorder is kept on `globalThis`
 * as `__outsideConnectRecorder` (the marker that it is installed).
 */
export function recordOutsideConnections(
  currentTest: RecorderOptions["currentTest"],
): ConnectRecorder {
  const recorder = installConnectRecorder(Socket.prototype, {
    recordFile: join(tmpdir(), OUTSIDE_CONNECTIONS_FILE),
    rootDir: fileURLToPath(new URL("../..", import.meta.url)),
    currentTest,
  });
  (globalThis as typeof globalThis & { __outsideConnectRecorder?: ConnectRecorder })
    .__outsideConnectRecorder = recorder;
  return recorder;
}

/**
 * Empties `hits` and returns the failure message for the attempts it held
 * (host, port and test file of each), or null when it held none. The setup
 * calls it after every test and after the last one, so a refusal the caller
 * swallowed still fails a test, and a refusal in one test never fails the next.
 */
export function takeRefusedConnections(hits: OutsideConnection[], when: string): string | null {
  const refused = hits.splice(0);
  if (refused.length === 0) return null;
  const list = refused.map((h) => `${hostPort(h)} from ${h.file ?? "an unknown test file"}`);
  return `test guard: ${refused.length} connection attempt(s) to another machine refused ${when}: ${list.join("; ")}. Rule: ${RULE}`;
}

function hostPort(target: { host: string; port: number | null }): string {
  return `${target.host} port ${target.port ?? "(none)"}`;
}

function outsideTarget(args: unknown[]): { host: string; port: number | null } | null {
  try {
    const target = connectTarget(args);
    return target === null || isThisMachine(target.host) ? null : target;
  } catch {
    // Arguments Node cannot read either: the original reports them.
    return null;
  }
}

function record(
  recorder: ConnectRecorder,
  options: RecorderOptions,
  target: { host: string; port: number | null },
): void {
  let test: { path?: string; name?: string } = {};
  try {
    test = options.currentTest();
  } catch {
    // An unknown test is recorded as null; the attempt is still kept.
  }
  const hit: OutsideConnection = {
    file: test.path ? relative(options.rootDir, test.path) : null,
    test: test.name ?? null,
    host: target.host,
    port: target.port,
  };
  recorder.hits.push(hit);
  try {
    const fd = openSync(recorder.recordFile, RECORD_FLAGS, 0o600);
    try {
      writeSync(fd, `${JSON.stringify(hit)}\n`);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Recording must never change what the caller sees.
  }
}

/**
 * Host and port of a connect call, read the way Node reads the arguments: an
 * options object, a pipe path string, a port with an optional host, or the
 * argument list `net.connect` has already normalised (an array). A missing or
 * empty host is `localhost`, as in Node. A local socket path gives null.
 */
function connectTarget(args: unknown[]): { host: string; port: number | null } | null {
  let first = args[0];
  if (Array.isArray(first)) first = first[0];
  let host: unknown;
  let port: unknown;
  if (first !== null && typeof first === "object") {
    const opts = first as { path?: unknown; host?: unknown; port?: unknown };
    if (opts.path) return null;
    host = opts.host;
    port = opts.port;
  } else if (typeof first === "string" && !(Number(first) >= 0)) {
    return null;
  } else {
    port = first;
    if (typeof args[1] === "string") host = args[1];
  }
  const n = Number(port);
  return { host: host ? String(host) : "localhost", port: Number.isFinite(n) ? n : null };
}

const LOCAL_NAMES = new Set(["localhost", "ip6-localhost", "ip6-loopback"]);

/** Built on first use, so importing the module does no work. */
let loopback: BlockList | undefined;

/**
 * Loopback names and addresses, plus the unspecified addresses, which a
 * connection on this system also reaches the machine itself through. An
 * address is judged by Node's own parser (`BlockList`, whose IPv4 rules also
 * match IPv4-mapped IPv6 addresses); the short IPv4 forms the system resolver
 * accepts are first written out as four parts.
 */
function isThisMachine(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "");
  if (LOCAL_NAMES.has(h) || h.endsWith(".localhost")) return true;
  if (!loopback) {
    loopback = new BlockList();
    loopback.addSubnet("127.0.0.0", 8, "ipv4");
    loopback.addAddress("0.0.0.0", "ipv4");
    loopback.addAddress("::1", "ipv6");
    loopback.addAddress("::", "ipv6");
  }
  const v6 = h.replace(/%.*$/, "");
  if (isIPv6(v6)) return loopback.check(v6, "ipv6");
  const v4 = fourParts(h);
  return v4 !== null && loopback.check(v4, "ipv4");
}

/**
 * The dotted quad an IPv4 literal in the classic resolver forms stands for:
 * one to four parts, each decimal, octal (leading 0) or hex (0x), the last part
 * filling the bytes the others leave (`127.1` is 127.0.0.1). Null for anything
 * else, which is then a name.
 */
function fourParts(h: string): string | null {
  const parts = h.split(".");
  if (parts.length > 4) return null;
  const values: number[] = [];
  for (const part of parts) {
    if (!/^(0x[0-9a-f]+|0[0-7]*|[1-9][0-9]*)$/.test(part)) return null;
    values.push(part.startsWith("0x") ? parseInt(part.slice(2), 16) : part.startsWith("0") ? parseInt(part, 8) : Number(part));
  }
  const last = values.pop()!;
  if (values.some((v) => v > 255) || last >= 256 ** (4 - values.length)) return null;
  const n = values.reduce((acc, v) => acc * 256 + v, 0) * 256 ** (4 - values.length) + last;
  return [3, 2, 1, 0].map((i) => Math.floor(n / 256 ** i) % 256).join(".");
}
