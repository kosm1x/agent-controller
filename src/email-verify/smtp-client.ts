/**
 * email-verify — minimal SMTP probe over node:net (port 25, no TLS: the
 * probe never sends message content, and STARTTLS only adds a handshake
 * that some MX hosts use to fingerprint verifiers).
 *
 * Conversation: banner → EHLO (HELO fallback) → MAIL FROM → optional RCPT TO
 * <random> (catch-all) → RCPT TO <target> → QUIT. Each step has its own
 * deadline. Nothing here decides deliverability; it returns the raw replies
 * for `classify.ts`.
 */

import { promises as dns } from "node:dns";
import type { LookupAddress } from "node:dns";
import * as net from "node:net";
import * as os from "node:os";
import { randomBytes } from "node:crypto";
import { filterSafeAddresses } from "../lib/url-safety.js";
import { parseReply, type SmtpReply } from "./classify.js";

export interface ProbeOptions {
  readonly host: string;
  readonly port: number;
  readonly heloName: string;
  readonly fromEmail: string;
  readonly toEmail: string;
  readonly domain: string;
  /** Skip the random-address catch-all RCPT TO. */
  readonly skipCatchAll: boolean;
  /** Per-step deadline once connected. */
  readonly timeoutMs: number;
  /** TCP connect deadline (dead MX hosts are common on typo domains); default min(timeoutMs, 5000). */
  readonly connectTimeoutMs?: number;
  /** Total budget for this probe call (connect + every step); each step is clipped to what is left. */
  readonly totalBudgetMs?: number;
  /**
   * Pre-resolved, pre-filtered targets (from `resolveMxTargets`). When given,
   * no DNS happens inside the probe; the caller decides whether a connection
   * is charged before any packet leaves.
   */
  readonly addresses?: readonly LookupAddress[];
  /** Tests connect to loopback; production refuses private/loopback MX targets. */
  readonly allowPrivateAddresses?: boolean;
}

/** A hostile or broken MX streaming continuation lines must not grow memory unboundedly. */
const MAX_REPLY_BYTES = 64 * 1024;

export type ProbeStage = "connect" | "banner" | "ehlo" | "mail_from" | "rcpt_catchall" | "rcpt";

export interface ProbeResult {
  /** Reply to RCPT TO <target>; present only when the envelope was accepted. */
  readonly rcpt: SmtpReply | null;
  /** Reply to the random-address RCPT TO; null when skipped or not reached. */
  readonly catchAll: SmtpReply | null;
  /** Envelope-stage failure (banner/EHLO/MAIL FROM non-2xx). */
  readonly envelopeFailure: { stage: ProbeStage; reply: SmtpReply } | null;
  readonly address: string;
}

export class ProbeError extends Error {
  constructor(
    readonly stage: ProbeStage,
    message: string,
    readonly cause?: unknown,
    /** "budget" when the caller's totalBudgetMs, not the host, ended the probe. */
    readonly code: "budget" | null = null,
  ) {
    super(message);
    this.name = "ProbeError";
  }
}

/** Guard against CRLF injection into the SMTP stream (addresses come from the LLM). */
function assertSafeToken(value: string, label: string): void {
  if (/[\r\n\0 <>]/.test(value)) throw new ProbeError("connect", `${label} contains forbidden characters`);
}

/** Index one past the end of the first complete SMTP reply in `buf`, or -1. */
export function smtpReplyEnd(buf: string): number {
  let pos = 0;
  for (;;) {
    const nl = buf.indexOf("\r\n", pos);
    if (nl === -1) return -1;
    const line = buf.slice(pos, nl);
    if (/^\d{3}( |$)/.test(line)) return nl + 2;
    pos = nl + 2;
  }
}

class Conversation {
  private buf = "";
  private failed: Error | null = null;
  private waiters: Array<() => void> = [];

  constructor(
    private readonly socket: net.Socket,
    private readonly timeoutMs: number,
    /** Absolute wall-clock deadline for the whole conversation. */
    private readonly deadlineAt: number,
  ) {
    socket.setEncoding("latin1");
    socket.on("data", (chunk: string) => {
      this.buf += chunk;
      if (this.buf.length > MAX_REPLY_BYTES) {
        this.failed = new Error(`reply exceeded ${MAX_REPLY_BYTES} bytes without terminating`);
        socket.destroy();
      }
      this.wake();
    });
    socket.on("error", (err: Error) => {
      this.failed = err;
      this.wake();
    });
    socket.on("close", () => {
      this.failed ??= new Error("connection closed by server");
      this.wake();
    });
  }

  private wake(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const fn of w) fn();
  }

  async readReply(stage: ProbeStage): Promise<SmtpReply> {
    const deadline = Math.min(Date.now() + this.timeoutMs, this.deadlineAt);
    for (;;) {
      const end = smtpReplyEnd(this.buf);
      if (end !== -1) {
        const raw = this.buf.slice(0, end);
        this.buf = this.buf.slice(end);
        return parseReply(raw);
      }
      if (this.failed) throw new ProbeError(stage, this.failed.message, this.failed);
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        if (deadline === this.deadlineAt) throw new ProbeError(stage, "probe budget exhausted", undefined, "budget");
        throw new ProbeError(stage, `timeout after ${this.timeoutMs}ms`);
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, remaining);
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  async send(stage: ProbeStage, line: string): Promise<SmtpReply> {
    if (this.failed) throw new ProbeError(stage, this.failed.message, this.failed);
    this.socket.write(`${line}\r\n`);
    return this.readReply(stage);
  }

  /** Send QUIT, let the FIN flush, and hard-close if the peer lingers. */
  end(): void {
    const s = this.socket;
    try {
      s.end("QUIT\r\n");
    } catch {
      s.destroy();
      return;
    }
    const t = setTimeout(() => s.destroy(), 500);
    t.unref();
    s.once("close", () => clearTimeout(t));
  }
}

