/**
 * Email channel adapter — raw IMAP poll + raw SMTP send over TLS.
 *
 * Owner-only. Inbound mail not from EMAIL_OWNER_ADDRESS is dropped before it
 * reaches the router (same trust model as the Telegram owner-chat filter).
 *
 * Zero-dependency by design (codebase invariant: no new deps without
 * discussion). IMAP/SMTP are spoken directly over node:tls; MIME parsing
 * lives in ../email-mime.js. This is a minimal client, not a general MUA —
 * owner-only scope keeps the parse surface small.
 *
 * Env vars: EMAIL_ENABLED, EMAIL_IMAP_HOST, EMAIL_IMAP_PORT (993),
 * EMAIL_SMTP_HOST, EMAIL_SMTP_PORT (465), EMAIL_USERNAME, EMAIL_PASSWORD,
 * EMAIL_ADDRESS (defaults to EMAIL_USERNAME), EMAIL_OWNER_ADDRESS,
 * EMAIL_POLL_INTERVAL_MS (60000).
 */

import * as tls from "node:tls";
import type {
  ChannelAdapter,
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

const IMAP_HOST = process.env.EMAIL_IMAP_HOST;
const IMAP_PORT = Number(process.env.EMAIL_IMAP_PORT) || 993;
const SMTP_HOST = process.env.EMAIL_SMTP_HOST;
const SMTP_PORT = Number(process.env.EMAIL_SMTP_PORT) || 465;
const USERNAME = process.env.EMAIL_USERNAME;
const PASSWORD = process.env.EMAIL_PASSWORD;
const FROM_ADDRESS = process.env.EMAIL_ADDRESS || process.env.EMAIL_USERNAME;
const OWNER_ADDRESS = (process.env.EMAIL_OWNER_ADDRESS ?? "").toLowerCase();
const POLL_INTERVAL_MS = Number(process.env.EMAIL_POLL_INTERVAL_MS) || 60_000;

/** Per-operation network ceiling — a hung socket cannot stall the poll loop. */
const OP_TIMEOUT_MS = 30_000;
/** Cap unseen messages handled per poll, so a backlog cannot flood the router. */
const MAX_PER_POLL = 20;

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
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
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
  readonly name = "email" as const;

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

  isConnected(): boolean {
    return this.lastPollOk;
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.messageHandler = handler;
  }

  async start(): Promise<void> {
    if (!IMAP_HOST || !SMTP_HOST || !USERNAME || !PASSWORD) {
      throw new Error(
        "EMAIL_IMAP_HOST, EMAIL_SMTP_HOST, EMAIL_USERNAME and EMAIL_PASSWORD are required when EMAIL_ENABLED=true",
      );
    }
    if (!OWNER_ADDRESS) {
      throw new Error(
        "EMAIL_OWNER_ADDRESS is required when EMAIL_ENABLED=true",
      );
    }

    // One initial poll to confirm connectivity, but never throw out of it — a
    // flaky mail host must not block service boot; the interval retries.
    await this.poll().catch((err) => {
      console.error(
        "[email] Initial poll failed:",
        err instanceof Error ? err.message : err,
      );
    });

    this.pollTimer = setInterval(() => {
      this.poll().catch((err) => {
        console.error(
          "[email] Poll failed:",
          err instanceof Error ? err.message : err,
        );
      });
    }, POLL_INTERVAL_MS);

    console.log(
      `[email] Channel active — polling ${IMAP_HOST} every ${POLL_INTERVAL_MS}ms`,
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
    const socket = tls.connect({
      host: IMAP_HOST!,
      port: IMAP_PORT,
      servername: IMAP_HOST,
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

      await command(`LOGIN ${imapQuote(USERNAME!)} ${imapQuote(PASSWORD!)}`);
      await command("SELECT INBOX");

      const searchResp = await command("UID SEARCH UNSEEN");
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
            `[email] Failed to process UID ${uid}:`,
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

    if (mail.from !== OWNER_ADDRESS) {
      console.log(`[email] Ignored mail from non-owner: ${mail.from}`);
      return;
    }
    if (mail.messageId && this.processed.has(mail.messageId)) return;
    if (mail.messageId) this.processed.add(mail.messageId);

    // Record thread context so the reply lands in the same thread.
    const refs = [mail.references, mail.messageId].filter(Boolean).join(" ");
    this.threads.set(OWNER_ADDRESS, {
      messageId: mail.messageId,
      references: refs.trim(),
      subject: mail.subject,
    });

    const text = mail.subject
      ? `[Asunto: ${mail.subject}]\n${mail.text}`
      : mail.text;
    if (!text.trim()) return;

    this.messageHandler({
      channel: "email",
      from: OWNER_ADDRESS,
      text,
      timestamp: mail.date,
      replyTo: mail.messageId || undefined,
    });
  }

  async send(msg: OutgoingMessage): Promise<string> {
    if (!SMTP_HOST || !FROM_ADDRESS) {
      console.warn("[email] SMTP not configured — cannot send");
      return "not_configured";
    }

    const domain = FROM_ADDRESS.split("@")[1] || "localhost";
    const messageId = generateMessageId(domain);
    const thread = this.threads.get(msg.to.toLowerCase());

    let subject = thread?.subject?.trim() || "Jarvis";
    if (!/^re:/i.test(subject)) subject = `Re: ${subject}`;

    const mime = buildMimeMessage({
      from: FROM_ADDRESS,
      to: msg.to,
      subject,
      body: formatForEmail(msg.text),
      messageId,
      inReplyTo: thread?.messageId || undefined,
      references: thread?.references || undefined,
    });

    try {
      await withTimeout(
        this.smtpSend(extractAddress(FROM_ADDRESS), msg.to, mime),
        OP_TIMEOUT_MS,
        "SMTP send",
      );
      return messageId;
    } catch (err) {
      console.error(
        "[email] Send failed:",
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
    const socket = tls.connect({
      host: SMTP_HOST!,
      port: SMTP_PORT,
      servername: SMTP_HOST,
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
      await expect("334", Buffer.from(USERNAME!, "utf8").toString("base64"));
      await expect("235", Buffer.from(PASSWORD!, "utf8").toString("base64"));
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
