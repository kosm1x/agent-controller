/**
 * Unit tests for the multi-mailbox config parser, adapter identity, and the
 * raw IMAP/SMTP protocol-frame parsers. No network — parseEmailAccounts() is
 * pure over process.env, the EmailAdapter constructor only assigns fields, and
 * the frame parsers are pure string functions. The networked paths (poll/send)
 * are covered by the live round-trip test, not here.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EmailAdapter,
  extractFetchLiteral,
  imapQuote,
  imapTaggedEnd,
  isAutoReplyOrBounce,
  parseEmailAccounts,
  smtpReplyEnd,
} from "./email.js";
import { parseEmail } from "../email-mime.js";

/** Env keys this suite touches — cleared around every test for isolation. */
const EMAIL_KEYS = [
  "EMAIL_ACCOUNTS",
  "EMAIL_COMUNIDADES_IMAP_HOST",
  "EMAIL_COMUNIDADES_IMAP_PORT",
  "EMAIL_COMUNIDADES_SMTP_HOST",
  "EMAIL_COMUNIDADES_SMTP_PORT",
  "EMAIL_COMUNIDADES_USERNAME",
  "EMAIL_COMUNIDADES_PASSWORD",
  "EMAIL_COMUNIDADES_ADDRESS",
  "EMAIL_COMUNIDADES_OWNER_ADDRESS",
  "EMAIL_COMUNIDADES_POLL_INTERVAL_MS",
  "EMAIL_COMUNIDADES_MODE",
  "EMAIL_PROYECTO2_IMAP_HOST",
  "EMAIL_PROYECTO2_SMTP_HOST",
  "EMAIL_PROYECTO2_USERNAME",
  "EMAIL_PROYECTO2_PASSWORD",
  "EMAIL_PROYECTO2_OWNER_ADDRESS",
  "EMAIL_PROYECTO2_MODE",
];

function clearEmailEnv(): void {
  for (const k of EMAIL_KEYS) delete process.env[k];
}

/** Set a full, valid block for the `comunidades` account. */
function setComunidades(overrides: Record<string, string> = {}): void {
  process.env.EMAIL_COMUNIDADES_IMAP_HOST = "imap.hostinger.com";
  process.env.EMAIL_COMUNIDADES_SMTP_HOST = "smtp.hostinger.com";
  process.env.EMAIL_COMUNIDADES_USERNAME = "comunidades@mexiconecesario.org.mx";
  process.env.EMAIL_COMUNIDADES_PASSWORD = "app-password";
  process.env.EMAIL_COMUNIDADES_OWNER_ADDRESS = "Owner@Example.com";
  for (const [k, v] of Object.entries(overrides)) process.env[k] = v;
}

beforeEach(clearEmailEnv);
afterEach(clearEmailEnv);

