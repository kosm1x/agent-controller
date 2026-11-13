/**
 * The two fingerprint sets password-gate.ts checks a reply against.
 *
 * Seen (long-lived, survives restarts): a fingerprint of every password the
 * mailbox tool printed. Persisted as fingerprints only (table
 * `mailbox_password_seen`, schema migration v17), never the value; bounded
 * to the newest SEEN_MAX_ROWS rows. An in-process cache is loaded lazily from
 * the database in use and kept in step with every write. With no database
 * (a process that never opened one) the cache alone holds them.
 *
 * Proven (per task, memory only) lives in the leaf mailbox-proven.ts, so
 * numbers.ts can free it without importing the database; it is re-exported
 * here for the callers of this module.
 *
 * Registration (`registerMailboxResult`, called once from the tool
 * registry): only a `shell_exec` result whose command has a verifying
 * command as the program of a command segment (`namesVerifyingCommand`),
 * read from the JSON result's `stdout` (never `stderr`): every line
 * `password: <value>` → seen AND proven for the task. A value is registered
 * only when it is one run of 16–64 ASCII letters and digits; any other value
 * is ignored and counted. Never throws; logs counts only.
 *
 * Assumption: the verifying command prints a `password:` line only after it
 * has proven that value by a real login in the same call, so no cut of its
 * output (grep, head, tail) separates a value from its proof.
 * Known limit: another command in the same call that prints a `password:`
 * line would count; the check guards against answers from memory, not
 * against deliberate fabrication.
 */

import type Database from "better-sqlite3";
import { getDatabase } from "../../db/index.js";
import {
  _resetMailboxProven,
  recordProvenPasswords,
} from "./mailbox-proven.js";
import {
  PASSWORD_MAX_LEN,
  PASSWORD_MIN_LEN,
  passwordFingerprint,
  type PasswordValueCheck,
} from "./password-gate.js";

export {
  forgetProvenPasswords,
  provenPasswords,
  recordUserPasswordProof,
} from "./mailbox-proven.js";

/** Commands whose output proves a password (the program word, exactly). */
export const VERIFYING_COMMANDS: readonly string[] = ["stalwart-inbox"];

export const SEEN_MAX_ROWS = 5000;

const SEEN_TABLE = "mailbox_password_seen";
const PASSWORD_LINE = "password: ";

/** Outside quotes, each of these ends a command segment. */
const SEGMENT_ENDS = ";&|\n()";
/** Words skipped before a segment's program. */
const PREFIX_WORDS = new Set([
  "sudo",
  "env",
  "nice",
  "time",
  "command",
  "exec",
]);

/** `NAME=value`: a shell variable name, then `=`. */
function isAssignment(word: string): boolean {
  const eq = word.indexOf("=");
  if (eq <= 0) return false;
  for (let i = 0; i < eq; i++) {
    const c = word.charCodeAt(i);
    const ok =
      c === 95 ||
      (c >= 65 && c <= 90) ||
      (c >= 97 && c <= 122) ||
      (i > 0 && c >= 48 && c <= 57);
    if (!ok) return false;
  }
  return true;
}

/** The segment's program, as written, is a verifying command. */
function segmentRunsVerifying(segment: string): boolean {
  const words = segment.split(/\s+/).filter((w) => w.length > 0);
  let i = 0;
  while (i < words.length) {
    if (PREFIX_WORDS.has(words[i]) || isAssignment(words[i])) i++;
    else if (words[i] === "timeout") i += 2;
    else break;
  }
  if (i >= words.length) return false;
  const program = words[i].slice(words[i].lastIndexOf("/") + 1);
  return VERIFYING_COMMANDS.includes(program);
}

/** The index after any backslash-newline pairs starting at `i`. */
function afterContinuations(command: string, i: number): number {
  while (command[i] === "\\" && command[i + 1] === "\n") i += 2;
  return i;
}

/**
 * True when a verifying command is the PROGRAM of a command segment. One
 * pass tracks single and double quotes and backslash escapes; outside
 * quotes a segment ends at `;`, `&`, `|`, a newline, `(` or `)`. In each
 * segment the leading prefix words (`PREFIX_WORDS`, `NAME=value`, `timeout`
 * with the word after it) are skipped; the next word, without quote removal,
 * reduced to its basename, must equal a verifying name exactly. Outside
 * quotes, a `#` that starts a word begins a comment: the scan of that line
 * ends there (the text before it is still read); a backslash-newline does
 * not change whether a word starts. An unquoted `<<` (a here-document or
 * here-string, also when split by backslash-newlines) makes the whole
 * command non-qualifying: its
 * body is text, and the verifying command is never run with one. Linear.
 */
export function namesVerifyingCommand(command: string): boolean {
  let quote = "";
  let start = 0;
  let wordStart = true;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === "\\" && quote !== "'") {
      // The shell removes a backslash-newline: it does not change whether
      // the next character starts a word.
      if (command[i + 1] !== "\n") wordStart = false;
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      wordStart = false;
      continue;
    }
    if (ch === "<" && command[afterContinuations(command, i + 1)] === "<") {
      return false;
    }
    if (ch === "#" && wordStart) {
      if (segmentRunsVerifying(command.slice(start, i))) return true;
      const eol = command.indexOf("\n", i);
      if (eol < 0) return false;
      // Resume at the newline, which ends the (empty) segment after it.
      start = eol;
      i = eol - 1;
      continue;
    }
    if (SEGMENT_ENDS.includes(ch)) {
      if (segmentRunsVerifying(command.slice(start, i))) return true;
      start = i + 1;
      wordStart = true;
      continue;
    }
    wordStart = ch === " " || ch === "\t";
  }
  return segmentRunsVerifying(command.slice(start));
}

