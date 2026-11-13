/**
 * A mailbox password reaches the user only when this run proved it.
 *
 * The agent manages mailboxes with a command-line tool that prints a password
 * only after a real login with it. A password the agent repeats from the
 * conversation may already have been replaced. So the check works on the
 * VALUE, never on the wording around it: a value the mailbox tool has ever
 * printed ("seen", mailbox-passwords.ts) may appear in a reply only when it
 * is also "proven" — printed by the mailbox tool in THIS run, or
 * typed by the user in this turn's message. Anything else in a reply is
 * never touched: no labels, no address rule, no layout rules.
 *
 * Candidates: the maximal runs of ASCII letters and digits of length 16–64
 * (what the tool generates), found in one linear pass with no pattern
 * engine. A longer run is not a candidate, so a seen value inside a longer
 * letter/digit run is left alone. Formatting around a value (backticks,
 * table cells, fences, bold, HTML tags) needs no handling: its delimiters
 * are not letters or digits.
 *
 * Fail: every seen-and-unproven occurrence is replaced by
 * `PASSWORD_WITHHELD_PLACEHOLDER` and `PASSWORD_WITHHELD_LINE` is appended
 * once. The line goes with every delivered placeholder, also one the check
 * did not put there (a durable store keeps only the placeholder, and a reply
 * built from stored text repeats it). Never blocked, never an error, never a
 * second model call.
 * Idempotent: the placeholder and the line hold no candidate.
 *
 * Pure: no store, no log. Values are compared by fingerprint
 * (`passwordFingerprint`); callers log and trace counts only.
 *
 * Known limits (stated, not solved):
 *   - a value the tool printed before this code existed is not seen until
 *     the tool prints it again;
 *   - a value the tool never printed is never touched;
 *   - only the reply is checked: text a tool sends or writes elsewhere is
 *     outside this check;
 *   - it protects against handing over a password that was not just
 *     confirmed; it is not a confidentiality control (which is why a partial
 *     value may flash in a stream before the hold); stored text keeps only
 *     the placeholder, never a seen value (store-withhold.ts);
 *   - a placeholder quoted from someone else's text (a mail body, a page a
 *     tool read, a user typing it) also gets the line: it adds a sentence and
 *     never changes what is withheld;
 *   - streaming: the live message is reset as soon as a seen-and-unproven
 *     value is in the streamed text, so the value can be on screen for a
 *     moment before the reset; the final message is always the checked
 *     text. The stream is not buffered.
 */

import { createHash } from "node:crypto";
import { PASSWORD_WITHHELD_PREFIX } from "./ledger-lines.js";

export const PASSWORD_MIN_LEN = 16;
export const PASSWORD_MAX_LEN = 64;

export const PASSWORD_WITHHELD_PLACEHOLDER = "[contraseña retenida]";

/** The one line appended whenever a checked text holds the placeholder. */
export const PASSWORD_WITHHELD_LINE = `${PASSWORD_WITHHELD_PREFIX} con la herramienta en esta respuesta lo que marqué como ${PASSWORD_WITHHELD_PLACEHOLDER} y lo retuve; cuando me lo vuelvas a pedir, lo leeré con la herramienta antes de contestar.`;

const FINGERPRINT_PREFIX = "mission-control/mailbox-password/v1:";

/** sha256 hex of a fixed prefix + the value: stored, never the value. */
export function passwordFingerprint(value: string): string {
  return createHash("sha256")
    .update(FINGERPRINT_PREFIX + value)
    .digest("hex");
}

function isAsciiAlnum(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122)
  );
}

const BACKSLASH = 92;
const LOWER_U = 117;
/** A `\uXXXX` escape: `u` and four hex digits before the value. */
const UNICODE_ESCAPE_LEN = 5;
/** The longest run that can hold a candidate (a `\uXXXX` escape + 64). */
const RUN_REACH = PASSWORD_MAX_LEN + UNICODE_ESCAPE_LEN;

function isHexDigit(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 70) ||
    (code >= 97 && code <= 102)
  );
}

function isCandidateLen(len: number): boolean {
  return len >= PASSWORD_MIN_LEN && len <= PASSWORD_MAX_LEN;
}

export interface CandidateRun {
  start: number;
  end: number;
}

/**
 * Maximal letter/digit runs of length 16–64 that end at or after `from`.
 * A run directly after a backslash may start with an escape (`\n`, `\t`,
 * `é` in an encoded text), so it also yields, in this order and each
 * only when its length is 16–64: the run without its first character, and,
 * when the run starts with a lowercase `u` and four hex digits, the run
 * without its first five. At most three candidates per run, all ending
 * where the run ends. So after a backslash: a run of 16 yields only itself;
 * of 17, itself and the 16 after its first character; of 65, only the 64
 * after its first character; after `\uXXXX`, a run of 21–69 also yields the
 * 16–64 after the escape.
 * A run cut by `from` is walked back to its start, at most 69 characters: a
 * walk that stops inside the run leaves 70 or more of it, which is too long
 * to hold a candidate even without five characters. Linear.
 */