describe("parseEmailAccounts", () => {
  it("throws when EMAIL_ACCOUNTS is missing", () => {
    expect(() => parseEmailAccounts()).toThrow(/EMAIL_ACCOUNTS is required/);
  });

  it("throws when EMAIL_ACCOUNTS is only whitespace/commas", () => {
    process.env.EMAIL_ACCOUNTS = " , ,";
    expect(() => parseEmailAccounts()).toThrow(/no usable account ids/);
  });

  it("throws on an account id with invalid characters", () => {
    process.env.EMAIL_ACCOUNTS = "bad-id";
    expect(() => parseEmailAccounts()).toThrow(/invalid.*\[a-z0-9_\]/);
  });

  it("throws on a duplicate account id", () => {
    process.env.EMAIL_ACCOUNTS = "comunidades,comunidades";
    setComunidades();
    expect(() => parseEmailAccounts()).toThrow(/listed twice/);
  });

  it("throws listing every missing required var for an account", () => {
    process.env.EMAIL_ACCOUNTS = "comunidades";
    // nothing else set
    expect(() => parseEmailAccounts()).toThrow(
      /missing required env vars.*IMAP_HOST.*SMTP_HOST.*USERNAME.*PASSWORD.*OWNER_ADDRESS/s,
    );
  });

  it("throws naming the one var that is missing (partial config)", () => {
    process.env.EMAIL_ACCOUNTS = "comunidades";
    setComunidades();
    delete process.env.EMAIL_COMUNIDADES_PASSWORD;
    expect(() => parseEmailAccounts()).toThrow(
      /missing required env vars: EMAIL_COMUNIDADES_PASSWORD$/,
    );
  });

  it("treats a whitespace-only required var as absent", () => {
    process.env.EMAIL_ACCOUNTS = "comunidades";
    setComunidades({ EMAIL_COMUNIDADES_USERNAME: "   " });
    expect(() => parseEmailAccounts()).toThrow(
      /missing required env vars: EMAIL_COMUNIDADES_USERNAME/,
    );
  });

  it("parses a valid single account and applies defaults", () => {
    process.env.EMAIL_ACCOUNTS = "comunidades";
    setComunidades();
    const [acct, ...rest] = parseEmailAccounts();
    expect(rest).toHaveLength(0);
    expect(acct).toEqual({
      id: "comunidades",
      imapHost: "imap.hostinger.com",
      imapPort: 993,
      smtpHost: "smtp.hostinger.com",
      smtpPort: 465,
      username: "comunidades@mexiconecesario.org.mx",
      password: "app-password",
      // fromAddress defaults to username
      fromAddress: "comunidades@mexiconecesario.org.mx",
      // mode defaults to owner-only
      mode: "owner-only",
      // owner address is lowercased
      ownerAddress: "owner@example.com",
      pollIntervalMs: 60_000,
    });
  });

  it("honours per-account overrides for ports, address and poll interval", () => {
    process.env.EMAIL_ACCOUNTS = "comunidades";
    setComunidades({
      EMAIL_COMUNIDADES_IMAP_PORT: "1993",
      EMAIL_COMUNIDADES_SMTP_PORT: "2465",
      EMAIL_COMUNIDADES_ADDRESS: "no-reply@mexiconecesario.org.mx",
      EMAIL_COMUNIDADES_POLL_INTERVAL_MS: "30000",
    });
    const [acct] = parseEmailAccounts();
    expect(acct?.imapPort).toBe(1993);
    expect(acct?.smtpPort).toBe(2465);
    expect(acct?.fromAddress).toBe("no-reply@mexiconecesario.org.mx");
    expect(acct?.pollIntervalMs).toBe(30_000);
  });

  it("parses multiple accounts and trims/lowercases the id list", () => {
    process.env.EMAIL_ACCOUNTS = " Comunidades , proyecto2 ";
    setComunidades();
    process.env.EMAIL_PROYECTO2_IMAP_HOST = "imap.hostinger.com";
    process.env.EMAIL_PROYECTO2_SMTP_HOST = "smtp.hostinger.com";
    process.env.EMAIL_PROYECTO2_USERNAME = "proyecto2@example.com";
    process.env.EMAIL_PROYECTO2_PASSWORD = "pw2";
    process.env.EMAIL_PROYECTO2_OWNER_ADDRESS = "owner@example.com";
    const accts = parseEmailAccounts();
    expect(accts.map((a) => a.id)).toEqual(["comunidades", "proyecto2"]);
  });

  it("throws on a present-but-non-numeric port (fail-fast on a typo)", () => {
    process.env.EMAIL_ACCOUNTS = "comunidades";
    setComunidades({ EMAIL_COMUNIDADES_IMAP_PORT: "not-a-number" });
    expect(() => parseEmailAccounts()).toThrow(
      /invalid EMAIL_COMUNIDADES_IMAP_PORT="not-a-number"/,
    );
  });

  it("throws on an out-of-range port", () => {
    process.env.EMAIL_ACCOUNTS = "comunidades";
    setComunidades({ EMAIL_COMUNIDADES_SMTP_PORT: "70000" });
    expect(() => parseEmailAccounts()).toThrow(
      /invalid EMAIL_COMUNIDADES_SMTP_PORT="70000"/,
    );
  });

  it("throws on a zero / negative poll interval", () => {
    process.env.EMAIL_ACCOUNTS = "comunidades";
    setComunidades({ EMAIL_COMUNIDADES_POLL_INTERVAL_MS: "0" });
    expect(() => parseEmailAccounts()).toThrow(
      /invalid EMAIL_COMUNIDADES_POLL_INTERVAL_MS="0"/,
    );
  });

  it("throws on a poll interval below the 10s floor", () => {
    process.env.EMAIL_ACCOUNTS = "comunidades";
    setComunidades({ EMAIL_COMUNIDADES_POLL_INTERVAL_MS: "5000" });
    expect(() => parseEmailAccounts()).toThrow(
      /invalid EMAIL_COMUNIDADES_POLL_INTERVAL_MS="5000"/,
    );
  });

  it("defaults to mode=owner-only when EMAIL_<ID>_MODE is unset", () => {
    process.env.EMAIL_ACCOUNTS = "comunidades";
    setComunidades();
    expect(parseEmailAccounts()[0]?.mode).toBe("owner-only");
  });

  it("accepts EMAIL_<ID>_MODE=community-manager", () => {
    process.env.EMAIL_ACCOUNTS = "comunidades";
    setComunidades({ EMAIL_COMUNIDADES_MODE: "community-manager" });
    expect(parseEmailAccounts()[0]?.mode).toBe("community-manager");
  });

  it("throws on an invalid EMAIL_<ID>_MODE value", () => {
    process.env.EMAIL_ACCOUNTS = "comunidades";
    setComunidades({ EMAIL_COMUNIDADES_MODE: "supervisor" });
    expect(() => parseEmailAccounts()).toThrow(
      /invalid EMAIL_COMUNIDADES_MODE="supervisor"/,
    );
  });

  it("makes OWNER_ADDRESS optional in community-manager mode", () => {
    process.env.EMAIL_ACCOUNTS = "comunidades";
    process.env.EMAIL_COMUNIDADES_IMAP_HOST = "imap.hostinger.com";
    process.env.EMAIL_COMUNIDADES_SMTP_HOST = "smtp.hostinger.com";
    process.env.EMAIL_COMUNIDADES_USERNAME =
      "comunidades@mexiconecesario.org.mx";
    process.env.EMAIL_COMUNIDADES_PASSWORD = "pw";
    process.env.EMAIL_COMUNIDADES_MODE = "community-manager";
    // no OWNER_ADDRESS
    const [acct] = parseEmailAccounts();
    expect(acct?.mode).toBe("community-manager");
    expect(acct?.ownerAddress).toBeNull();
  });

  it("still requires OWNER_ADDRESS in owner-only mode (explicit)", () => {
    process.env.EMAIL_ACCOUNTS = "comunidades";
    process.env.EMAIL_COMUNIDADES_IMAP_HOST = "imap.hostinger.com";
    process.env.EMAIL_COMUNIDADES_SMTP_HOST = "smtp.hostinger.com";
    process.env.EMAIL_COMUNIDADES_USERNAME =
      "comunidades@mexiconecesario.org.mx";
    process.env.EMAIL_COMUNIDADES_PASSWORD = "pw";
    process.env.EMAIL_COMUNIDADES_MODE = "owner-only";
    expect(() => parseEmailAccounts()).toThrow(
      /missing required env vars: EMAIL_COMUNIDADES_OWNER_ADDRESS/,
    );
  });

  it("lowercases the optional OWNER_ADDRESS in community-manager mode when set", () => {
    process.env.EMAIL_ACCOUNTS = "comunidades";
    setComunidades({
      EMAIL_COMUNIDADES_MODE: "community-manager",
      EMAIL_COMUNIDADES_OWNER_ADDRESS: "Escalation@Org.MX",
    });
    expect(parseEmailAccounts()[0]?.ownerAddress).toBe("escalation@org.mx");
  });

  it("throws when two accounts point at the same (host, username) mailbox", () => {
    process.env.EMAIL_ACCOUNTS = "comunidades,proyecto2";
    setComunidades();
    // proyecto2 reuses comunidades' IMAP host + username — same underlying
    // mailbox, would race to STORE \Seen and double-deliver.
    process.env.EMAIL_PROYECTO2_IMAP_HOST = "imap.hostinger.com";
    process.env.EMAIL_PROYECTO2_SMTP_HOST = "smtp.hostinger.com";
    process.env.EMAIL_PROYECTO2_USERNAME = "comunidades@mexiconecesario.org.mx";
    process.env.EMAIL_PROYECTO2_PASSWORD = "pw2";
    process.env.EMAIL_PROYECTO2_OWNER_ADDRESS = "owner@example.com";
    expect(() => parseEmailAccounts()).toThrow(/same mailbox/);
  });
});

