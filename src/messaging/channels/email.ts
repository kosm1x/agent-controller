/**
 * Email channel adapter — raw IMAP poll + raw SMTP send over TLS.
 *
 * Multi-mailbox: one `EmailAdapter` instance per configured account. Each
 * registers with the router under a distinct channel name `email:<id>`, so a
 * reply routes back to the exact mailbox the message arrived on and each
 * mailbox gets its own conversation thread. Owner-only — inbound mail not from
 * the account's owner address is dropped before it reaches the router (same
 * trust model as the Telegram owner-chat filter).
 *
 * Zero-dependency by design (codebase invariant: no new deps without
 * discussion). IMAP/SMTP are spoken directly over node:tls; MIME parsing
 * lives in ../email-mime.js. This is a minimal client, not a general MUA —
 * owner-only scope keeps the parse surface small.
 *
 * Config (via parseEmailAccounts): EMAIL_ENABLED gates the channel,
 * EMAIL_ACCOUNTS is a comma-separated list of account ids, and each id ID
 * (matching [a-z0-9_]+) carries its own block of env vars:
 *   EMAIL_<ID>_IMAP_HOST, EMAIL_<ID>_IMAP_PORT (993),
 *   EMAIL_<ID>_SMTP_HOST, EMAIL_<ID>_SMTP_PORT (465),
 *   EMAIL_<ID>_USERNAME, EMAIL_<ID>_PASSWORD,
 *   EMAIL_<ID>_ADDRESS (defaults to USERNAME), EMAIL_<ID>_OWNER_ADDRESS,
 *   EMAIL_<ID>_POLL_INTERVAL_MS (60000).
 */

import * as tls from "node:tls";
import type {
  ChannelAdapter,
  ChannelName,
  IncomingMessage,
  OutgoingMessage,
} from "../types.js";
import { formatForEmail } from "../formatter.js";
import {
  buildMimeMessage,
  extractAddress,
  generateMessageId,
  parseEmail,
} from "../email-mime.js";

/** Per-operation network ceiling — a hung socket cannot stall the poll loop. */
const OP_TIMEOUT_MS = 30_000;
/** Cap unseen messages handled per poll, so a backlog cannot flood the router. */
const MAX_PER_POLL = 20;

/** Resolved configuration for one mailbox. */
export interface MailboxConfig {
  /** Account id — `[a-z0-9_]+`; becomes the `email:<id>` channel suffix. */
  id: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  username: string;
  password: string;
  /** `From:` address — defaults to `username`. */
  fromAddress: string;
  /** Only mail from this sender is processed; stored lowercased. */
  ownerAddress: string;
  pollIntervalMs: number;
}

/** Account ids must be safe to use as a channel-name suffix and env-var infix. */
const ACCOUNT_ID_RE = /^[a-z0-9_]+$/;

/**
 * Parse the multi-account email config from the environment. Throws with a
 * precise message on any misconfiguration so a bad `.env` fails fast at boot
 * rather than silently running zero mailboxes. Called only when
 * `EMAIL_ENABLED=true`.
 */
export function parseEmailAccounts(): MailboxConfig[] {
  const raw = (process.env.EMAIL_ACCOUNTS ?? "").trim();
  if (!raw) {
    throw new Error(
      "EMAIL_ACCOUNTS is required when EMAIL_ENABLED=true — comma-separated list of account ids",
    );
  }
  const ids = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (ids.length === 0) {
    throw new Error("EMAIL_ACCOUNTS contained no usable account ids");
  }

  const seen = new Set<string>();
  const configs: MailboxConfig[] = [];
  for (const id of ids) {
    if (!ACCOUNT_ID_RE.test(id)) {
      throw new Error(
        `Email account id "${id}" is invalid — must match [a-z0-9_]+`,
      );
    }
    if (seen.has(id)) {
      throw new Error(
        `Email account id "${id}" is listed twice in EMAIL_ACCOUNTS`,
      );
    }
    seen.add(id);

    const prefix = `EMAIL_${id.toUpperCase()}_`;
    /** Read a per-account var; treats whitespace-only as absent. */
    const get = (suffix: string): string | undefined => {
      const v = process.env[prefix + suffix];
      return v && v.trim() ? v.trim() : undefined;
    };
    /**
     * Read an optional numeric per-account var. Absent → `fallback`; present
     * but not an integer in `1..max` → throw. Fail-fast on a typo'd port or
     * interval rather than silently substituting the default.
     */
    const numOpt = (suffix: string, fallback: number, max: number): number => {
      const v = get(suffix);
      if (v === undefined) return fallback;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > max) {
        throw new Error(
          `Email account "${id}" has invalid ${prefix}${suffix}="${v}" — expected an integer 1..${max}`,
        );
      }
      return n;
    };
    // Password is read raw (not trimmed) — a provider password could in
    // principle carry edge whitespace; only its presence is validated.
    const password = process.env[prefix + "PASSWORD"] || undefined;

    const imapHost = get("IMAP_HOST");
    const smtpHost = get("SMTP_HOST");
    const username = get("USERNAME");
    const ownerAddress = get("OWNER_ADDRESS");

    const missing: string[] = [];
    if (!imapHost) missing.push(prefix + "IMAP_HOST");
    if (!smtpHost) missing.push(prefix + "SMTP_HOST");
    if (!username) missing.push(prefix + "USERNAME");
    if (!password) missing.push(prefix + "PASSWORD");
    if (!ownerAddress) missing.push(prefix + "OWNER_ADDRESS");
    if (missing.length > 0) {
      throw new Error(
        `Email account "${id}" is missing required env vars: ${missing.join(", ")}`,
      );
    }

    configs.push({
      id,
      imapHost: imapHost!,
      imapPort: numOpt("IMAP_PORT", 993, 65_535),
      smtpHost: smtpHost!,
      smtpPort: numOpt("SMTP_PORT", 465, 65_535),
      username: username!,
      password: password!,
      fromAddress: get("ADDRESS") || username!,
      ownerAddress: ownerAddress!.toLowerCase(),
      pollIntervalMs: numOpt("POLL_INTERVAL_MS", 60_000, 86_400_000),
    });
  }
  return configs;
}