export function candidateRuns(text: string, from = 0): CandidateRun[] {
  const out: CandidateRun[] = [];
  const n = text.length;
  let i = Math.max(0, Math.min(from, n));
  let back = 0;
  while (
    i > 0 &&
    back < RUN_REACH &&
    isAsciiAlnum(text.charCodeAt(i - 1))
  ) {
    i--;
    back++;
  }
  while (i < n) {
    if (!isAsciiAlnum(text.charCodeAt(i))) {
      i++;
      continue;
    }
    const start = i;
    while (i < n && isAsciiAlnum(text.charCodeAt(i))) i++;
    const len = i - start;
    if (isCandidateLen(len)) out.push({ start, end: i });
    if (start === 0 || text.charCodeAt(start - 1) !== BACKSLASH) continue;
    if (isCandidateLen(len - 1)) out.push({ start: start + 1, end: i });
    if (
      isCandidateLen(len - UNICODE_ESCAPE_LEN) &&
      text.charCodeAt(start) === LOWER_U &&
      isHexDigit(text.charCodeAt(start + 1)) &&
      isHexDigit(text.charCodeAt(start + 2)) &&
      isHexDigit(text.charCodeAt(start + 3)) &&
      isHexDigit(text.charCodeAt(start + 4))
    ) {
      out.push({ start: start + UNICODE_ESCAPE_LEN, end: i });
    }
  }
  return out;
}

/** Fingerprints of every candidate in a text (the user's own message). */
export function candidateFingerprints(text: string): string[] {
  return candidateRuns(text).map((r) =>
    passwordFingerprint(text.slice(r.start, r.end)),
  );
}

/** What the check asks about a fingerprint; never sees a value. */
export interface PasswordValueCheck {
  isSeen(fingerprint: string): boolean;
  isProven(fingerprint: string): boolean;
}

/**
 * True when the text, from `from` on, holds a seen-and-unproven value (the
 * stream hold). The seen store is asked only when a candidate exists.
 */
export function hasUnprovenValue(
  text: string,
  check: PasswordValueCheck,
  from = 0,
): boolean {
  let seenUntil = 0;
  for (const r of candidateRuns(text, from)) {
    if (r.start < seenUntil) continue;
    const fp = passwordFingerprint(text.slice(r.start, r.end));
    if (!check.isSeen(fp)) continue;
    if (!check.isProven(fp)) return true;
    seenUntil = r.end;
  }
  return false;
}

export interface PasswordGateResult {
  text: string;
  /** Candidates found in the seen set. */
  checked: number;
  /** Of those, the occurrences replaced (seen and not proven). */
  withheld: number;
}

/**
 * Replaces each seen-and-unproven occurrence; appends nothing. When a full
 * run is seen, the shorter candidate inside it (a run after a backslash) is
 * not looked at: the full run decides.
 */
export function replaceUnprovenValues(
  text: string,
  check: PasswordValueCheck,
): PasswordGateResult {
  let checked = 0;
  let withheld = 0;
  let out = "";
  let last = 0;
  let seenUntil = 0;
  for (const r of candidateRuns(text)) {
    if (r.start < seenUntil) continue;
    const fp = passwordFingerprint(text.slice(r.start, r.end));
    if (!check.isSeen(fp)) continue;
    seenUntil = r.end;
    checked++;
    if (check.isProven(fp)) continue;
    withheld++;
    out += text.slice(last, r.start) + PASSWORD_WITHHELD_PLACEHOLDER;
    last = r.end;
  }
  if (withheld === 0) return { text, checked, withheld };
  return { text: out + text.slice(last), checked, withheld };
}

/** Appends the line unless the text already carries it. */
export function withPasswordWithheldLine(text: string): string {
  return text.includes(PASSWORD_WITHHELD_LINE)
    ? text
    : `${text}\n\n${PASSWORD_WITHHELD_LINE}`;
}

/**
 * `replaceUnprovenValues` plus the one line whenever the checked text holds
 * the placeholder: withheld here, or already in it (a stored text repeated).
 */
export function withholdUnprovenValues(
  text: string,
  check: PasswordValueCheck,
): PasswordGateResult {
  const res = replaceUnprovenValues(text, check);
  return res.text.includes(PASSWORD_WITHHELD_PLACEHOLDER)
    ? { ...res, text: withPasswordWithheldLine(res.text) }
    : res;
}
