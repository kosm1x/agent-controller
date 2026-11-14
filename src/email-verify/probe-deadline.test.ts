/**
 * The probe's deadlines and the addresses it connects through, driven by fake
 * timers against a stand-in socket handed in through `createConnection`: no
 * listener, no connection, no name lookup.
 * `node:net` and `node:dns` are replaced by versions that throw, so any path
 * that would reach a real socket or resolver fails the case instead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type * as net from "node:net";

vi.mock("node:net", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:net")>();
  const refuse = (): never => {
    throw new Error("a real connection was attempted");
  };
  return { ...actual, createConnection: refuse, connect: refuse, default: { ...actual, createConnection: refuse, connect: refuse } };
});
vi.mock("node:dns", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns")>();
  const refuse = (): never => {
    throw new Error("a real name lookup was attempted");
  };
  const promises = { ...actual.promises, lookup: refuse, resolveMx: refuse };
  return { ...actual, lookup: refuse, promises, default: { ...actual, lookup: refuse, promises } };
});

import { ProbeError, probeMailbox, type ProbeOptions } from "./smtp-client.js";
import { EmailVerifier, type VerifyResult } from "./verify.js";
import { DEFAULT_GOVERNANCE } from "./governance.js";

/** Records what the probe asks of its socket; never touches the network. */
class StandInSocket extends EventEmitter {
  readonly writes: string[] = [];
  readonly ends: string[] = [];
  destroys = 0;
  readonly remoteAddress = "192.0.2.10";
  setEncoding(): this {
    return this;
  }
  write(line: string): boolean {
    this.writes.push(line);
    return true;
  }
  end(line: string): this {
    this.ends.push(line);
    return this;
  }
  destroy(): this {
    this.destroys += 1;
    return this;
  }
}

/** A connector that hands out ONE stand-in socket; a second connection throws. */
function connector() {
  const opened: net.NetConnectOpts[] = [];
  const sockets: StandInSocket[] = [];
  const open = (options: net.NetConnectOpts): net.Socket => {
    if (sockets.length > 0) throw new Error("a second connection was opened");
    opened.push(options);
    const s = new StandInSocket();
    sockets.push(s);
    return s as unknown as net.Socket;
  };
  return { open, opened, sockets };
}

function track<T>(p: Promise<T>): { done: boolean; value?: T; error?: unknown } {
  const state: { done: boolean; value?: T; error?: unknown } = { done: false };
  p.then(
    (value) => Object.assign(state, { done: true, value }),
    (error: unknown) => Object.assign(state, { done: true, error }),
  );
  return state;
}