function isPasswordValue(value: string): boolean {
  if (value.length < PASSWORD_MIN_LEN || value.length > PASSWORD_MAX_LEN) {
    return false;
  }
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    const ok =
      (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
    if (!ok) return false;
  }
  return true;
}

// ── seen ───────────────────────────────────────────────────────────────────

let seenCache: Set<string> | null = null;
let seenCacheDb: Database.Database | null = null;

function currentDb(): Database.Database | null {
  try {
    return getDatabase();
  } catch {
    // No database opened in this process: the cache alone holds the set.
    return null;
  }
}

function loadSeen(db: Database.Database | null): Set<string> {
  const set = new Set<string>();
  if (!db) return set;
  const rows = db
    .prepare(`SELECT fingerprint FROM ${SEEN_TABLE} ORDER BY rowid`)
    .all() as Array<{ fingerprint: string }>;
  for (const r of rows) set.add(r.fingerprint);
  return set;
}

function seenSet(): Set<string> {
  const db = currentDb();
  if (seenCache && db === seenCacheDb) return seenCache;
  seenCache = loadSeen(db);
  seenCacheDb = db;
  return seenCache;
}

function rememberSeen(fingerprints: readonly string[]): void {
  if (fingerprints.length === 0) return;
  const set = seenSet();
  const db = seenCacheDb;
  // The cache first: a failed write still leaves this process withholding.
  for (const fp of fingerprints) set.add(fp);
  if (db) {
    const insert = db.prepare(
      `INSERT OR IGNORE INTO ${SEEN_TABLE} (fingerprint) VALUES (?)`,
    );
    db.transaction(() => {
      for (const fp of fingerprints) insert.run(fp);
    })();
  }
  if (set.size <= SEEN_MAX_ROWS) return;
  if (db) {
    db.prepare(
      `DELETE FROM ${SEEN_TABLE} WHERE rowid NOT IN (SELECT rowid FROM ${SEEN_TABLE} ORDER BY rowid DESC LIMIT ?)`,
    ).run(SEEN_MAX_ROWS);
    seenCache = loadSeen(db);
  } else {
    for (const fp of set) {
      if (set.size <= SEEN_MAX_ROWS) break;
      set.delete(fp);
    }
  }
}

export function isSeenPassword(fingerprint: string): boolean {
  return seenSet().has(fingerprint);
}

// ── check ──────────────────────────────────────────────────────────────────

/** The check for a task's reply: seen from the store, proven from the run. */
export function passwordCheckFor(
  proven: ReadonlySet<string>,
): PasswordValueCheck {
  return { isSeen: isSeenPassword, isProven: (fp) => proven.has(fp) };
}

// ── registration ───────────────────────────────────────────────────────────

export interface MailboxRegistration {
  seen: number;
  proven: number;
  ignored: number;
}

/** Pure parse of a mailbox tool's stdout; values become fingerprints here. */
export function parseMailboxOutput(stdout: string): {
  fingerprints: string[];
  ignored: number;
} {
  const fingerprints: string[] = [];
  let ignored = 0;
  for (const raw of stdout.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!line.startsWith(PASSWORD_LINE)) continue;
    const value = line.slice(PASSWORD_LINE.length);
    if (isPasswordValue(value)) fingerprints.push(passwordFingerprint(value));
    else ignored++;
  }
  return { fingerprints, ignored };
}

function stdoutOf(result: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    // Not the shell tool's JSON shape: nothing is registered.
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const stdout = (parsed as { stdout?: unknown }).stdout;
  return typeof stdout === "string" ? stdout : null;
}

/**
 * The registry's one call, on the scrubbed result the model receives.
 * Returns the counts (null when the call is not a mailbox tool result).
 */
export function registerMailboxResult(
  toolName: string,
  args: Record<string, unknown>,
  result: unknown,
  taskId: string | undefined,
): MailboxRegistration | null {
  try {
    if (toolName !== "shell_exec") return null;
    const command = args.command;
    if (typeof command !== "string") return null;
    if (!namesVerifyingCommand(command)) return null;
    if (typeof result !== "string") return null;
    const stdout = stdoutOf(result);
    if (stdout === null) return null;
    const parsed = parseMailboxOutput(stdout);
    // Proven first: a failing seen write must not turn this run's real
    // result into a withhold.
    if (taskId) recordProvenPasswords(taskId, parsed.fingerprints);
    rememberSeen(parsed.fingerprints);
    const counts: MailboxRegistration = {
      seen: parsed.fingerprints.length,
      proven: taskId ? parsed.fingerprints.length : 0,
      ignored: parsed.ignored,
    };
    if (counts.seen > 0 || counts.ignored > 0) {
      console.log(
        `[v8-4] mailbox-passwords registered seen=${counts.seen} proven=${counts.proven} ignored=${counts.ignored}`,
      );
    }
    return counts;
  } catch {
    console.warn("[v8-4] mailbox-passwords registration failed");
    return null;
  }
}

/** @internal test hook */
export function _resetMailboxPasswords(): void {
  seenCache = null;
  seenCacheDb = null;
  _resetMailboxProven();
}
