/**
 * email-verify — SMTP reply classification.
 *
 * Improvement over the upstream Rust tool: RFC 3463 enhanced status codes
 * (`5.1.1`, `5.2.2`, …) are read STRUCTURALLY before any phrase matching.
 * The phrase table (ported, plus es-MX phrases) is only the fallback for
 * servers that speak in prose. Order inside the phrase fallback matters and
 * mirrors upstream: disabled → full inbox → rate-limited → invalid → blocked.
 */

export type ReplyKind =
  | "accepted"
  | "invalid"
  | "full_inbox"
  | "disabled"
  | "blocked" // our IP / HELO / sender was refused — a signal about US, not the mailbox
  | "greylisted"
  | "temp_failure"
  | "unknown_reply";

export interface SmtpReply {
  /** 3-digit reply code, e.g. 550. */
  readonly code: number;
  /** RFC 3463 enhanced code, e.g. "5.1.1"; null when absent. */
  readonly enhanced: string | null;
  /** Full reply text, lines joined with a space. */
  readonly text: string;
}

/** Enhanced code must lead the text (RFC 2034); a later "4.2.2.1" is an IP, not a code. */
const RE_ENHANCED = /^\s*(?:[-\s]*)?([245])\.(\d{1,3})\.(\d{1,3})\b/;
/** qmail/netqmail convention: the code trails in parentheses with a '#', e.g. "Invalid User (#5.1.1)". */
const RE_ENHANCED_QMAIL = /\(#([245])\.(\d{1,3})\.(\d{1,3})\b/;

/** Parse one complete (possibly multi-line) SMTP reply into its parts. */
export function parseReply(raw: string): SmtpReply {
  const lines = raw
    .split("\r\n")
    .filter((l) => l.length > 0);
  const first = lines[0] ?? "";
  const code = Number.parseInt(first.slice(0, 3), 10);
  const text = lines.map((l) => l.slice(4)).join(" ").trim();
  const m = RE_ENHANCED.exec(text.slice(0, 16)) ?? RE_ENHANCED_QMAIL.exec(text);
  return {
    code: Number.isFinite(code) ? code : 0,
    enhanced: m ? `${m[1]}.${m[2]}.${m[3]}` : null,
    text,
  };
}

const INVALID_PHRASES = [
  "address rejected", "unrouteable", "does not exist", "doesn't exist", "dosn't exist",
  "invalid address", "invalid email address", "invalid recipient", "may not exist",
  "recipient invalid", "recipient rejected", "unknown recipient", "undeliverable",
  "user unknown", "unknown user", "recipient unknown", "no such user", "user not found", "invalid user",
  "mailbox not found",
  "invalid mailbox", "no mailbox", "no such mailbox", "mailbox unavailable",
  "mailbox is unavailable", "not a valid mailbox", "no such recipient", "doesn't have an account",
  "does not have an account", "delivery error: dd", "no tiene una cuenta",
  "no tiene cuenta", "unknown local part", "no longer available", "address could not be found",
  "email address could not be found", "no such person", "address is not handled",
  "recipient is not exist", "recipient not found", "verify address failed", "unable to verify user",
  "utilisateur inconnu",
  // es-MX / es phrases seen on Mexican hosting MX (Hostinger, GoDaddy LatAm, Telmex)
  "usuario desconocido", "usuario no existe", "el usuario no existe", "destinatario desconocido",
  "destinatario no existe", "buzón no existe", "buzon no existe", "cuenta no existe",
  "la cuenta no existe", "direccion invalida", "dirección inválida", "no existe el usuario",
  "no existe el buzón", "no existe el buzon", "no existe la cuenta",
];

const FULL_PHRASES = [
  "insufficient storage for", "mailbox full", "mailbox is full", "quota exceeded", "quote exceeded", "over quota",
  "too many messages", "out of storage space", "buzón lleno", "buzon lleno", "cuota excedida",
];

const DISABLED_PHRASES = ["disabled", "discontinued", "inactive", "suspended", "deshabilitad", "inactiv", "suspendid"];

/**
 * A 5xx that talks about the SENDER, our HELO, our IP or its reputation is a
 * verdict about us, never about the mailbox — checked before every other
 * table (audit C2, 2026-09-11: "5.7.1 sender domain could not be found" was
 * being reported as an invalid recipient). Every entry is ANCHORED to its
 * sentence: bare tokens like "relay" or "access denied" swallowed Postfix
 * "User unknown in relay recipient table" and Office 365 "Recipient address
 * rejected: Access denied" (audit R2 C-1).
 */
const SENDER_SIDE_PHRASES = [
  "sender address rejected", "sender rejected", "sender domain", "sender verify", "sender address error",
  "invalid sender", "bad sender", "remitente", "mail from:", "spf", "dkim", "dmarc", "helo command",
  "helo/ehlo", "helo name", "helo hostname", "invalid helo", "ehlo command", "reverse dns",
  "reverse hostname", "reverse host", "your hostname", "rdns", "ptr record", "registro ptr", "your ip",
  "su ip", "client host rejected", "client host blocked", "client host [", "your server", "su servidor",
  "sending mta", "reputation", "reputación", "reputacion", "lista blanca", "lista negra", "not whitelisted",
  "whitelisted", "blacklist", "black list", "blocklist", "block list", "dnsbl", "spamhaus", "spamcop",
  "abusix", "unable to relay", "relaying denied", "relay access denied", "relay not permitted",
  "not permitted to relay", "not allowed to relay", "administratively denied", "connection rejected",
  "junkmail", "refused by proofpoint", "sbrs score", "not yet authorized", "poor reputation",
  "authentication required", "not authenticated", "authenticated users", "authentication information",
  "must authenticate", "must have an account",
];

const BLOCKED_PHRASES = [
  ...SENDER_SIDE_PHRASES,
  "as spam", "spam detected", "spam source", "spam block", "spam list", "listed as spam",
  "blocked using", "host blocked", "ip blocked", "ip is blocked", "ip address blocked",
  "ip address is blocked", "blocked by", "ip banned", "host banned", "banned ip", "you are banned",
];

const GREYLIST_PHRASES = ["greylist", "grey list", "graylist", "try again", "try later", "retry", "come back later"];

/**
 * "This user doesn't have a yahoo.com account" — the domain sits mid-phrase.
 * Subject-anchored (user/recipient/address/…): "Sender does not have a mailbox"
 * must never read as a dead recipient (audit R5 C-1).
 */
const RE_NO_ACCOUNT =
  /(?:this |the |el |la |este )?(?:user|recipient|address|mailbox|e-?mail|usuario|destinatario|cuenta) (?:doesn'?t|does not|no) (?:have|tiene) (?:an? |una |un )?(?:(?:[\w-]+\.)+[a-z]{2,} )?(?:account|mailbox|buz[oó]n|cuenta)/;

function has(text: string, phrases: readonly string[]): boolean {
  return phrases.some((p) => text.includes(p));
}

/**
 * Classify a reply to RCPT TO (or MAIL FROM / EHLO — see `classifyEnvelope`).
 * Pure function; every branch is unit-tested against real-world replies.
 */
export function classifyRcpt(reply: SmtpReply): ReplyKind {
  const { code, enhanced } = reply;
  const text = reply.text.toLowerCase();
  const cls = Math.floor(code / 100);

  if (cls === 2) return "accepted";

  // A 4xx or 5xx about the sender / our host is "blocked" whatever code it
  // carries (Postfix's rDNS refusal is "450 4.7.25 Client host rejected: cannot
  // find your hostname" — a temporary code, but still a signal to stop probing).
  if (has(text, SENDER_SIDE_PHRASES)) return "blocked";

  // 4xx is transient by definition: it can mean "full" or "slow down", never "does not exist".
  if (cls === 4) {
    if (enhanced === "4.2.2" || has(text, FULL_PHRASES)) return "full_inbox";
    if (text.includes("receiving mail at a rate that")) return "accepted";
    return has(text, GREYLIST_PHRASES) ? "greylisted" : "temp_failure";
  }

  if (enhanced) {
    const [, subject, detail] = enhanced.split(".");
    // 5.1.x — addressing status. 5.1.7/5.1.8 are about the SENDER (us).
    if (subject === "1") return detail === "7" || detail === "8" ? "blocked" : "invalid";
    // 5.2.x — mailbox status
    if (subject === "2") {
      if (detail === "1") return "disabled";
      if (detail === "2") return "full_inbox";
      return has(text, INVALID_PHRASES) ? "invalid" : "unknown_reply";
    }
    // 5.7.x — security / policy. Some hosts use 5.7.1 for "user doesn't exist",
    // so (absent a sender-side token, handled above) explicit mailbox phrases
    // still win; anything else is about us.
    if (subject === "7") {
      if (has(text, BLOCKED_PHRASES)) return "blocked";
      if (has(text, DISABLED_PHRASES)) return "disabled";
      if (has(text, INVALID_PHRASES) || RE_NO_ACCOUNT.test(text)) return "invalid";
      return "blocked";
    }
    // Other 5.x.x — fall through to the phrase table.
  }

  if (has(text, DISABLED_PHRASES)) return "disabled";
  if (has(text, FULL_PHRASES)) return "full_inbox";
  if (has(text, BLOCKED_PHRASES)) return "blocked";
  if (has(text, INVALID_PHRASES) || RE_NO_ACCOUNT.test(text)) return "invalid";
  return "unknown_reply";
}

/**
 * Classify a non-2xx reply to the banner, EHLO/HELO or MAIL FROM. These
 * never say anything about the mailbox; they say the host is busy (4xx) or
 * refusing us (5xx).
 */
export function classifyEnvelope(reply: SmtpReply): "blocked" | "greylisted" | "temp_failure" {
  const text = reply.text.toLowerCase();
  if (has(text, SENDER_SIDE_PHRASES)) return "blocked";
  if (Math.floor(reply.code / 100) === 4) {
    return has(text, GREYLIST_PHRASES) ? "greylisted" : "temp_failure";
  }
  return "blocked";
}
