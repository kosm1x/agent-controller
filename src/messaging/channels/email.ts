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
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ChannelAdapter,
  ChannelName,
  EmailChannelMode,
  IncomingMessage,
  OutgoingMessage,
} from "../types.js";
import { formatForEmail } from "../formatter.js";
import {
  assertNoCrlf,
  buildMimeMessage,
  extractAddress,
  generateMessageId,
  parseEmail,
  type ParsedEmail,
} from "../email-mime.js";
import { errMsg } from "../../lib/err-msg.js";

/** Per-operation network ceiling — a hung socket cannot stall the poll loop. */
const OP_TIMEOUT_MS = 30_000;
/** Cap unseen messages handled per poll, so a backlog cannot flood the router. */
const MAX_PER_POLL = 20;
/** Floor for the IMAP poll cadence — guards against a typo'd sub-second value. */
const MIN_POLL_INTERVAL_MS = 10_000;
/** Defensive cap on persona-file size — a generous bound on any reasonable
 * org-context document, guards against an accidentally huge file blowing up
 * the system-prompt cache budget. 1 MiB. */
const MAX_PERSONA_BYTES = 1_048_576;
/**
 * Bound on the in-memory processed-id dedup guard. It only needs a recency
 * window to cover the rare "STORE \Seen failed" case, not the full process
 * lifetime — an unbounded Set in a long-lived service is a slow leak.
 */
const PROCESSED_ID_CAP = 500;

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
  /**
   * Sender policy.
   * - `owner-only` (default): only mail FROM `ownerAddress` is fetched and
   *   handled; `ownerAddress` is required. Same trust model as Telegram.
   * - `community-manager`: every unseen message is read, replies go back to
   *   the originating sender, and `ownerAddress` is optional (when set, it is
   *   reserved as the operator-escalation address — not a sender filter).
   */
  mode: EmailChannelMode;
  /**
   * Owner address, lowercased. Required in `owner-only`; optional in
   * `community-manager` (null when unset).
   */
  ownerAddress: string | null;
  pollIntervalMs: number;
  /**
   * Org-persona content (markdown) for community-manager mode. Loaded from
   * `EMAIL_<ID>_PERSONA_FILE` at parse time so the value baked into the
   * MailboxConfig stays byte-stable across runtime — the system prompt that
   * embeds it then stays cache-friendly. Null when no persona file is
   * configured.
   */
  personaContent: string | null;
}

/** Account ids must be safe to use as a channel-name suffix and env-var infix. */
const ACCOUNT_ID_RE = /^[a-z0-9_]+$/;

