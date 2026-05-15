/**
 * Unit tests for the pure email MIME helpers. No network.
 */

import { describe, it, expect } from "vitest";
import {
  assertNoCrlf,
  extractAddress,
  decodeRfc2047,
  encodeRfc2047,
  decodeQuotedPrintable,
  decodeBase64Body,
  parseHeaders,
  stripQuotedReply,
  parseEmail,
  wrapBase64,
  generateMessageId,
  buildMimeMessage,
} from "./email-mime.js";

describe("assertNoCrlf", () => {
  it("accepts a clean value", () => {
    expect(() => assertNoCrlf("owner@example.com", "addr")).not.toThrow();
  });

  it("rejects an embedded CR", () => {
    expect(() => assertNoCrlf("a@b.com\rX-Evil: 1", "addr")).toThrow(
      /CR or LF/,
    );
  });

  it("rejects an embedded LF", () => {
    expect(() => assertNoCrlf("a@b.com\nRCPT TO:<x>", "addr")).toThrow(
      /CR or LF/,
    );
  });

  it("names the label in the error", () => {
    expect(() => assertNoCrlf("x\ny", "SMTP MAIL FROM")).toThrow(
      /SMTP MAIL FROM/,
    );
  });
});

describe("extractAddress", () => {
  it("pulls the address out of a Name <addr> header", () => {
    expect(extractAddress('"Jane Doe" <jane@example.com>')).toBe(
      "jane@example.com",
    );
  });

  it("handles a bare address", () => {
    expect(extractAddress("bob@example.com")).toBe("bob@example.com");
  });

  it("lowercases the result", () => {
    expect(extractAddress("Jane@Example.COM")).toBe("jane@example.com");
  });
});

describe("decodeRfc2047", () => {
  it("decodes a base64 encoded-word", () => {
    expect(decodeRfc2047("=?UTF-8?B?aG9sYQ==?=")).toBe("hola");
  });

  it("decodes a quoted-printable encoded-word", () => {
    expect(decodeRfc2047("=?UTF-8?Q?caf=C3=A9?=")).toBe("café");
  });

  it("joins adjacent encoded-words separated by whitespace", () => {
    expect(decodeRfc2047("=?UTF-8?B?aG9s?= =?UTF-8?B?YQ==?=")).toBe("hola");
  });

  it("leaves plain text untouched", () => {
    expect(decodeRfc2047("plain subject")).toBe("plain subject");
  });
});

describe("encodeRfc2047", () => {
  it("leaves ASCII untouched", () => {
    expect(encodeRfc2047("hello world")).toBe("hello world");
  });

  it("encodes non-ASCII as a base64 encoded-word", () => {
    const encoded = encodeRfc2047("café");
    expect(encoded).toMatch(/^=\?UTF-8\?B\?.+\?=$/);
    expect(decodeRfc2047(encoded)).toBe("café");
  });
});

describe("decodeQuotedPrintable", () => {
  it("decodes hex escapes", () => {
    expect(decodeQuotedPrintable("caf=C3=A9")).toBe("café");
  });

  it("removes soft line breaks", () => {
    expect(decodeQuotedPrintable("line one =\r\nstill line one")).toBe(
      "line one still line one",
    );
  });
});

describe("decodeBase64Body", () => {
  it("decodes base64 ignoring whitespace", () => {
    expect(decodeBase64Body("aG9s\r\nYQ==")).toBe("hola");
  });
});

describe("parseHeaders", () => {
  it("parses simple headers into a lowercase-keyed map", () => {
    const h = parseHeaders("From: a@b.com\r\nSubject: Hi");
    expect(h.get("from")).toBe("a@b.com");
    expect(h.get("subject")).toBe("Hi");
  });

  it("unfolds continuation lines", () => {
    const h = parseHeaders("Subject: long\r\n  subject line");
    expect(h.get("subject")).toBe("long subject line");
  });

  it("keeps the first occurrence of a duplicated header", () => {
    const h = parseHeaders("X-Test: first\r\nX-Test: second");
    expect(h.get("x-test")).toBe("first");
  });
});

describe("stripQuotedReply", () => {
  it("drops quoted lines", () => {
    expect(stripQuotedReply("my reply\n> old text")).toBe("my reply");
  });

  it("cuts at an English attribution line", () => {
    const body = "thanks\n\nOn Mon, Jan 1, 2026 someone wrote:\n> hi";
    expect(stripQuotedReply(body)).toBe("thanks");
  });

  it("cuts at a Spanish attribution line", () => {
    const body = "gracias\n\nEl lun, 1 ene 2026, alguien escribió:\n> hola";
    expect(stripQuotedReply(body)).toBe("gracias");
  });
});

