/**
 * Test helper, not a test file: records every attempt a test process makes to
 * open a connection to a host other than this machine, then hands the attempt
 * on unchanged (same receiver, same arguments, same return value, same error).
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
 * One JSON line per attempt is appended to the recorder's `recordFile`: the
 * test file relative to the repository root, the current test's name, the host
 * and the port, and nothing else (no request path, header or body). One short
 * append per attempt keeps lines whole when many test processes write at once.
 * The record sits under a fixed name in a shared temporary folder, so it is
 * opened without following a link, without blocking on a planted pipe, and
 * created readable and writable by its owner only.
 * Recording never throws into the caller: a failure to read the arguments or
 * to append is ignored.
 *
 * Imports only Node built-ins and does no work on import.
 */
import { closeSync, constants, openSync, writeSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** File name of the record, in the folder `os.tmpdir()` names when a test process starts. */
export const OUTSIDE_CONNECTIONS_FILE = "mc-test-outside-connections.jsonl";

/** One recorded attempt; also the exact shape of one line of the record file. */
export interface OutsideConnection {
  file: string | null;
  test: string | null;
  host: string;
  port: number | null;
}

// Accepts any of Node's connect overloads; calls go through Reflect.apply unchanged.
type Connect = (...args: never[]) => unknown;

export interface ConnectRecorder {
  /** Every call is handed to this function unchanged; a test may swap in a stand-in for one case. */
  original: Connect;
  /** Each line is appended here; a test may point it at a throwaway file for one case. */
  recordFile: string;
  /** The attempts recorded in this process. */
  hits: OutsideConnection[];
}

export interface RecorderOptions {
  recordFile: string;
  /** Recorded test file paths are relative to this folder. */
  rootDir: string;
  /** The running test's file (absolute) and name, when known. */
  currentTest: () => { path?: string; name?: string };
}

const RECORD_FLAGS =
  constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK;

// Shared by every copy of this module in a process, so a second install finds the first.
const RECORDER = Symbol.for("test.outsideConnectRecorder");

/**
 * Wraps `target.connect` so every attempt to a host other than this machine is
 * recorded. Installing on a target that is already wrapped wraps nothing and
 * returns the recorder already in place.
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
    record(recorder, options, args);
    return Reflect.apply(recorder.original, this, args);
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

function record(recorder: ConnectRecorder, options: RecorderOptions, args: unknown[]): void {
  try {
    const target = connectTarget(args);
    if (target === null || isThisMachine(target.host)) return;
    const test = options.currentTest();
    const hit: OutsideConnection = {
      file: test.path ? relative(options.rootDir, test.path) : null,
      test: test.name ?? null,
      host: target.host,
      port: target.port,
    };
    recorder.hits.push(hit);
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

const THIS_MACHINE = new Set(["localhost", "::1", "0:0:0:0:0:0:0:1", "0.0.0.0", "::"]);

/**
 * Loopback names and addresses, plus the unspecified addresses, which a
 * connection on this system also reaches the machine itself through.
 */
function isThisMachine(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "");
  return THIS_MACHINE.has(h) || /^(::ffff:)?127(\.\d{1,3}){3}$/.test(h);
}