describe("smtpReplyEnd", () => {
  it("finds the end of a single-line reply", () => {
    expect(smtpReplyEnd("250 OK\r\n")).toBe(8);
  });

  it("returns -1 on an incomplete line", () => {
    expect(smtpReplyEnd("250 OK")).toBe(-1);
  });

  it("skips continuation lines and ends on the final code-space line", () => {
    const buf = "250-first\r\n250-second\r\n250 done\r\n";
    expect(smtpReplyEnd(buf)).toBe(buf.length);
  });

  it("does not end on a continuation line alone", () => {
    expect(smtpReplyEnd("250-only\r\n")).toBe(-1);
  });
});

describe("imapTaggedEnd", () => {
  it("finds the end of a simple tagged OK response", () => {
    const buf = "* OK greeting\r\na1 OK LOGIN done\r\n";
    expect(imapTaggedEnd("a1", buf)).toBe(buf.length);
  });

  it("returns -1 when the tagged line has not arrived", () => {
    expect(imapTaggedEnd("a1", "* 1 EXISTS\r\n")).toBe(-1);
  });

  it("treats {n} literal bytes as opaque, including CRLF inside them", () => {
    // The literal payload contains its own CRLF — it must not be mistaken for
    // the end of the response line.
    const literal = "line1\r\nline2";
    const buf =
      `* 1 FETCH (BODY[] {${literal.length}}\r\n` +
      `${literal})\r\na2 OK FETCH\r\n`;
    expect(imapTaggedEnd("a2", buf)).toBe(buf.length);
  });

  it("returns -1 when a literal is announced but not fully buffered", () => {
    expect(imapTaggedEnd("a2", "* 1 FETCH (BODY[] {100}\r\nonly-partial")).toBe(
      -1,
    );
  });
});