/** Addresses bound on this box's own interfaces (public ones included). */
export function ownInterfaceAddresses(): Set<string> {
  const out = new Set<string>();
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list ?? []) out.add(iface.address.toLowerCase());
  }
  return out;
}

/** Drop private/loopback (url-safety) and own-host addresses. */
function publicTargets(addrs: LookupAddress[]): LookupAddress[] {
  const own = ownInterfaceAddresses();
  return filterSafeAddresses(addrs).safe.filter((a) => !own.has(a.address.toLowerCase()));
}

const REFUSED_MSG = "only resolves to private, loopback or own-host addresses";

/** Resolve an MX host to the public, non-own addresses the probe may connect to. Throws ProbeError("connect"). */
export async function resolveMxTargets(host: string, allowPrivate: boolean): Promise<LookupAddress[]> {
  let addrs: LookupAddress[];
  if (net.isIP(host)) {
    addrs = [{ address: host, family: net.isIP(host) }];
  } else {
    try {
      addrs = await dns.lookup(host, { all: true, verbatim: true });
    } catch (err) {
      throw new ProbeError("connect", `cannot resolve MX host ${host}`, err);
    }
  }
  const usable = allowPrivate ? addrs : publicTargets(addrs);
  if (usable.length === 0) throw new ProbeError("connect", `MX ${host} ${REFUSED_MSG}`);
  // IPv4 first: several MX operators publish AAAA but run stricter policy on v6.
  return [...usable.filter((a) => a.family === 4), ...usable.filter((a) => a.family !== 4)];
}

/**
 * Connect with Node's Happy-Eyeballs (`autoSelectFamily`): every pre-filtered
 * address is handed to the socket through a custom `lookup`, so a dead
 * address family (this VPS intermittently loses IPv4:25 egress, 2026-09-11)
 * costs ~300 ms, not the full connect timeout. Never re-resolves, so the
 * private/own-host filter cannot be bypassed by a flipping DNS record.
 */
function connect(host: string, addrs: LookupAddress[], port: number, timeoutMs: number, budgetClipped = false): Promise<net.Socket> {
  const lookup: net.LookupFunction = (_hostname, options, callback) => {
    if (options.all) {
      (callback as (err: null, addresses: LookupAddress[]) => void)(null, addrs);
    } else {
      (callback as (err: null, address: string, family: number) => void)(null, addrs[0].address, addrs[0].family);
    }
  };
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({
      host,
      port,
      lookup,
      autoSelectFamily: true,
      autoSelectFamilyAttemptTimeout: 300,
    });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(
        budgetClipped
          ? new ProbeError("connect", "probe budget exhausted", undefined, "budget")
          : new ProbeError("connect", `connect timeout after ${timeoutMs}ms`),
      );
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(new ProbeError("connect", err.message, err));
    });
  });
}

function randomLocalPart(): string {
  return randomBytes(9).toString("base64url").replace(/[^a-z0-9]/gi, "x").slice(0, 12).toLowerCase() || "probe";
}

function is2xx(r: SmtpReply): boolean {
  return r.code >= 200 && r.code < 300;
}

/** Run one SMTP probe conversation against a single MX host. */
export async function probeMailbox(opts: ProbeOptions): Promise<ProbeResult> {
  assertSafeToken(opts.toEmail, "recipient");
  assertSafeToken(opts.fromEmail, "sender");
  assertSafeToken(opts.heloName, "HELO name");

  const started = Date.now();
  const deadlineAt = started + (opts.totalBudgetMs ?? Number.MAX_SAFE_INTEGER);
  const addrs = opts.addresses ?? (await resolveMxTargets(opts.host, opts.allowPrivateAddresses ?? false));
  if (addrs.length === 0) throw new ProbeError("connect", `MX ${opts.host} ${REFUSED_MSG}`);
  const connectTimeout = opts.connectTimeoutMs ?? Math.min(opts.timeoutMs, 5_000);
  const left = deadlineAt - Date.now();
  const socket = await connect(opts.host, [...addrs], opts.port, Math.max(1, Math.min(connectTimeout, left)), left < connectTimeout);
  const address = socket.remoteAddress ?? addrs[0].address;
  const conv = new Conversation(socket, opts.timeoutMs, deadlineAt);

  try {
    const banner = await conv.readReply("banner");
    if (!is2xx(banner)) return { rcpt: null, catchAll: null, envelopeFailure: { stage: "banner", reply: banner }, address };

    let hello = await conv.send("ehlo", `EHLO ${opts.heloName}`);
    if (hello.code >= 500) hello = await conv.send("ehlo", `HELO ${opts.heloName}`);
    if (!is2xx(hello)) return { rcpt: null, catchAll: null, envelopeFailure: { stage: "ehlo", reply: hello }, address };

    const from = await conv.send("mail_from", `MAIL FROM:<${opts.fromEmail}>`);
    if (!is2xx(from)) return { rcpt: null, catchAll: null, envelopeFailure: { stage: "mail_from", reply: from }, address };

    let catchAll: SmtpReply | null = null;
    if (!opts.skipCatchAll) {
      catchAll = await conv.send("rcpt_catchall", `RCPT TO:<${randomLocalPart()}@${opts.domain}>`);
    }
    const rcpt = await conv.send("rcpt", `RCPT TO:<${opts.toEmail}>`);
    return { rcpt, catchAll, envelopeFailure: null, address };
  } finally {
    conv.end(); // best-effort QUIT; never fails the probe
  }
}
