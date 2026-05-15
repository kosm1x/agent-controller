/**
 * Pure RFC822 / MIME helpers for the email channel.
 *
 * No I/O — every function here is a pure transform, unit tested without a
 * network. The email channel is deliberately zero-dependency (codebase
 * invariant: no new deps without discussion), so IMAP/SMTP/MIME are
 * implemented as minimal raw protocol code rather than via libraries.
 *
 * Scope is intentionally narrow: the channel is owner-only, so we only ever
 * parse mail from one known sender — not a general-purpose MUA.
 *
 * Byte handling: raw socket payloads are read as a `latin1` string so bytes
 * survive 1:1. base64 / quoted-printable bodies decode from that directly;
 * unencoded 8-bit bodies are re-interpreted as UTF-8 in `decodeBody`.
 */

export interface ParsedEmail {
  /** Bare sender address, lowercased (display name stripped). */
  from: string;
  /** Decoded Subject header (RFC2047 decoded). */
  subject: string;
  /** Message-ID header, including angle brackets, or "". */
  messageId: string;
  /** In-Reply-To header, or "". */
  inReplyTo: string;
  /** References header, or "". */
  references: string;
  /** Parsed Date header, or the current time if absent/unparseable. */
  date: Date;
  /** Best-effort plain-text body with the quoted reply tail stripped. */
  text: string;
}

/**
 * Reject a value containing a CR or LF. RFC822 headers and SMTP envelope
 * commands are line-delimited, so an embedded CRLF in an address, subject or
 * message-id would let a crafted value inject extra headers or SMTP commands.
 * Every value that flows into a header line or a `MAIL FROM` / `RCPT TO` /
 * `EHLO` must pass through this first. The email channel is owner-only so this
 * is not currently reachable with attacker input, but the type system permits
 * it — this is the poka-yoke that closes the gap.
 */
export function assertNoCrlf(value: string, label: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(
      `${label} contains a CR or LF character — refusing to use it`,
    );
  }
}

/** Extract the bare address from a `Name <addr@x>` / `addr@x` header value. */
export function extractAddress(headerValue: string): string {
  const angle = headerValue.match(/<([^>]+)>/);
  const raw = (angle ? angle[1] : headerValue).trim();
  return raw.toLowerCase();
}

/** Decode RFC2047 encoded-words (`=?charset?B|Q?...?=`) found in headers. */
export function decodeRfc2047(input: string): string {
  // Adjacent encoded-words separated only by whitespace: the whitespace is
  // not part of the text and must be removed before decoding.
  const collapsed = input.replace(/\?=\s+=\?/g, "?==?");
  return collapsed.replace(
    /=\?[^?]+\?([BbQq])\?([^?]*)\?=/g,
    (_match, enc: string, data: string) => {
      try {
        if (enc.toUpperCase() === "B") {
          return Buffer.from(data, "base64").toString("utf8");
        }
        // Q-encoding: `_` is space, `=XX` is a hex byte.
        const q = data
          .replace(/_/g, " ")
          .replace(/=([0-9A-Fa-f]{2})/g, (_x, h: string) =>
            String.fromCharCode(parseInt(h, 16)),
          );
        return Buffer.from(q, "latin1").toString("utf8");
      } catch {
        return data;
      }
    },
  );
}

/** Encode a string as an RFC2047 encoded-word, but only if it has non-ASCII. */
export function encodeRfc2047(input: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(input)) return input;
  return `=?UTF-8?B?${Buffer.from(input, "utf8").toString("base64")}?=`;
}

/** Decode a quoted-printable body (latin1-byte string in, UTF-8 string out). */
export function decodeQuotedPrintable(input: string): string {
  const noSoftBreaks = input.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < noSoftBreaks.length; i++) {
    const c = noSoftBreaks[i];
    if (c === "=" && i + 2 < noSoftBreaks.length) {
      const hex = noSoftBreaks.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    bytes.push(c.charCodeAt(0) & 0xff);
  }
  return Buffer.from(bytes).toString("utf8");
}

/** Decode a base64 body (whitespace tolerant). */
export function decodeBase64Body(input: string): string {
  return Buffer.from(input.replace(/\s+/g, ""), "base64").toString("utf8");
}

/**
 * Parse a raw header block into a lowercase-keyed map. Folded headers
 * (continuation lines starting with whitespace) are unfolded. On duplicate
 * header names the first occurrence wins.
 */
export function parseHeaders(rawHeaders: string): Map<string, string> {
  const map = new Map<string, string>();
  const unfolded = rawHeaders.replace(/\r?\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (name && !map.has(name)) map.set(name, value);
  }
  return map;
}