describe("imapQuote", () => {
  it("wraps a plain string in double quotes", () => {
    expect(imapQuote("INBOX")).toBe('"INBOX"');
  });

  it("escapes embedded quotes and backslashes", () => {
    expect(imapQuote('a"b\\c')).toBe('"a\\"b\\\\c"');
  });
});

describe("extractFetchLiteral", () => {
  it("pulls the literal payload of the announced byte length", () => {
    const payload = "From: o@e.com\r\n\r\nbody";
    const resp =
      `* 1 FETCH (BODY[] {${payload.length}}\r\n` + `${payload})\r\na1 OK\r\n`;
    expect(extractFetchLiteral(resp)).toBe(payload);
  });

  it("returns null when there is no literal marker", () => {
    expect(extractFetchLiteral("a1 OK no literal here\r\n")).toBeNull();
  });
});

describe("EmailAdapter identity", () => {
  it("registers under the `email:<id>` channel name and exposes its owner + mode", () => {
    const adapter = new EmailAdapter({
      id: "comunidades",
      imapHost: "imap.hostinger.com",
      imapPort: 993,
      smtpHost: "smtp.hostinger.com",
      smtpPort: 465,
      username: "comunidades@mexiconecesario.org.mx",
      password: "pw",
      fromAddress: "comunidades@mexiconecesario.org.mx",
      mode: "owner-only",
      ownerAddress: "owner@example.com",
      pollIntervalMs: 60_000,
    });
    expect(adapter.name).toBe("email:comunidades");
    expect(adapter.ownerAddress).toBe("owner@example.com");
    expect(adapter.mode).toBe("owner-only");
    // Not yet polled — isConnected is false until the first successful poll.
    expect(adapter.isConnected()).toBe(false);
  });

  it("accepts community-manager mode with no owner address", () => {
    const adapter = new EmailAdapter({
      id: "comunidades",
      imapHost: "imap.hostinger.com",
      imapPort: 993,
      smtpHost: "smtp.hostinger.com",
      smtpPort: 465,
      username: "comunidades@mexiconecesario.org.mx",
      password: "pw",
      fromAddress: "comunidades@mexiconecesario.org.mx",
      mode: "community-manager",
      ownerAddress: null,
      pollIntervalMs: 60_000,
    });
    expect(adapter.mode).toBe("community-manager");
    expect(adapter.ownerAddress).toBeNull();
  });
});