describe("parseEmail", () => {
  it("parses a simple plain-text message", () => {
    const raw =
      "From: Owner <owner@example.com>\r\n" +
      "Subject: Test\r\n" +
      "Message-ID: <abc@example.com>\r\n" +
      "Date: Wed, 14 May 2026 10:00:00 +0000\r\n" +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      "\r\n" +
      "Hello Jarvis\r\n";
    const mail = parseEmail(raw);
    expect(mail.from).toBe("owner@example.com");
    expect(mail.subject).toBe("Test");
    expect(mail.messageId).toBe("<abc@example.com>");
    expect(mail.text).toBe("Hello Jarvis");
  });

  it("decodes a base64 body", () => {
    const raw =
      "From: o@e.com\r\n" +
      "Content-Transfer-Encoding: base64\r\n" +
      "Content-Type: text/plain\r\n" +
      "\r\n" +
      Buffer.from("café body", "utf8").toString("base64");
    expect(parseEmail(raw).text).toBe("café body");
  });

  it("extracts the text/plain part from multipart/alternative", () => {
    const raw =
      "From: o@e.com\r\n" +
      'Content-Type: multipart/alternative; boundary="BND"\r\n' +
      "\r\n" +
      "--BND\r\n" +
      "Content-Type: text/plain\r\n" +
      "\r\n" +
      "plain version\r\n" +
      "--BND\r\n" +
      "Content-Type: text/html\r\n" +
      "\r\n" +
      "<p>html version</p>\r\n" +
      "--BND--\r\n";
    expect(parseEmail(raw).text).toBe("plain version");
  });

  it("falls back to stripped HTML when there is no text/plain part", () => {
    const raw =
      "From: o@e.com\r\n" +
      'Content-Type: multipart/alternative; boundary="BND"\r\n' +
      "\r\n" +
      "--BND\r\n" +
      "Content-Type: text/html\r\n" +
      "\r\n" +
      "<p>only html</p>\r\n" +
      "--BND--\r\n";
    expect(parseEmail(raw).text).toBe("only html");
  });

  it("strips the quoted reply from the body", () => {
    const raw =
      "From: o@e.com\r\n" +
      "Content-Type: text/plain\r\n" +
      "\r\n" +
      "my answer\r\n> quoted\r\n";
    expect(parseEmail(raw).text).toBe("my answer");
  });
});

describe("wrapBase64", () => {
  it("wraps at 76 characters per line", () => {
    const wrapped = wrapBase64("a".repeat(200));
    const lines = wrapped.split("\r\n");
    expect(lines[0].length).toBe(76);
    expect(lines[1].length).toBe(76);
    expect(lines[2].length).toBe(48);
  });
});

describe("generateMessageId", () => {
  it("produces an angle-bracketed id on the given domain", () => {
    const id = generateMessageId("example.com");
    expect(id).toMatch(/^<\d+\.[a-z0-9]+@example\.com>$/);
  });

  it("produces unique ids", () => {
    expect(generateMessageId("x.com")).not.toBe(generateMessageId("x.com"));
  });
});

describe("buildMimeMessage", () => {
  it("builds a threaded reply with all required headers", () => {
    const mime = buildMimeMessage({
      from: "jarvis@example.com",
      to: "owner@example.com",
      subject: "Re: Test",
      body: "the answer",
      messageId: "<new@example.com>",
      inReplyTo: "<orig@example.com>",
      references: "<orig@example.com>",
    });
    expect(mime).toContain("From: jarvis@example.com");
    expect(mime).toContain("To: owner@example.com");
    expect(mime).toContain("Subject: Re: Test");
    expect(mime).toContain("In-Reply-To: <orig@example.com>");
    expect(mime).toContain("References: <orig@example.com>");
    expect(mime).toContain("Content-Transfer-Encoding: base64");
    // body is base64 encoded after the blank line
    const body = mime.split("\r\n\r\n")[1];
    expect(Buffer.from(body, "base64").toString("utf8")).toBe("the answer");
  });

  it("rejects a header value containing a CRLF (injection guard)", () => {
    expect(() =>
      buildMimeMessage({
        from: "j@e.com",
        to: "o@e.com\r\nBcc: attacker@evil.com",
        subject: "ok",
        body: "x",
        messageId: "<x@e.com>",
      }),
    ).toThrow(/CR or LF/);
    expect(() =>
      buildMimeMessage({
        from: "j@e.com",
        to: "o@e.com",
        subject: "ok\r\nX-Injected: 1",
        body: "x",
        messageId: "<x@e.com>",
      }),
    ).toThrow(/CR or LF/);
  });

  it("emits RFC 3834 auto-reply markers on every outbound", () => {
    // Without these headers, sending a reply to an Outlook out-of-office or
    // another auto-responder loops forever. Incident 2026-05-15 was triggered
    // by a single send that bounced and the bounce was answered.
    const mime = buildMimeMessage({
      from: "a@x.com",
      to: "b@x.com",
      subject: "test",
      body: "hi",
      messageId: "<x@x.com>",
    });
    expect(mime).toMatch(/^Auto-Submitted: auto-replied$/m);
    expect(mime).toMatch(/^Precedence: bulk$/m);
  });

  it("round-trips a non-ASCII body and subject", () => {
    const mime = buildMimeMessage({
      from: "j@e.com",
      to: "o@e.com",
      subject: "Café ☕",
      body: "respuesta en español",
      messageId: "<x@e.com>",
    });
    const subjectLine = mime
      .split("\r\n")
      .find((l) => l.startsWith("Subject:"))!;
    expect(decodeRfc2047(subjectLine.replace("Subject: ", ""))).toBe("Café ☕");
    const body = mime.split("\r\n\r\n")[1];
    expect(Buffer.from(body, "base64").toString("utf8")).toBe(
      "respuesta en español",
    );
  });
});