/**
 * Buffered reader over a TLS socket. Accumulates bytes as a latin1 string
 * (bytes survive 1:1) and resolves `readUntil` once a caller-supplied
 * predicate finds a complete frame.
 */
class SocketReader {
  private buf = "";
  private waiters: Array<() => void> = [];
  private failed: Error | null = null;

  constructor(socket: tls.TLSSocket) {
    socket.on("data", (chunk: Buffer) => {
      this.buf += chunk.toString("latin1");
      this.wake();
    });
    socket.on("error", (err: Error) => {
      this.failed = err;
      this.wake();
    });
    socket.on("close", () => {
      if (!this.failed) this.failed = new Error("socket closed");
      this.wake();
    });
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }

  /**
   * Resolve once `findEnd(buffer)` returns a non-negative index — that many
   * leading characters are consumed and returned. Rejects on socket failure.
   */
  async readUntil(findEnd: (buf: string) => number): Promise<string> {
    for (;;) {
      const end = findEnd(this.buf);
      if (end >= 0) {
        const out = this.buf.slice(0, end);
        this.buf = this.buf.slice(end);
        return out;
      }
      if (this.failed) throw this.failed;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}

/** Reject `promise` if it does not settle within `ms`. */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Find the end of an SMTP reply: a line whose code is followed by a space. */
function smtpReplyEnd(buf: string): number {
  let pos = 0;
  for (;;) {
    const nl = buf.indexOf("\r\n", pos);
    if (nl === -1) return -1;
    const line = buf.slice(pos, nl);
    if (/^\d{3} /.test(line)) return nl + 2;
    pos = nl + 2;
  }
}

/**
 * Find the end of an IMAP response tagged `tag`, honouring `{n}` literals
 * (the n bytes after the line are opaque and may contain CRLF).
 */
function imapTaggedEnd(tag: string, buf: string): number {
  let pos = 0;
  while (pos < buf.length) {
    const nl = buf.indexOf("\r\n", pos);
    if (nl === -1) return -1;
    const line = buf.slice(pos, nl);
    const literal = line.match(/\{(\d+)\}$/);
    if (literal) {
      const litLen = parseInt(literal[1], 10);
      const litStart = nl + 2;
      if (litStart + litLen > buf.length) return -1;
      pos = litStart + litLen;
      continue;
    }
    if (line.startsWith(tag + " ")) return nl + 2;
    pos = nl + 2;
  }
  return -1;
}

/** Quote a string for an IMAP command argument. */
function imapQuote(s: string): string {
  return '"' + s.replace(/[\\"]/g, (c) => "\\" + c) + '"';
}

export class EmailAdapter implements ChannelAdapter {
  /** `email:<id>` — distinct per mailbox so the router routes replies back. */
  readonly name: ChannelName;
  /** Exposed so the router's `getOwnerAddress` can resolve per-account. */
  readonly ownerAddress: string;

  private readonly config: MailboxConfig;
  /** Log prefix, e.g. `email:comunidades`. */
  private readonly logTag: string;

  private messageHandler: ((msg: IncomingMessage) => void) | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private stopped = false;
  private lastPollOk = false;
  /** Message-IDs handled this process, as a guard if STORE \Seen fails. */
  private processed = new Set<string>();
  /** Per-sender thread context, so replies land in the original thread. */
  private threads = new Map<
    string,
    { messageId: string; references: string; subject: string }
  >();

  constructor(config: MailboxConfig) {
    this.config = config;
    this.name = `email:${config.id}`;
    this.ownerAddress = config.ownerAddress;
    this.logTag = `email:${config.id}`;
  }

  isConnected(): boolean {
    return this.lastPollOk;
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.messageHandler = handler;
  }

  async start(): Promise<void> {
    // Config is already validated by parseEmailAccounts() — just begin polling.
    // One initial poll to confirm connectivity, but never throw out of it: a
    // flaky mail host must not block service boot; the interval retries.
    await this.poll().catch((err) => {
      console.error(
        `[${this.logTag}] Initial poll failed:`,
        err instanceof Error ? err.message : err,
      );
    });

    this.pollTimer = setInterval(() => {
      this.poll().catch((err) => {
        console.error(
          `[${this.logTag}] Poll failed:`,
          err instanceof Error ? err.message : err,
        );
      });
    }, this.config.pollIntervalMs);

    console.log(
      `[${this.logTag}] Channel active — polling ${this.config.imapHost} every ${this.config.pollIntervalMs}ms`,
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** One IMAP poll cycle: fetch unseen owner mail, hand it to the router. */
  private async poll(): Promise<void> {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      await withTimeout(this.pollInternal(), OP_TIMEOUT_MS, "IMAP poll");
      this.lastPollOk = true;
    } catch (err) {
      this.lastPollOk = false;
      throw err;
    } finally {
      this.polling = false;
    }
  }

  private async pollInternal(): Promise<void> {
    const { imapHost, imapPort, username, password, ownerAddress } =
      this.config;
    const socket = tls.connect({
      host: imapHost,
      port: imapPort,
      servername: imapHost,
    });
    // Idle-timeout the socket itself: withTimeout() rejects the caller but
    // cannot unblock a readUntil() awaiting a silent socket — only a real
    // socket event (error/close) wakes the reader and lets `finally` run.
    socket.setTimeout(OP_TIMEOUT_MS, () => {
      socket.destroy(new Error("IMAP socket idle timeout"));
    });
    const reader = new SocketReader(socket);
    let tagSeq = 0;
    const nextTag = () => `a${++tagSeq}`;

    const readLine = (): Promise<string> =>
      reader.readUntil((b) => {
        const nl = b.indexOf("\r\n");
        return nl === -1 ? -1 : nl + 2;
      });

    const command = async (cmd: string): Promise<string> => {
      const tag = nextTag();
      socket.write(`${tag} ${cmd}\r\n`);
      const resp = await reader.readUntil((b) => imapTaggedEnd(tag, b));
      if (!new RegExp(`(^|\\r\\n)${tag} OK`).test(resp)) {
        throw new Error(`IMAP command failed: ${cmd.split(" ")[0]}`);
      }
      return resp;
    };

    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("secureConnect", resolve);
        socket.once("error", reject);
      });
      await readLine(); // server greeting

      await command(`LOGIN ${imapQuote(username)} ${imapQuote(password)}`);
      await command("SELECT INBOX");

      // Scope the search to owner mail server-side. Non-owner unseen mail is
      // then never fetched and never flagged \Seen — Jarvis must not mutate
      // the read state of other mail in a shared mailbox. handleRawEmail()
      // keeps its own owner check as defense-in-depth (FROM is a substring
      // match and can over-match).
      const searchResp = await command(
        `UID SEARCH UNSEEN FROM ${imapQuote(ownerAddress)}`,
      );
      const searchLine = searchResp
        .split("\r\n")
        .find((l) => /^\* SEARCH/i.test(l));
      const uids = searchLine
        ? searchLine
            .replace(/^\* SEARCH/i, "")
            .trim()
            .split(/\s+/)
            .filter((u) => /^\d+$/.test(u))
        : [];

      for (const uid of uids.slice(0, MAX_PER_POLL)) {
        try {
          const fetchResp = await command(`UID FETCH ${uid} (BODY.PEEK[])`);
          const raw = extractFetchLiteral(fetchResp);
          if (raw) this.handleRawEmail(raw);
        } catch (err) {
          console.error(
            `[${this.logTag}] Failed to process UID ${uid}:`,
            err instanceof Error ? err.message : err,
          );
        }
        // Mark seen regardless — a message we cannot parse should not be
        // retried forever. The router got whatever we could extract.
        await command(`UID STORE ${uid} +FLAGS (\\Seen)`).catch(() => {});
      }

      socket.write(`${nextTag()} LOGOUT\r\n`);
    } finally {
      socket.destroy();
    }
  }

  /** Parse a raw RFC822 message, owner-filter it, emit to the router. */
  private handleRawEmail(raw: string): void {
    if (!this.messageHandler) return;
    const mail = parseEmail(raw);
    const ownerAddress = this.config.ownerAddress;

    if (mail.from !== ownerAddress) {
      console.log(`[${this.logTag}] Ignored mail from non-owner: ${mail.from}`);
      return;
    }
    if (mail.messageId && this.processed.has(mail.messageId)) return;
    if (mail.messageId) this.processed.add(mail.messageId);

    // Record thread context so the reply lands in the same thread.
    const refs = [mail.references, mail.messageId].filter(Boolean).join(" ");
    this.threads.set(ownerAddress, {
      messageId: mail.messageId,
      references: refs.trim(),
      subject: mail.subject,
    });

    // A subject-only email is still a message, so emit when EITHER the subject
    // or the body carries content. The `[Cuenta: ...]` header tells Jarvis
    // which project mailbox this arrived on — keyed by the stable account id
    // (the same token as the `email:<id>` channel name and the logs), with
    // the address in parens for context. fromAddress alone is unstable: it
    // can be overridden away from the polled mailbox via EMAIL_<ID>_ADDRESS.
    if (!mail.subject && !mail.text.trim()) return;
    const cuenta = `${this.config.id} (${this.config.fromAddress})`;
    const header = mail.subject
      ? `[Cuenta: ${cuenta} | Asunto: ${mail.subject}]`
      : `[Cuenta: ${cuenta}]`;

    this.messageHandler({
      channel: this.name,
      from: ownerAddress,
      text: `${header}\n${mail.text}`,
      timestamp: mail.date,
      replyTo: mail.messageId || undefined,
    });
  }

  async send(msg: OutgoingMessage): Promise<string> {
    // smtpHost / fromAddress are guaranteed non-empty by parseEmailAccounts().
    const { fromAddress } = this.config;
    const domain = fromAddress.split("@")[1] || "localhost";
    const messageId = generateMessageId(domain);
    const thread = this.threads.get(msg.to.toLowerCase());

    let subject = thread?.subject?.trim() || "Jarvis";
    if (!/^re:/i.test(subject)) subject = `Re: ${subject}`;

    const mime = buildMimeMessage({
      from: fromAddress,
      to: msg.to,
      subject,
      body: formatForEmail(msg.text),
      messageId,
      inReplyTo: thread?.messageId || undefined,
      references: thread?.references || undefined,
    });

    try {
      await withTimeout(
        this.smtpSend(extractAddress(fromAddress), msg.to, mime),
        OP_TIMEOUT_MS,
        "SMTP send",
      );
      return messageId;
    } catch (err) {
      console.error(
        `[${this.logTag}] Send failed:`,
        err instanceof Error ? err.message : err,
      );
      return "error";
    }
  }

  /** Deliver one message over implicit-TLS SMTP with AUTH LOGIN. */
  private async smtpSend(
    from: string,
    to: string,
    mime: string,
  ): Promise<void> {
    const { smtpHost, smtpPort, username, password } = this.config;
    const socket = tls.connect({
      host: smtpHost,
      port: smtpPort,
      servername: smtpHost,
    });
    // Idle-timeout the socket itself — see the matching note in pollInternal().
    socket.setTimeout(OP_TIMEOUT_MS, () => {
      socket.destroy(new Error("SMTP socket idle timeout"));
    });
    const reader = new SocketReader(socket);

    const expect = async (code: string, cmd?: string): Promise<void> => {
      if (cmd !== undefined) socket.write(cmd + "\r\n");
      const reply = await reader.readUntil(smtpReplyEnd);
      if (!reply.startsWith(code)) {
        throw new Error(
          `SMTP expected ${code}, got: ${reply.split("\r\n")[0]}`,
        );
      }
    };

    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("secureConnect", resolve);
        socket.once("error", reject);
      });
      await expect("220"); // greeting
      await expect("250", `EHLO ${from.split("@")[1] || "localhost"}`);
      await expect("334", "AUTH LOGIN");
      await expect("334", Buffer.from(username, "utf8").toString("base64"));
      await expect("235", Buffer.from(password, "utf8").toString("base64"));
      await expect("250", `MAIL FROM:<${from}>`);
      await expect("250", `RCPT TO:<${to}>`);
      await expect("354", "DATA");
      // Dot-stuff and terminate the DATA payload.
      const stuffed = mime.replace(/\r\n\./g, "\r\n..");
      socket.write(stuffed + "\r\n.\r\n");
      await expect("250");
      socket.write("QUIT\r\n");
    } finally {
      socket.destroy();
    }
  }
}

/** Pull the RFC822 literal payload out of an `UID FETCH ... BODY[]` response. */
function extractFetchLiteral(resp: string): string | null {
  const m = resp.match(/\{(\d+)\}\r\n/);
  if (!m || m.index === undefined) return null;
  const size = parseInt(m[1], 10);
  const start = m.index + m[0].length;
  return resp.slice(start, start + size);
}