beforeEach(() => {
  vi.useFakeTimers({ now: Date.UTC(2030, 0, 1) });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("probeMailbox — the total budget clips every step", () => {
  // Replies arrive every 250 ms; a per-step deadline of 400 ms alone would let
  // the EHLO wait run to 250 + 400 = 650 ms. The 500 ms budget must end it at 500.
  it("a step that would outlast the budget ends at the budget edge, coded budget, and the socket gets one QUIT", async () => {
    const c = connector();
    const run = track(
      probeMailbox({
        host: "mx.example.test",
        port: 25,
        heloName: "probe.example.net",
        fromEmail: "postmaster@example.net",
        toEmail: "user1@example.com",
        domain: "example.com",
        skipCatchAll: false,
        timeoutMs: 400,
        totalBudgetMs: 500,
        addresses: [{ address: "192.0.2.10", family: 4 }],
        createConnection: c.open,
      }),
    );
    expect(c.opened).toHaveLength(1);
    expect(c.opened[0]).toMatchObject({ host: "mx.example.test", port: 25, autoSelectFamily: true });
    const sock = c.sockets[0]!;
    sock.emit("connect");
    await vi.advanceTimersByTimeAsync(250);
    sock.emit("data", "220 ready\r\n");
    await vi.advanceTimersByTimeAsync(0);
    expect(sock.writes).toEqual(["EHLO probe.example.net\r\n"]);

    await vi.advanceTimersByTimeAsync(249);
    expect(run.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(run.done).toBe(true);
    expect(run.error).toBeInstanceOf(ProbeError);
    expect(run.error).toMatchObject({ stage: "ehlo", code: "budget", message: "probe budget exhausted" });
    // Nothing more was sent after the budget ran out; the conversation closed with one QUIT.
    expect(sock.writes).toEqual(["EHLO probe.example.net\r\n"]);
    expect(sock.ends).toEqual(["QUIT\r\n"]);
    expect(sock.destroys).toBe(0);
  });

  // The connect wait is a step too: a connect limit (400) larger than the budget
  // left (100) must end at the budget edge with the budget code, not at its own limit.
  it("an unanswered connect ends at the remaining budget, coded budget at stage connect, the socket destroyed once", async () => {
    const c = connector();
    const run = track(
      probeMailbox({
        host: "mx.example.test",
        port: 25,
        heloName: "probe.example.net",
        fromEmail: "postmaster@example.net",
        toEmail: "user1@example.com",
        domain: "example.com",
        skipCatchAll: true,
        timeoutMs: 400,
        connectTimeoutMs: 400,
        totalBudgetMs: 100,
        addresses: [{ address: "192.0.2.10", family: 4 }],
        createConnection: c.open,
      }),
    );
    expect(c.opened).toHaveLength(1);
    const sock = c.sockets[0]!;
    await vi.advanceTimersByTimeAsync(99);
    expect(run.done).toBe(false);
    expect(sock.destroys).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(run.done).toBe(true);
    expect(run.error).toBeInstanceOf(ProbeError);
    expect(run.error).toMatchObject({ stage: "connect", code: "budget", message: "probe budget exhausted" });
    expect(sock.destroys).toBe(1);
    expect(sock.writes).toEqual([]);
    expect(sock.ends).toEqual([]);
  });
});

describe("EmailVerifier — a dead MX host costs the connect deadline, not the step deadline", () => {
  // A SYN nobody answers must be given up after connectTimeoutMs (150), not after
  // the 20 s per-step timeout nor the default min(timeoutMs, 5000).
  it("an unanswered connect is abandoned at connectTimeoutMs: one charged connection, destroyed once, reported unreachable", async () => {
    const c = connector();
    const seen: ProbeOptions[] = [];
    const v = new EmailVerifier({
      heloName: "probe.example.net",
      fromEmail: "postmaster@example.net",
      timeoutMs: 20_000,
      greylistRetryMs: 0,
      governance: { ...DEFAULT_GOVERNANCE, hostGapMs: 0 },
      sleep: async () => {},
      mxLookup: async () => [{ exchange: "mx.example.test", priority: 10 }],
      resolveTargets: async () => [{ address: "192.0.2.10", family: 4 }],
      probe: (o) => {
        seen.push(o);
        return probeMailbox({ ...o, connectTimeoutMs: 150, createConnection: c.open });
      },
    });
    const run = track<VerifyResult>(v.verify("user1@example.com"));
    await vi.advanceTimersByTimeAsync(149);
    expect(c.opened).toHaveLength(1);
    expect(c.opened[0]).toMatchObject({ host: "mx.example.test", port: 25 });
    expect(run.done).toBe(false);
    expect(c.sockets[0]!.destroys).toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(run.done).toBe(true);
    expect(run.error).toBeUndefined();
    expect(run.value?.verdict).toBe("unknown");
    expect(run.value?.reason).toBe("smtp_unreachable: connect: connect timeout after 150ms");
    expect(run.value?.smtp).toBeNull();
    expect(c.sockets[0]!.destroys).toBe(1);
    expect(c.sockets[0]!.writes).toEqual([]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ host: "mx.example.test", timeoutMs: 20_000 });
    expect(v.governor.usage().usedToday).toBe(1);
  });
});

// The probe connects through the caller's pre-filtered addresses and never
// resolves the MX name itself: the name reaches the connection only beside a
// `lookup` that answers with exactly those addresses, in both the
// one-address and the all-addresses shape Node asks for, and nothing else in
// the options would make the socket resolve. `node:dns` throws here, so a real
// lookup anywhere on the path fails the case.
describe("probeMailbox — the caller's addresses, never a lookup of the MX name", () => {
  it("hands the connection a lookup that answers with exactly the given addresses, and runs the conversation on that socket", async () => {
    const c = connector();
    const addresses = [
      { address: "192.0.2.10", family: 4 },
      { address: "2001:db8::10", family: 6 },
    ];
    const run = track(
      probeMailbox({
        host: "mx.example.test",
        port: 25,
        heloName: "probe.example.net",
        fromEmail: "postmaster@example.net",
        toEmail: "user1@example.com",
        domain: "example.com",
        skipCatchAll: true,
        timeoutMs: 400,
        addresses,
        createConnection: c.open,
      }),
    );
    expect(c.opened).toEqual([
      {
        host: "mx.example.test",
        port: 25,
        lookup: expect.any(Function),
        autoSelectFamily: true,
        autoSelectFamilyAttemptTimeout: 300,
      },
    ]);
    const lookup = (c.opened[0] as net.TcpNetConnectOpts).lookup as (
      hostname: string,
      options: { all?: boolean; family?: number },
      callback: (...args: unknown[]) => void,
    ) => void;
    const answers: unknown[][] = [];
    lookup("other-name.example", { all: true }, (...args) => answers.push(args));
    lookup("other-name.example", { family: 0 }, (...args) => answers.push(args));
    expect(answers).toEqual([
      [null, addresses],
      [null, "192.0.2.10", 4],
    ]);

    const sock = c.sockets[0]!;
    sock.emit("connect");
    await vi.advanceTimersByTimeAsync(0);
    for (const reply of ["220 ready", "250 hello", "250 sender ok"]) {
      sock.emit("data", `${reply}\r\n`);
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(sock.writes).toEqual([
      "EHLO probe.example.net\r\n",
      "MAIL FROM:<postmaster@example.net>\r\n",
      "RCPT TO:<user1@example.com>\r\n",
    ]);
    sock.emit("data", "250 2.1.5 Ok\r\n");
    await vi.advanceTimersByTimeAsync(0);
    expect(run.done).toBe(true);
    expect(run.error).toBeUndefined();
    expect(run.value).toMatchObject({ rcpt: { code: 250 }, envelopeFailure: null, address: "192.0.2.10" });
    expect(sock.ends).toEqual(["QUIT\r\n"]);
  });
});
