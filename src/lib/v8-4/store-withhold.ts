/**
 * Store rule for mailbox passwords: a value the mailbox tool has printed (its
 * fingerprint is in the seen set, mailbox-passwords.ts) is never written to a
 * durable store. Every writer of stored text passes it through here and the
 * value becomes PASSWORD_WITHHELD_PLACEHOLDER, whether or not this run proved
 * it: proof decides what the reply shows (password-gate.ts, consumer.ts), not
 * what is kept. A stored record that holds the placeholder sends a later
 * request for the value back to the tool. No line is added here.
 *
 * Leaf on purpose: no database import. mailbox-passwords.ts injects the seen
 * check at module load; in a process that never loads it, nothing is changed.
 * With an empty seen set the text comes back as the same string, unscanned.
 * Never throws into a write: a failing seen check writes the text as before
 * and warns once (a fixed line, no value, no count).
 */

import { replaceUnprovenValues } from "./password-gate.js";

/** The seen set as the store rule asks it; fingerprints only, never values. */
export interface StoreSeenCheck {
  size(): number;
  has(fingerprint: string): boolean;
}

let seenCheck: StoreSeenCheck | null = null;
let failureWarned = false;

/** Called by mailbox-passwords.ts at module load (and by tests). */
export function setStoreSeenCheck(check: StoreSeenCheck | null): void {
  seenCheck = check;
}

function warnOnce(): void {
  if (failureWarned) return;
  failureWarned = true;
  console.warn(
    "[v8-4] store-withhold check failed — text written as before (further failures not logged)",
  );
}

const NEVER_PROVEN = (): boolean => false;

/** The text with every seen value replaced by the placeholder. */
export function withholdForStore(text: string): string {
  const check = seenCheck;
  if (!check) return text;
  try {
    if (check.size() === 0) return text;
    return replaceUnprovenValues(text, {
      isSeen: (fp) => check.has(fp),
      isProven: NEVER_PROVEN,
    }).text;
  } catch {
    warnOnce();
    return text;
  }
}

/**
 * JSON.stringify replacer: string VALUES pass withholdForStore; keys and
 * non-string values are returned as they are, so the output always parses.
 */
export function storeReplacer(_key: string, value: unknown): unknown {
  return typeof value === "string" ? withholdForStore(value) : value;
}

/** @internal test hook */
export function _resetStoreWithhold(): void {
  seenCheck = null;
  failureWarned = false;
}