describe("isAutoReplyOrBounce", () => {
  // Pinned because the 2026-05-15 incident was a bounce cascade where Jarvis
  // kept replying to MAILER-DAEMON. Each branch below corresponds to a
  // distinct way an MTA / OOO / auto-responder marks itself.
  const headers = (h: Record<string, string>) =>
    Object.entries(h)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\r\n") + "\r\n\r\nbody text";

  it("drops mailer-daemon by From local-part", () => {
    const raw = headers({
      From: "Mail Delivery System <MAILER-DAEMON@mailchannels.net>",
      Subject: "Undelivered Mail Returned to Sender",
    });
    expect(isAutoReplyOrBounce(parseEmail(raw), raw)).toBe(true);
  });

  it("drops postmaster", () => {
    const raw = headers({
      From: "postmaster@example.com",
      Subject: "Delivery Status Notification",
    });
    expect(isAutoReplyOrBounce(parseEmail(raw), raw)).toBe(true);
  });

  it("drops no-reply / noreply senders", () => {
    for (const sender of ["no-reply@x.com", "noreply@x.com"]) {
      const raw = headers({ From: sender, Subject: "Receipt" });
      expect(isAutoReplyOrBounce(parseEmail(raw), raw)).toBe(true);
    }
  });

  it("drops on Auto-Submitted header (RFC 3834)", () => {
    const raw = headers({
      From: "real-person@example.com",
      Subject: "Re: tu mensaje",
      "Auto-Submitted": "auto-replied",
    });
    expect(isAutoReplyOrBounce(parseEmail(raw), raw)).toBe(true);
  });

  it("allows Auto-Submitted: no (explicit human-sent)", () => {
    const raw = headers({
      From: "real@example.com",
      Subject: "Pregunta",
      "Auto-Submitted": "no",
    });
    expect(isAutoReplyOrBounce(parseEmail(raw), raw)).toBe(false);
  });

  it("drops on Precedence: bulk", () => {
    const raw = headers({
      From: "newsletter@x.com",
      Subject: "Newsletter",
      Precedence: "bulk",
    });
    expect(isAutoReplyOrBounce(parseEmail(raw), raw)).toBe(true);
  });

  it("drops on multipart/report Content-Type (RFC 3464 DSN)", () => {
    const raw = headers({
      From: "x@example.com",
      Subject: "Report",
      "Content-Type":
        'multipart/report; report-type=delivery-status; boundary="x"',
    });
    expect(isAutoReplyOrBounce(parseEmail(raw), raw)).toBe(true);
  });

  it("drops common bounce subject prefixes (EN + ES)", () => {
    const subjects = [
      "Undelivered Mail Returned to Sender",
      "Returned mail: see transcript for details",
      "Delivery Status Notification (Failure)",
      "Failure Notice",
      "Mail Delivery Failure",
      "Auto: Vacation",
      "Out of Office: back Monday",
      "Fuera de la oficina hasta el lunes",
      "Respuesta automática: estoy fuera",
      "Correo no entregado",
      "Notificación de estado de entrega",
    ];
    for (const s of subjects) {
      const raw = headers({ From: "x@example.com", Subject: s });
      expect(isAutoReplyOrBounce(parseEmail(raw), raw)).toBe(true);
    }
  });

  it("allows a normal community message", () => {
    const raw = headers({
      From: "vecina@example.com",
      Subject: "Pregunta sobre el programa de cuidadores",
    });
    expect(isAutoReplyOrBounce(parseEmail(raw), raw)).toBe(false);
  });

  it("body content that mentions 'auto-submitted' does not trigger the header check", () => {
    // A real sender quoting an old bounce report inline should not be dropped.
    // The check stops at the headers/body separator.
    const raw =
      headers({
        From: "real@example.com",
        Subject: "Quoting an old bounce",
      }) +
      "\r\n\r\nQuoted text:\r\nAuto-Submitted: auto-replied\r\nFrom: mailer-daemon@x";
    expect(isAutoReplyOrBounce(parseEmail(raw), raw)).toBe(false);
  });
});