/** Crude HTML→text fallback for messages with no text/plain part. */
function stripHtml(html: string): string {
  return html
    .replace(/<\s*(br|\/p|\/div|\/tr|\/li)\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Decode a single MIME body given its transfer encoding + content type. */
function decodeBody(body: string, cte: string, contentType: string): string {
  let decoded: string;
  if (cte === "base64") {
    decoded = decodeBase64Body(body);
  } else if (cte === "quoted-printable") {
    decoded = decodeQuotedPrintable(body);
  } else {
    // 7bit / 8bit / binary: body is a latin1-byte string — re-read as UTF-8.
    decoded = Buffer.from(body, "latin1").toString("utf8");
  }
  if (/text\/html/i.test(contentType)) return stripHtml(decoded);
  return decoded;
}

/** Walk a multipart body and return the best plain-text representation. */
function extractTextPart(body: string, boundary: string): string {
  const segments = body.split("--" + boundary);
  let plain: string | null = null;
  let htmlFallback: string | null = null;

  for (const segment of segments) {
    const sep = segment.match(/\r?\n\r?\n/);
    if (!sep || sep.index === undefined) continue;
    const partHeaders = parseHeaders(segment.slice(0, sep.index));
    const partType = partHeaders.get("content-type") ?? "text/plain";
    const partCte = (
      partHeaders.get("content-transfer-encoding") ?? "7bit"
    ).toLowerCase();
    const partBody = segment.slice(sep.index + sep[0].length);

    const nested = partType.match(/boundary="?([^";]+)"?/i);
    if (/multipart\//i.test(partType) && nested) {
      const inner = extractTextPart(partBody, nested[1]);
      if (inner && plain === null) plain = inner;
      continue;
    }
    if (/text\/plain/i.test(partType)) {
      plain = decodeBody(partBody, partCte, partType);
      break;
    }
    if (/text\/html/i.test(partType) && htmlFallback === null) {
      htmlFallback = decodeBody(partBody, partCte, partType);
    }
  }
  return (plain ?? htmlFallback ?? "").trim();
}

/**
 * Strip the quoted-reply tail from a plain-text body: quoted (`>`) lines and
 * everything after a reply attribution line ("On … wrote:" / "El … escribió:"
 * / "-----Original Message-----").
 */
export function stripQuotedReply(text: string): string {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (
      /^\s*On\b.+\bwrote:\s*$/.test(line) ||
      /^\s*El\b.+\bescribi[oó]:\s*$/.test(line) ||
      /^\s*-{2,}\s*Original Message\s*-{2,}/i.test(line)
    ) {
      break;
    }
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  return out.join("\n").trim();
}

/** Parse a raw RFC822 message (latin1-byte string) into a `ParsedEmail`. */
export function parseEmail(raw: string): ParsedEmail {
  const sep = raw.match(/\r?\n\r?\n/);
  const splitIdx = sep && sep.index !== undefined ? sep.index : raw.length;
  const rawHeaders = raw.slice(0, splitIdx);
  const body = sep ? raw.slice(splitIdx + sep[0].length) : "";
  const headers = parseHeaders(rawHeaders);

  const contentType = headers.get("content-type") ?? "text/plain";
  const cte = (
    headers.get("content-transfer-encoding") ?? "7bit"
  ).toLowerCase();

  let text: string;
  const boundary = contentType.match(/boundary="?([^";]+)"?/i);
  if (/multipart\//i.test(contentType) && boundary) {
    text = extractTextPart(body, boundary[1]);
  } else {
    text = decodeBody(body, cte, contentType);
  }

  const dateRaw = headers.get("date");
  const parsedDate = dateRaw ? new Date(dateRaw) : new Date();

  return {
    from: extractAddress(decodeRfc2047(headers.get("from") ?? "")),
    subject: decodeRfc2047(headers.get("subject") ?? ""),
    messageId: headers.get("message-id") ?? "",
    inReplyTo: headers.get("in-reply-to") ?? "",
    references: headers.get("references") ?? "",
    date: isNaN(parsedDate.getTime()) ? new Date() : parsedDate,
    text: stripQuotedReply(text),
  };
}

/** Wrap a base64 string at 76 characters per line (RFC2045). */
export function wrapBase64(b64: string): string {
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) {
    lines.push(b64.slice(i, i + 76));
  }
  return lines.join("\r\n");
}

/** Generate a unique Message-ID for an outbound message. */
export function generateMessageId(domain: string): string {
  const rand = Math.random().toString(36).slice(2, 12);
  return `<${Date.now()}.${rand}@${domain || "localhost"}>`;
}

export interface OutboundMime {
  from: string;
  to: string;
  subject: string;
  body: string;
  messageId: string;
  inReplyTo?: string;
  references?: string;
  date?: Date;
}

/**
 * Build a complete RFC822 message: UTF-8 plain-text body, base64
 * Content-Transfer-Encoding (sidesteps dot-stuffing / bare-LF / line-length
 * pitfalls). Lines are CRLF-terminated.
 */
export function buildMimeMessage(opts: OutboundMime): string {
  // Guard every value that lands on a header line — a CRLF here would inject
  // arbitrary headers into the outbound message.
  assertNoCrlf(opts.from, "MIME From");
  assertNoCrlf(opts.to, "MIME To");
  assertNoCrlf(opts.subject, "MIME Subject");
  assertNoCrlf(opts.messageId, "MIME Message-ID");
  if (opts.inReplyTo) assertNoCrlf(opts.inReplyTo, "MIME In-Reply-To");
  if (opts.references) assertNoCrlf(opts.references, "MIME References");

  const date = (opts.date ?? new Date()).toUTCString().replace(/GMT$/, "+0000");
  const lines: string[] = [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Subject: ${encodeRfc2047(opts.subject)}`,
    `Date: ${date}`,
    `Message-ID: ${opts.messageId}`,
  ];
  if (opts.inReplyTo) lines.push(`In-Reply-To: ${opts.inReplyTo}`);
  if (opts.references) lines.push(`References: ${opts.references}`);
  // RFC 3834: an auto-responder MUST flag its replies so other auto-responders
  // do not reply back. Without this, two cooperating Jarvis instances (or
  // Jarvis + an Outlook out-of-office, or Jarvis + a vacation responder) loop
  // forever. `Auto-Submitted: auto-replied` is the canonical signal;
  // `Precedence: bulk` is the legacy form some MTAs still honour.
  lines.push("Auto-Submitted: auto-replied");
  lines.push("Precedence: bulk");
  lines.push("MIME-Version: 1.0");
  lines.push("Content-Type: text/plain; charset=utf-8");
  lines.push("Content-Transfer-Encoding: base64");
  lines.push("");
  lines.push(wrapBase64(Buffer.from(opts.body, "utf8").toString("base64")));
  return lines.join("\r\n");
}