const VALID_MODES: ReadonlySet<EmailChannelMode> = new Set([
  "owner-only",
  "community-manager",
]);

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
  // Distinct (imapHost, username) pairs — two account ids pointing at the same
  // underlying mailbox would race to STORE \Seen and double-deliver, since the
  // dedup guard is per-adapter. Reject the copy-paste config error up front.
  const seenMailbox = new Set<string>();
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
     * but not an integer in `min..max` → throw. Fail-fast on a typo'd port or
     * interval rather than silently substituting the default.
     */
    const numOpt = (
      suffix: string,
      fallback: number,
      max: number,
      min = 1,
    ): number => {
      const v = get(suffix);
      if (v === undefined) return fallback;
      const n = Number(v);
      if (!Number.isInteger(n) || n < min || n > max) {
        throw new Error(
          `Email account "${id}" has invalid ${prefix}${suffix}="${v}" — expected an integer ${min}..${max}`,
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

    const rawMode = get("MODE") ?? "owner-only";
    if (!VALID_MODES.has(rawMode as EmailChannelMode)) {
      throw new Error(
        `Email account "${id}" has invalid ${prefix}MODE="${rawMode}" — expected owner-only or community-manager`,
      );
    }
    const mode = rawMode as EmailChannelMode;

    const missing: string[] = [];
    if (!imapHost) missing.push(prefix + "IMAP_HOST");
    if (!smtpHost) missing.push(prefix + "SMTP_HOST");
    if (!username) missing.push(prefix + "USERNAME");
    if (!password) missing.push(prefix + "PASSWORD");
    // OWNER_ADDRESS is the sender filter in owner-only mode and is required
    // there. In community-manager mode it is optional — when set it is the
    // operator escalation address, not a filter.
    if (mode === "owner-only" && !ownerAddress) {
      missing.push(prefix + "OWNER_ADDRESS");
    }
    if (missing.length > 0) {
      throw new Error(
        `Email account "${id}" is missing required env vars: ${missing.join(", ")}`,
      );
    }

    const mailboxKey = `${imapHost!.toLowerCase()}\u0000${username!.toLowerCase()}`;
    if (seenMailbox.has(mailboxKey)) {
      throw new Error(
        `Email account "${id}" points at the same mailbox (${username} on ${imapHost}) as an earlier account — each account must be a distinct (IMAP host, username) pair`,
      );
    }
    seenMailbox.add(mailboxKey);

    // Persona file — optional. Path may be absolute or relative to cwd
    // (systemd WorkingDirectory = repo root). Missing path means no persona
    // (Jarvis replies generically); a configured path that is missing /
    // unreadable / too large throws at boot rather than running with the
    // wrong persona.
    let personaContent: string | null = null;
    const rawPersonaPath = get("PERSONA_FILE");
    if (rawPersonaPath) {
      const resolved = path.isAbsolute(rawPersonaPath)
        ? rawPersonaPath
        : path.resolve(process.cwd(), rawPersonaPath);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(resolved);
      } catch (err) {
        throw new Error(
          `Email account "${id}" persona file "${rawPersonaPath}" (resolved: ${resolved}) not readable: ${errMsg(err)}`,
        );
      }
      if (!stat.isFile()) {
        throw new Error(
          `Email account "${id}" persona path "${resolved}" is not a regular file`,
        );
      }
      if (stat.size > MAX_PERSONA_BYTES) {
        throw new Error(
          `Email account "${id}" persona file "${resolved}" is ${stat.size} bytes (cap ${MAX_PERSONA_BYTES})`,
        );
      }
      personaContent = fs.readFileSync(resolved, "utf8");
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
      mode,
      ownerAddress: ownerAddress ? ownerAddress.toLowerCase() : null,
      pollIntervalMs: numOpt(
        "POLL_INTERVAL_MS",
        60_000,
        86_400_000,
        MIN_POLL_INTERVAL_MS,
      ),
      personaContent,
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

/**
 * Find the end of an SMTP reply: a line whose code is followed by a space or
 * by nothing (a bare `250` final line is valid; `-` marks a continuation).
 * Exported for unit testing — multi-line replies (`250-...` / `250 ...`) are a
 * common provider-specific edge case.
 */
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

/**
 * Find the end of an IMAP response tagged `tag`, honouring `{n}` literals
 * (the n bytes after the line are opaque and may contain CRLF). Exported for
 * unit testing — literal handling is the highest-risk parser path.
 */
export function imapTaggedEnd(tag: string, buf: string): number {
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

/** Quote a string for an IMAP command argument. Exported for unit testing. */
export function imapQuote(s: string): string {
  return '"' + s.replace(/[\\"]/g, (c) => "\\" + c) + '"';
}

/**
 * True if an inbound message looks like a bounce / delivery-status notification
 * / out-of-office / auto-reply that an auto-responder MUST NOT reply to.
 *
 * Checks in order of strength:
 *   1. From: address on the standard bounce/system pseudo-mailboxes
 *      (mailer-daemon, postmaster, no-reply, noreply, daemon).
 *   2. `Auto-Submitted` header present and != "no" (RFC 3834 — the canonical
 *      auto-reply marker).
 *   3. `Precedence: bulk|list|junk` (legacy form some MTAs still honour).
 *   4. `Content-Type: multipart/report` (RFC 3464 delivery-status reports).
 *   5. Subject prefix matching common MTA / OOO patterns in EN + ES.
 *
 * False-positive risk is low: a real community member's "Auto: Vacation" or
 * "Out of Office" message is unusual on a community-manager mailbox and would
 * not require a substantive reply anyway. Dropping it silently is far better
 * than continuing the bounce cascade that took 2 messages/minute when this
 * filter was absent (incident 2026-05-15).
 */
export function isAutoReplyOrBounce(mail: ParsedEmail, raw: string): boolean {
  const fromLocal = (mail.from.split("@")[0] || "").toLowerCase();
  if (
    fromLocal === "mailer-daemon" ||
    fromLocal === "postmaster" ||
    fromLocal === "no-reply" ||
    fromLocal === "noreply" ||
    fromLocal === "daemon" ||
    fromLocal === "mail-daemon" ||
    fromLocal.startsWith("mailer-daemon") ||
    fromLocal.startsWith("postmaster-")
  ) {
    return true;
  }
  // Scan the headers block once. Stop at the first blank line — body content
  // (a forwarded bounce report quoted inline by a human, for instance) is not
  // headers and must not poison this check.
  const sep = raw.match(/\r?\n\r?\n/);
  const headersBlock =
    sep && sep.index !== undefined ? raw.slice(0, sep.index) : raw;
  const autoSub = headersBlock.match(/^Auto-Submitted:\s*([^\r\n;]+)/im);
  if (autoSub && autoSub[1].trim().toLowerCase() !== "no") return true;
  const precedence = headersBlock.match(/^Precedence:\s*([^\r\n]+)/im);
  if (
    precedence &&
    /^(bulk|list|junk|auto_reply)$/i.test(precedence[1].trim())
  ) {
    return true;
  }
  if (/^Content-Type:\s*multipart\/report/im.test(headersBlock)) return true;
  const subj = mail.subject.trim();
  if (
    /^(undelivered|returned|delivery (?:status|failure|notification)|delivery report|failure notice|mail delivery (?:failure|failed)|auto[: ]|automatic reply|out of office|fuera de la oficina|respuesta automática|correo no entregado|devuelto|no se pudo entregar|notificación de estado de entrega)/i.test(
      subj,
    )
  ) {
    return true;
  }
  return false;
}

export class EmailAdapter implements ChannelAdapter {
  /** `email:<id>` — distinct per mailbox so the router routes replies back. */
  readonly name: ChannelName;
  /**
   * Exposed so the router's `getOwnerAddress` can resolve per-account. In
   * community-manager mode this is null unless the operator set an escalation
   * address — never a sender filter in that mode.
   */
  readonly ownerAddress: string | null;
  /** Channel policy — drives the router's tool-scope override. */
  readonly mode: EmailChannelMode;
  /**
   * Org-persona markdown for community-manager mode. The router prepends it
   * to the system prompt when this is non-null, so Jarvis replies grounded
   * in the org's documented mission/voice instead of from a canned persona.
   */
  readonly personaContent: string | null;

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
    this.mode = config.mode;
    this.personaContent = config.personaContent;
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
        errMsg(err),
      );
    });

    this.pollTimer = setInterval(() => {
      this.poll().catch((err) => {
        console.error(
          `[${this.logTag}] Poll failed:`,
          errMsg(err),
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
    const { imapHost, imapPort, username, password, ownerAddress, mode } =
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

      // Sender policy decides the search scope.
      //   owner-only        → `UID SEARCH UNSEEN FROM <owner>` (server-side
      //     scope so non-owner mail in a shared mailbox is never fetched and
      //     never flagged \Seen; handleRawEmail()'s exact-match check is a
      //     second layer since IMAP FROM is substring).
      //   community-manager → `UID SEARCH UNSEEN` (every sender is read).
      const searchCmd =
        mode === "community-manager"
          ? "UID SEARCH UNSEEN"
          : `UID SEARCH UNSEEN FROM ${imapQuote(ownerAddress!)}`;
      const searchResp = await command(searchCmd);
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
            errMsg(err),
          );
        }
        // Mark seen regardless — a message we cannot parse should not be
        // retried forever. Note: if parseEmail()/handleRawEmail() threw above,
        // the router got NOTHING for this UID and it is dropped (logged, not
        // re-fetched). Acceptable under the owner-only trust model, but it is a
        // real drop, not a partial delivery.
        await command(`UID STORE ${uid} +FLAGS (\\Seen)`).catch(() => {});
      }

      socket.write(`${nextTag()} LOGOUT\r\n`);
    } finally {
      socket.destroy();
    }
  }

  /** Parse a raw RFC822 message, apply the channel policy, emit to the router. */
  private handleRawEmail(raw: string): void {
    if (!this.messageHandler) return;
    const mail = parseEmail(raw);
    const { mode, ownerAddress } = this.config;

    // FIRST gate: reject bounces and auto-replies in BOTH modes. A reply to a
    // mailer-daemon bounces back, which becomes a new inbound, which Jarvis
    // tries to reply to, etc. — a 2-message-per-minute loop until someone
    // pulls the plug. RFC 3834 says an auto-responder MUST NOT reply to
    // auto-submitted mail. Incident 2026-05-15: community-manager mode took
    // a single bouncing send and turned it into a sustained bounce cascade.
    if (isAutoReplyOrBounce(mail, raw)) {
      console.log(
        `[${this.logTag}] Skipped bounce/auto-reply from ${mail.from} (subject: ${mail.subject.slice(0, 80)})`,
      );
      return;
    }

    // Sender filter: owner-only mode rejects non-owner mail as defense-in-depth
    // (IMAP FROM-search is substring and can over-match). Community-manager
    // mode accepts every sender — the mailbox is public-facing.
    if (mode === "owner-only" && mail.from !== ownerAddress) {
      console.log(`[${this.logTag}] Ignored mail from non-owner: ${mail.from}`);
      return;
    }

    if (mail.messageId && this.processed.has(mail.messageId)) return;
    if (mail.messageId) {
      this.processed.add(mail.messageId);
      // Bound the guard to a recency window. Set preserves insertion order, so
      // deleting the first key evicts the oldest id.
      if (this.processed.size > PROCESSED_ID_CAP) {
        const oldest = this.processed.values().next().value;
        if (oldest !== undefined) this.processed.delete(oldest);
      }
    }

    // Thread context is keyed by the actual sender — that matches the address
    // `send()` later receives as `msg.to` (the router replies back to whoever
    // wrote in). In owner-only mode this is always the owner; in
    // community-manager mode every sender gets their own thread row, so two
    // concurrent conversations on one mailbox don't clobber each other.
    const refs = [mail.references, mail.messageId].filter(Boolean).join(" ");
    this.threads.set(mail.from, {
      messageId: mail.messageId,
      references: refs.trim(),
      subject: mail.subject,
    });

    // A subject-only email is still a message; emit when EITHER subject or
    // body carries content. The `[Cuenta: ...]` header tells Jarvis which
    // project mailbox this arrived on (keyed by the stable account id, same
    // token as the channel name and logs; address in parens for context —
    // fromAddress can be overridden away from the polled mailbox via
    // EMAIL_<ID>_ADDRESS). community-manager mode additionally carries the
    // mode tag and the originating sender so the system prompt can branch
    // and Jarvis knows who he is replying to.
    if (!mail.subject && !mail.text.trim()) return;
    // Sanitise every field that lands in the [ ... ] header before joining on
    // " | ". A hostile sender can otherwise inject a fake "Modo: owner-only"
    // tag (prompt-injecting the persona branch back to operator-trust) or
    // split the header onto a new line so the LLM reads the rest of the body
    // as the header. parseHeaders splits on CRLF so subject is usually safe,
    // but the From display name leaks through extractAddress in some
    // edge cases — guard defensively. Replace separator/control chars with a
    // space.
    const sanitiseHeaderField = (s: string): string =>
      s.replace(/[\r\n|[\]]/g, " ").trim();
    const safeFrom = sanitiseHeaderField(mail.from);
    const safeSubject = sanitiseHeaderField(mail.subject);
    const cuenta = `${this.config.id} (${this.config.fromAddress})`;
    const parts: string[] = [`Cuenta: ${cuenta}`];
    if (mode === "community-manager") {
      parts.push(`Modo: community-manager`, `De: ${safeFrom}`);
    }
    if (safeSubject) parts.push(`Asunto: ${safeSubject}`);
    const header = `[${parts.join(" | ")}]`;

    this.messageHandler({
      channel: this.name,
      from: mail.from,
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
      // Re-throw rather than returning an "error" sentinel string. The router's
      // sendToChannel() only catches a *thrown* rejection — a swallowed failure
      // here is a silently dropped reply, and the sentinel would otherwise be
      // persisted as if it were a real Message-ID. Logged at both layers.
      console.error(
        `[${this.logTag}] Send failed:`,
        errMsg(err),
      );
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  /** Deliver one message over implicit-TLS SMTP with AUTH LOGIN. */
  private async smtpSend(
    from: string,
    to: string,
    mime: string,
  ): Promise<void> {
    // Guard the envelope before it is written to the socket — a CRLF in an
    // address would inject extra SMTP commands. `from` also feeds the EHLO
    // domain, so guarding it covers EHLO too.
    assertNoCrlf(from, "SMTP MAIL FROM");
    assertNoCrlf(to, "SMTP RCPT TO");
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

/**
 * Pull the RFC822 literal payload out of an `UID FETCH ... BODY[]` response.
 * Exported for unit testing.
 */
export function extractFetchLiteral(resp: string): string | null {
  const m = resp.match(/\{(\d+)\}\r\n/);
  if (!m || m.index === undefined) return null;
  const size = parseInt(m[1], 10);
  const start = m.index + m[0].length;
  return resp.slice(start, start + size);
}
