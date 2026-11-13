/**
 * One-off operator script: remove remembered mailbox passwords from the agent's stores.
 *
 * Why: before the reply-side check (src/lib/v8-4/password-gate.ts) existed, the agent
 * repeated mailbox passwords from memory, and those replies were stored where it can
 * read them again (the DB_STORES columns below, day-logs in the KB registry and on disk,
 * retention archives). This script replaces exactly those values with the reply check's
 * own placeholder, and proves (read-only) that no other database column still holds one.
 *
 * Rules (each one is pinned by scripts/prune-mailbox-passwords.test.ts):
 *  1. Values are read the way the reply check reads them: its `candidateRuns` gives, per
 *     letter/digit run, the run and (after a backslash) the run without an escape
 *     letter or a `\uXXXX` escape, each only at 16–64 characters. A run is COLLECTED
 *     when one of its candidates has a lowercase, an uppercase and a digit, it starts
 *     fewer than REACH units after a password word (KEYWORDS, any case, not preceded by
 *     a letter), and the text also has a mailbox context (an `@domain.tld`, a verifying
 *     command name from mailbox-passwords.ts, or MAILBOX_WORDS). Then the fingerprint
 *     of EVERY candidate of that run is collected, so the one the reply check computes
 *     for the true value is always among them. A unit is one character, except that a
 *     whole run and a whole placeholder count as one unit, and a password word inside a
 *     placeholder is not a password word: a replacement never moves another run into
 *     reach, so a second run collects nothing new.
 *  2. Replacement: wherever a run has a collected candidate, in every store below and
 *     whatever the words around it, that candidate becomes PASSWORD_WITHHELD_PLACEHOLDER;
 *     the longest one in plain text (no character of the value is left), and in a text
 *     that was JSON the longest one that keeps it parsing AND keeps every string value
 *     that was itself JSON parsing, down to NEST_DEPTH levels (the escape stays). A JSON
 *     text that no candidate keeps valid is SKIPPED, counted (`skipped_json`) and fails
 *     the run. Every other byte of the text stays as it was.
 *  3. The collected set is made durable before anything is rewritten, so a re-run after
 *     any interruption can finish: an apply run (a) collects from every store, (b) adds
 *     every fingerprint already in `mailbox_password_seen` (values the mailbox tool
 *     printed; removing them from the stores is wanted), (c) commits the new
 *     fingerprints in their OWN transaction, (d) rewrites the KB files and the archives
 *     (temp file + rename in the same folder; a file with no hit is not touched;
 *     archives keep their mtime, which drives the one-year rotation), (e) updates the
 *     rows in ONE transaction, last (compare-and-set on every pruned column of the row).
 *     `--apply` therefore refuses while the table does not exist (schema below v17).
 *  4. A `jarvis_files` row that changes gets `updated_at = now`. The hourly KB reindex
 *     (src/db/jarvis-reindex.ts `newerCopy`) refreshes a row from disk only when the disk
 *     copy is newer than `updated_at` AND differs: between (d) and (e) the disk copy is
 *     the pruned one, so a refresh can only bring pruned text in (day-logs are exempt
 *     from refresh and are finished by the re-run); after (e) both are equal and the row
 *     is the newer. `user_edit_time` is not touched (this is not a user edit).
 *  5. `projects.credentials` is the credential store and is never read or written; the
 *     fingerprint table is never pruned or swept.
 *  6. Output: the mode, counts, store and column names, timings and error codes only.
 *     Never a value, part of one, its length, a row's text, a path, a file name or an
 *     argument's value.
 *  7. A missing or non-folder `--kb` / `--archive` is a refusal; a folder or file that
 *     cannot be read (while collecting or rewriting) is a counted failure. Symlinked or
 *     hard-linked files with a hit are never written (the other name would keep the old
 *     text, or the write would leave the folder) and fail the run. Temp files left by an
 *     earlier run (they hold pruned text) are removed at the start of an apply run and
 *     counted; one that cannot be removed fails the run.
 *  8. Safety net (read-only, both modes, after the row pass in apply): every other
 *     column of every ordinary table is swept for a run whose fingerprint is being
 *     pruned. A hit there is never rewritten; it is reported by `table.column` as
 *     `uncovered_hits` and fails the run, so a clean run means nothing known remains in
 *     the database, and a dirty one names the column that still needs a ruling.
 *  9. Embeddings derived from pruned text (DERIVED_BLOBS) cannot be recomputed here; the
 *     rows whose text was pruned and that carry one are counted per table and left.
 * 10. `--scan-only <dir>` (repeatable): a folder this script only reads (regular files
 *     up to SCAN_FILE_CAP, links not followed). Files holding a run whose fingerprint is
 *     being pruned are counted by the folder's position on the command line; a hit
 *     fails the run. A missing folder counts zero and is marked `missing`.
 *
 * The operator's wrapper takes the snapshot before --apply; this script keeps no backup
 * and never runs VACUUM. It opens the database directly (never initDatabase, which would
 * run schema migrations); the dry run opens it read-only and also works while the
 * service runs.
 *
 * Usage (all three locations are required, in the dry run too; nothing is defaulted):
 *   npx tsx scripts/prune-mailbox-passwords.ts --db <file> --kb <dir> --archive <dir> \
 *     [--scan-only <dir>]...
 *   npx tsx scripts/prune-mailbox-passwords.ts --db <file> --kb <dir> --archive <dir> \
 *     [--scan-only <dir>]... --apply --i-stopped-the-service
 * Exit: 0 done (or nothing to do), 1 finished with failures or stopped by an error
 * (the message says whether to run again), 2 refused (nothing written).
 */

import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  PASSWORD_WITHHELD_PLACEHOLDER,
  candidateRuns,
  passwordFingerprint,
} from "../src/lib/v8-4/password-gate.js";
import { VERIFYING_COMMANDS } from "../src/lib/v8-4/mailbox-passwords.js";
import { requireOperatorContext } from "../src/lib/operator-gate.js";
import { isMainModule as isEntryModule } from "../src/lib/is-main-module.js";

const TAG = "[prune-mailbox-passwords]";

/** Password words, lowercase; matched case-insensitively, never right after a letter. */
export const KEYWORDS = ["password", "contraseña", "contrasena", "clave", "passwd", "pwd"];
/** Mailbox words, lowercase (the accent-less spelling of buzón included, as for contraseña). */
export const MAILBOX_WORDS = ["buzón", "buzon", "mailbox", "correo"];
/** A value starts fewer than REACH units after the end of a password word. */
export const REACH = 80;
/** How deep a JSON string holding JSON is checked to keep parsing (rule 2). */
export const NEST_DEPTH = 8;
/** `--scan-only` reads files up to this size; a larger one is counted `over_cap` and fails the run. */
export const SCAN_FILE_CAP = 32 * 1024 * 1024;

export interface DbStore {
  table: string;
  /** Columns that identify a row for the compare-and-set (`rowid` unless the table has none). */
  key: readonly string[];
  /** Text columns that are pruned. */
  columns: readonly string[];
}

const R = ["rowid"] as const;

/**
 * Every pruned column, by table: the ONE list (tests iterate it). A table that does not
 * exist is skipped (counted `tables_absent`); a listed column missing from a present
 * table is a refusal (the list and the schema disagree: nothing is written). `projects`
 * is deliberately absent: it is the credential store.
 */
export const DB_STORES: ReadonlyArray<DbStore> = [
  { table: "conversations", key: R, columns: ["content"] },
  { table: "tasks", key: R, columns: ["title", "description", "input", "output", "error", "metadata"] },
  { table: "runs", key: R, columns: ["input", "output", "trace", "error", "goal_graph"] },
  { table: "task_outcomes", key: R, columns: ["concern_detail"] },
  { table: "recall_audit", key: R, columns: ["query", "result_snippets"] },
  { table: "events", key: R, columns: ["data"] },
  { table: "mined_test_cases", key: R, columns: ["input"] },
  { table: "memory_tombstones", key: R, columns: ["terms", "new_terms"] },
  { table: "general_events", key: R, columns: ["title", "summary"] },
  { table: "tool_approvals", key: R, columns: ["args_json", "summary"] },
  { table: "jme_turns", key: R, columns: ["content"] },
  { table: "jme_facts", key: R, columns: ["fact_text"] },
  { table: "jme_signals", key: R, columns: ["snippet"] },
  { table: "user_facts", key: R, columns: ["value"] },
  { table: "learnings", key: R, columns: ["content"] },
  { table: "strategy_bullets", key: R, columns: ["content"] },
  { table: "project_log", key: R, columns: ["details"] },
  { table: "scope_telemetry", key: R, columns: ["message"] },
  { table: "task_provenance", key: R, columns: ["snippet"] },
  { table: "prometheus_snapshots", key: R, columns: ["goal_results", "execution_state", "task_description"] },
  { table: "schedule_runs", key: R, columns: ["result_summary"] },
  { table: "scheduled_tasks", key: R, columns: ["description"] },
  { table: "ritual_deferrals", key: R, columns: ["text"] },
  { table: "task_gates", key: R, columns: ["evidence"] },
  { table: "skill_test_runs", key: R, columns: ["actual_output_json"] },
  { table: "skill_failures", key: R, columns: ["input_json", "error_detail"] },
  { table: "attributed_claims", key: R, columns: ["claim_text", "evidence_excerpt"] },
  { table: "judgments", key: R, columns: ["prose", "triggering_evidence_text"] },
  { table: "sycophancy_probes", key: R, columns: ["triggering_evidence_text"] },
  { table: "triage_report", key: R, columns: ["anomalies_json"] },
  { table: "task_trace_events", key: R, columns: ["attrs"] },
  { table: "knowledge_nodes", key: R, columns: ["summary"] },
  { table: "knowledge_triples", key: R, columns: ["object"] },
  { table: "signals", key: R, columns: ["value_text"] },
  { table: "decisions", key: R, columns: ["payload_json"] },
  { table: "decision_events", key: R, columns: ["payload_json"] },
  { table: "reports", key: R, columns: ["report_json"] },
  { table: "proposed_briefings", key: R, columns: ["briefing_json"] },
  { table: "commit_events", key: R, columns: ["changes"] },
  { table: "jarvis_files", key: R, columns: ["content"] },
];

/** Never pruned and never swept: the credential store and the fingerprint table. */
const EXCLUDED_COLUMNS = new Set(["projects.credentials"]);

/**
 * Embeddings computed from a pruned column. `sql` takes the pruned row's key and
 * answers whether that row has one; it is prepared only when its table exists.
 */
export const DERIVED_BLOBS: ReadonlyArray<{ store: string; label: string; sql: string }> = [
  {
    store: "general_events",
    label: "general_events.summary_embedding",
    sql: "SELECT 1 FROM general_events WHERE rowid = ? AND summary_embedding IS NOT NULL",
  },
  { store: "jme_facts", label: "jme_facts.embedding", sql: "SELECT 1 FROM jme_facts WHERE rowid = ? AND embedding IS NOT NULL" },
  {
    store: "conversations",
    label: "conversation_embeddings.embedding",
    sql: "SELECT 1 FROM conversation_embeddings WHERE conversation_id = ? AND embedding IS NOT NULL",
  },
];

const SEEN_TABLE = "mailbox_password_seen";
const ARCHIVE_RE = /^tasks-retention-.*\.jsonl\.gz$/;
const TMP_SUFFIX = ".prune-tmp";
/** A temp file of this script: `.<name>.prune-tmp-<pid>-<random>`. */
const TMP_RE = /^\..+\.prune-tmp-\d+-[0-9a-f]+$/;
const BACKSLASH = 92;

// ── text rules (pure) ──────────────────────────────────────────────────────

function isAlnum(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

/** Lowercase for matching: ASCII letters and the three accented capitals the words use. */
function fold(c: number): number {
  if (c >= 65 && c <= 90) return c + 32;
  if (c === 0xd1) return 0xf1; // Ñ → ñ
  if (c === 0xd3) return 0xf3; // Ó → ó
  return c;
}

function wordAt(text: string, i: number, word: string): boolean {
  if (i + word.length > text.length) return false;
  for (let k = 0; k < word.length; k++) {
    if (fold(text.charCodeAt(i + k)) !== word.charCodeAt(k)) return false;
  }
  return true;
}

const LETTER_RE = /\p{L}/u;

/**
 * A password word starts a word: no letter right before it (`enclave` is not `clave`).
 * A letter right after a backslash is an escape (`\npassword` in an encoded text), not
 * part of the word.
 */
function startsWord(text: string, i: number): boolean {
  if (i === 0 || !LETTER_RE.test(text[i - 1]!)) return true;
  return i >= 2 && text.charCodeAt(i - 2) === BACKSLASH;
}

export interface Span {
  start: number;
  end: number;
}

/** One letter/digit run: its candidates from the reply check, longest first, all ending at `end`. */
export interface RunGroup extends Span {
  candidates: Span[];
}

/** The reply check's candidates (`candidateRuns`), grouped by run. Linear. */
export function runGroups(text: string): RunGroup[] {
  const out: RunGroup[] = [];
  for (const c of candidateRuns(text)) {
    const g = out[out.length - 1];
    if (g && g.end === c.end) g.candidates.push({ start: c.start, end: c.end });
    else out.push({ start: c.start, end: c.end, candidates: [{ start: c.start, end: c.end }] });
  }
  return out;
}

/** Placeholder occurrences, in order. */
function placeholderSpans(text: string): Span[] {
  const out: Span[] = [];
  for (let at = text.indexOf(PASSWORD_WITHHELD_PLACEHOLDER); at >= 0; ) {
    out.push({ start: at, end: at + PASSWORD_WITHHELD_PLACEHOLDER.length });
    at = text.indexOf(PASSWORD_WITHHELD_PLACEHOLDER, at + PASSWORD_WITHHELD_PLACEHOLDER.length);
  }
  return out;
}

/** True when the text names a mailbox: `@` + a domain-shaped token, a verifying command, or a mailbox word. */
export function hasMailboxContext(text: string): boolean {
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c === 64 /* @ */) {
      // The token after `@`: letters, digits, `-` and `.`; it ends at any other character
      // (another `@` too), so every character is read once.
      let j = i + 1;
      while (j < n) {
        const d = text.charCodeAt(j);
        if (isAlnum(d) || d === 45 || d === 46) j++;
        else break;
      }
      if (isDomain(text.slice(i + 1, j))) return true;
      i = j - 1;
      continue;
    }
    for (const w of MAILBOX_WORDS) if (wordAt(text, i, w)) return true;
    for (const w of VERIFYING_COMMANDS) if (text.startsWith(w, i)) return true;
  }
  return false;
}

/** `label(.label)+`, labels non-empty, the last one two or more letters; trailing dots ignored. */
function isDomain(token: string): boolean {
  let t = token;
  while (t.endsWith(".")) t = t.slice(0, -1);
  const labels = t.split(".");
  if (labels.length < 2 || labels.some((l) => l.length === 0)) return false;
  return /^[A-Za-z]{2,}$/.test(labels[labels.length - 1]!);
}

function hasMixedClasses(text: string, s: Span): boolean {
  let lower = false;
  let upper = false;
  let digit = false;
  for (let i = s.start; i < s.end; i++) {
    const c = text.charCodeAt(i);
    if (c >= 97 && c <= 122) lower = true;
    else if (c >= 65 && c <= 90) upper = true;
    else if (c >= 48 && c <= 57) digit = true;
  }
  return lower && upper && digit;
}

/**
 * Adds to `into` the fingerprints rule 1 collects from one text; returns how many runs
 * the text gave (0 = no hit). Linear in the text length.
 */
export function collectFromText(text: string, into: Set<string>): number {
  // Cheap exits first: most stored texts have no candidate run.
  const groups = runGroups(text);
  if (groups.length === 0) return 0;
  const holders = placeholderSpans(text);
  const n = text.length;
  // unit[i]: distance units before index i; a run or a placeholder is one unit.
  const unit = new Int32Array(n + 1);
  const ends: number[] = [];
  let u = 0;
  let gi = 0;
  let hi = 0;
  for (let i = 0; i < n; ) {
    // Runs and placeholders never overlap (a placeholder holds no 16–64 run, and `[`
    // ends any run before it); both are stepped over whole, so a password word inside
    // one is not a password word.
    const g = gi < groups.length && groups[gi]!.start === i ? groups[gi++] : null;
    const h = !g && hi < holders.length && holders[hi]!.start === i ? holders[hi++] : null;
    const span = g ?? h;
    if (span) {
      for (let k = span.start; k < span.end; k++) unit[k] = u;
      u++;
      i = span.end;
      continue;
    }
    unit[i] = u++;
    if (startsWord(text, i)) {
      for (const w of KEYWORDS) {
        if (wordAt(text, i, w)) {
          ends.push(i + w.length);
          break;
        }
      }
    }
    i++;
  }
  unit[n] = u;
  if (ends.length === 0) return 0;
  if (!hasMailboxContext(text)) return 0;
  let given = 0;
  let k = 0;
  for (const g of groups) {
    // The nearest password word that ends at or before the run starts.
    while (k + 1 < ends.length && ends[k + 1]! <= g.start) k++;
    const e = ends[k]!;
    if (e > g.start) continue;
    if (unit[g.start]! - unit[e]! >= REACH) continue;
    if (!g.candidates.some((c) => hasMixedClasses(text, c))) continue;
    for (const c of g.candidates) into.add(passwordFingerprint(text.slice(c.start, c.end)));
    given++;
  }
  return given;
}

/** True when a run of the text has a candidate whose fingerprint is in the set. */
export function hasKnownRun(text: string, fingerprints: ReadonlySet<string>): boolean {
  for (const c of candidateRuns(text)) {
    if (fingerprints.has(passwordFingerprint(text.slice(c.start, c.end)))) return true;
  }
  return false;
}

const NOT_JSON: unique symbol = Symbol("not-json");

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return NOT_JSON;
  }
}

/** Every string VALUE (keys excluded) of a parsed JSON value, in one fixed depth-first order. */
function stringsOf(v: unknown): string[] {
  const out: string[] = [];
  const stack: unknown[] = [v];
  while (stack.length > 0) {
    const x = stack.pop();
    if (typeof x === "string") out.push(x);
    else if (Array.isArray(x)) for (let i = x.length - 1; i >= 0; i--) stack.push(x[i]);
    else if (x !== null && typeof x === "object") {
      const vals = Object.values(x as Record<string, unknown>);
      for (let i = vals.length - 1; i >= 0; i--) stack.push(vals[i]);
    }
  }
  return out;
}

/** A string value (by its position in `stringsOf`) that held JSON, and what it held in turn. */
interface Nest {
  at: number;
  inner: Nest[];
}

const JSON_PAYLOAD_RE = /^\s*[[{]/;

/** The string values that are themselves a JSON object/array payload, down to `depth` levels. */
function nestOf(v: unknown, depth: number): Nest[] {
  if (depth <= 0) return [];
  const out: Nest[] = [];
  stringsOf(v).forEach((s, at) => {
    if (!JSON_PAYLOAD_RE.test(s)) return;
    const p = parseJson(s);
    if (p !== NOT_JSON) out.push({ at, inner: nestOf(p, depth - 1) });
  });
  return out;
}

/** The parsed value still holds parseable JSON at every place `nest` says it did. */
function keepsNest(v: unknown, nest: Nest[]): boolean {
  if (nest.length === 0) return true;
  const strings = stringsOf(v);
  for (const n of nest) {
    const s = strings[n.at];
    if (typeof s !== "string") return false;
    const p = parseJson(s);
    if (p === NOT_JSON || !keepsNest(p, n.inner)) return false;
  }
  return true;
}

export interface Replacement {
  text: string;
  replaced: number;
  /** A JSON text that no collected candidate keeps valid (outer and nested): left as it was. */
  unsafe: boolean;
}

/**
 * Rule 2. One pass takes the longest collected candidate of every run. When the text
 * was JSON, that result must parse and keep every nested JSON payload parsing (one
 * parse of the result, plus one per nested payload); otherwise a second pass takes, run
 * by run, the longest candidate that keeps all of it valid (only an escape before a
 * value can break it, so the common case parses once). Cost: plain text O(n); JSON on
 * the fast path O(n·(1+nesting)); on the fallback at most one full check per candidate
 * tried, so O(n·runs·candidates·(1+nesting)).
 */
export function replaceCollected(text: string, fingerprints: ReadonlySet<string>): Replacement {
  if (fingerprints.size === 0) return { text, replaced: 0, unsafe: false };
  const hits: Span[][] = [];
  for (const g of runGroups(text)) {
    const got = g.candidates.filter((c) => fingerprints.has(passwordFingerprint(text.slice(c.start, c.end))));
    if (got.length > 0) hits.push(got);
  }
  if (hits.length === 0) return { text, replaced: 0, unsafe: false };
  const build = (pick: (got: Span[], out: string, last: number) => Span | undefined): string | null => {
    let out = "";
    let last = 0;
    for (const got of hits) {
      const c = pick(got, out, last);
      if (!c) return null;
      out += text.slice(last, c.start) + PASSWORD_WITHHELD_PLACEHOLDER;
      last = c.end;
    }
    return out + text.slice(last);
  };
  const longest = build((got) => got[0])!;
  const parsed = parseJson(text);
  if (parsed === NOT_JSON) return { text: longest, replaced: hits.length, unsafe: false };
  const nest = nestOf(parsed, NEST_DEPTH);
  const valid = (t: string): boolean => {
    const p = parseJson(t);
    return p !== NOT_JSON && keepsNest(p, nest);
  };
  if (valid(longest)) return { text: longest, replaced: hits.length, unsafe: false };
  const kept = build((got, out, last) =>
    got.find((c) => valid(out + text.slice(last, c.start) + PASSWORD_WITHHELD_PLACEHOLDER + text.slice(c.end))),
  );
  if (kept === null || !valid(kept)) return { text, replaced: 0, unsafe: true };
  return { text: kept, replaced: hits.length, unsafe: false };
}

// ── files ──────────────────────────────────────────────────────────────────

/** UTF-8 text of a file, or null when the bytes are not valid UTF-8 (they would not round-trip). */
function readText(path: string): string | null {
  const raw = readFileSync(path);
  const text = raw.toString("utf8");
  return Buffer.from(text, "utf8").equals(raw) ? text : null;
}

export interface KbListing {
  /** `.md` files (relative paths). */
  files: string[];
  /** Leftover temp files of this script (relative paths). */
  temps: string[];
  symlinks: number;
  /** Folders that could not be read. */
  unreadable: number;
}

/** `.md` files under the KB root; symlinks are never followed; `.git`/`node_modules` skipped. */
export function listKbFiles(root: string): KbListing {
  const out: KbListing = { files: [], temps: [], symlinks: 0, unreadable: 0 };
  const walk = (rel: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(join(root, rel));
    } catch {
      out.unreadable++;
      return;
    }
    for (const name of entries.sort()) {
      if (name === ".git" || name === "node_modules") continue;
      const r = rel ? `${rel}/${name}` : name;
      let st;
      try {
        st = lstatSync(join(root, r));
      } catch {
        continue; // removed while walking
      }
      if (st.isSymbolicLink()) out.symlinks++;
      else if (st.isDirectory()) walk(r);
      else if (st.isFile() && TMP_RE.test(name)) out.temps.push(r);
      else if (st.isFile() && name.endsWith(".md")) out.files.push(r);
    }
  };
  walk("");
  return out;
}

/** Archive file names and leftover temp names in the folder. */
export function listArchives(dir: string): { names: string[]; temps: string[]; unreadable: boolean } {
  try {
    const all = readdirSync(dir).sort();
    return { names: all.filter((f) => ARCHIVE_RE.test(f)), temps: all.filter((f) => TMP_RE.test(f)), unreadable: false };
  } catch {
    return { names: [], temps: [], unreadable: true };
  }
}

/**
 * Atomic replace: a uniquely named temp file in the same folder (fsynced), same mode,
 * optional mtime, then rename; the temp file is removed on any failure. Its name never
 * ends in `.md` or matches the archive pattern, so neither the KB reindex nor the
 * archive readers pick one up if the process dies mid-write.
 */
function writeAtomic(path: string, data: Buffer | string, keepTimes: boolean): void {
  const st = lstatSync(path);
  const tmp = join(dirname(path), `.${basename(path)}${TMP_SUFFIX}-${process.pid}-${randomBytes(6).toString("hex")}`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    try {
      fchmodSync(fd, st.mode & 0o7777);
      const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
      let off = 0;
      while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (keepTimes) utimesSync(tmp, st.atime, st.mtime);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** Archive text with every line's values replaced; lines that cannot keep their JSON stay. */
function replaceArchiveText(text: string, fps: ReadonlySet<string>): { text: string; lines: number; skipped: number } {
  const lines = text.split("\n");
  let changed = 0;
  let skipped = 0;
  for (let i = 0; i < lines.length; i++) {
    const r = replaceCollected(lines[i]!, fps);
    if (r.unsafe) skipped++;
    if (r.replaced === 0) continue;
    lines[i] = r.text;
    changed++;
  }
  return { text: changed === 0 ? text : lines.join("\n"), lines: changed, skipped };
}

export interface ScanCount {
  /** 1-based position of the folder among the `--scan-only` flags. */
  position: number;
  missing: boolean;
  files: number;
  hits: number;
  overCap: number;
  unreadable: number;
  symlinks: number;
}

/** Rule 10: read-only count of files under `dir` that hold a run being pruned. */
export function scanOnly(dir: string, position: number, fps: ReadonlySet<string>): ScanCount {
  const out: ScanCount = { position, missing: false, files: 0, hits: 0, overCap: 0, unreadable: 0, symlinks: 0 };
  try {
    if (!statSync(dir).isDirectory()) out.missing = true;
  } catch {
    out.missing = true;
  }
  if (out.missing) return out;
  const walk = (path: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(path);
    } catch {
      out.unreadable++;
      return;
    }
    for (const name of entries) {
      const p = join(path, name);
      let st;
      try {
        st = lstatSync(p);
      } catch {
        continue; // removed while walking
      }
      if (st.isSymbolicLink()) out.symlinks++;
      else if (st.isDirectory()) walk(p);
      else if (st.isFile()) {
        out.files++;
        if (st.size > SCAN_FILE_CAP) {
          out.overCap++;
          continue;
        }
        if (fps.size === 0) continue;
        try {
          if (hasKnownRun(readFileSync(p).toString("utf8"), fps)) out.hits++;
        } catch {
          out.unreadable++;
        }
      }
    }
  };
  walk(dir);
  return out;
}

// ── open-for-writing check ─────────────────────────────────────────────────

function isGone(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ESRCH";
}

/**
 * Processes other than this one that hold the database (or its WAL) open for writing,
 * read from `/proc/<pid>/fd` links and the access mode in `/proc/<pid>/fdinfo/<fd>`.
 * A read-only reader is not a writer. Fails closed: a live process whose `fd` folder,
 * fd link or fdinfo cannot be read counts as a writer (unknown = refuse); a process or
 * fd that vanished mid-walk is skipped. `available` is false when the proc root cannot
 * be listed.
 */
export function findDbWriters(
  dbPath: string,
  procRoot = "/proc",
  selfPid = process.pid,
): { available: boolean; pids: number[] } {
  let real: string;
  try {
    real = realpathSync(dbPath);
  } catch {
    real = resolve(dbPath);
  }
  const targets = new Set([real, `${real}-wal`]);
  let pidDirs: string[];
  try {
    pidDirs = readdirSync(procRoot).filter((d) => /^\d+$/.test(d));
  } catch {
    return { available: false, pids: [] };
  }
  const pids: number[] = [];
  for (const d of pidDirs) {
    const pid = Number(d);
    if (pid === selfPid) continue;
    let fds: string[];
    try {
      fds = readdirSync(join(procRoot, d, "fd"));
    } catch (err) {
      if (!isGone(err)) pids.push(pid); // cannot be inspected: refuse
      continue;
    }
    for (const fd of fds) {
      let link: string;
      try {
        link = readlinkSync(join(procRoot, d, "fd", fd));
      } catch (err) {
        if (isGone(err)) continue;
        pids.push(pid);
        break;
      }
      if (!targets.has(link)) continue;
      let writer = true;
      try {
        const m = /^flags:\s*([0-7]+)/m.exec(readFileSync(join(procRoot, d, "fdinfo", fd), "utf-8"));
        if (m) writer = (parseInt(m[1]!, 8) & 3) !== 0; // O_WRONLY or O_RDWR
      } catch {
        // unreadable: counted as a writer
      }
      if (writer) {
        pids.push(pid);
        break;
      }
    }
  }
  return { available: true, pids };
}

// ── run ────────────────────────────────────────────────────────────────────

export interface StoreCount {
  store: string;
  /** Rows / files with a value being pruned (would change / changed). */
  hit: number;
  changed: number;
  /** Rows / files that gave at least one value with context. */
  sources: number;
  /** Distinct fingerprints collected (with context) from this store. */
  collected: number;
  note?: string;
}

/** The durable steps of an apply run, for the crash tests. */
export type Stage = "fingerprints" | "file" | "files";

export interface PruneOptions {
  dbPath: string;
  kbRoot: string;
  archiveDir: string;
  apply: boolean;
  /** Read-only folders to count hits in (rule 10). */
  scanOnly?: readonly string[];
  log?: (line: string) => void;
  /** Test seam: runs after each durable step of an apply run (a throw simulates a crash). */
  onStage?: (stage: Stage) => void;
}

export interface PruneResult {
  ok: boolean;
  /** Distinct runs' fingerprints collected from the stores in this run. */
  distinct: number;
  /** Fingerprints already in the seen table before this run. */
  known: number;
  fingerprintsAdded: number;
  seenTable: boolean;
  stores: StoreCount[];
  /** `table.column` → cells outside the pruned list that still hold a pruned run. */
  uncovered: Map<string, number>;
  /** Derived blob label → pruned rows that carry one. */
  derived: Map<string, number>;
  scans: ScanCount[];
  tablesAbsent: number;
}

class CodeError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
function codeError(code: string): CodeError {
  return new CodeError(code);
}

/** A precondition failed before anything was written (exit 2). `detail` is a fixed name, never input. */
export class Refusal extends Error {
  constructor(
    readonly code: string,
    readonly detail?: string,
  ) {
    super(code);
  }
}

/** The error's code only (SQLite / fs code), never its message: messages can carry text or paths. */
export function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : "UNKNOWN";
}

function columnsOf(db: Database.Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

function requireFolder(path: string, code: string): void {
  let ok = false;
  try {
    ok = statSync(path).isDirectory();
  } catch {
    ok = false;
  }
  if (!ok) throw new Refusal(code);
}

/** The listed stores whose table exists; a listed column missing from a present table refuses. */
function presentStores(db: Database.Database): { present: DbStore[]; absent: number } {
  const present: DbStore[] = [];
  let absent = 0;
  for (const s of DB_STORES) {
    const cols = columnsOf(db, s.table);
    if (cols.size === 0) {
      absent++;
      continue;
    }
    for (const c of [...s.columns, ...s.key.filter((k) => k !== "rowid")]) {
      if (!cols.has(c)) throw new Refusal("STORE_COLUMN_ABSENT", `${s.table}.${c}`);
    }
    present.push(s);
  }
  return { present, absent };
}

function selectStore(db: Database.Database, s: DbStore): Database.Statement {
  const keys = s.key.map((k, i) => `${k === "rowid" ? "rowid" : `"${k}"`} AS "k${i}"`);
  return db.prepare(`SELECT ${[...keys, ...s.columns.map((c) => `"${c}"`)].join(", ")} FROM "${s.table}"`);
}

function keyOf(s: DbStore, row: Record<string, unknown>): unknown[] {
  return s.key.map((_, i) => row[`k${i}`]);
}

/**
 * Rule 8: every column of every ordinary table that is not pruned (not virtual, not a
 * full-text shadow table, not `sqlite_*`, not the excluded ones) is read, and a cell that
 * holds a run being pruned is counted by `table.column`. Nothing is written.
 */
function sweepUncovered(db: Database.Database, fps: ReadonlySet<string>): Map<string, number> {
  const out = new Map<string, number>();
  if (fps.size === 0) return out;
  const pruned = new Set(DB_STORES.flatMap((s) => s.columns.map((c) => `${s.table}.${c}`)));
  const tables = (db.prepare("PRAGMA table_list").all() as Array<{ schema: string; name: string; type: string }>)
    .filter((t) => t.schema === "main" && t.type === "table" && !t.name.startsWith("sqlite_") && t.name !== SEEN_TABLE)
    .map((t) => t.name)
    .sort();
  for (const t of tables) {
    const cols = [...columnsOf(db, t)].filter((c) => !pruned.has(`${t}.${c}`) && !EXCLUDED_COLUMNS.has(`${t}.${c}`));
    if (cols.length === 0) continue;
    const sel = db.prepare(`SELECT ${cols.map((c) => `"${c}"`).join(", ")} FROM "${t}"`).raw(true);
    for (const row of sel.iterate() as Iterable<unknown[]>) {
      for (let i = 0; i < cols.length; i++) {
        const v = row[i];
        if (typeof v === "string" && hasKnownRun(v, fps)) {
          const k = `${t}.${cols[i]}`;
          out.set(k, (out.get(k) ?? 0) + 1);
        }
      }
    }
  }
  return out;
}

type RowChange = {
  store: DbStore;
  key: unknown[];
  /** Every pruned column's text as read (null too): the compare-and-set covers all of them. */
  before: Map<string, unknown>;
  after: Map<string, string>;
};

export function runPrune(opts: PruneOptions): PruneResult {
  const log = opts.log ?? ((l: string) => console.log(l));
  const stage = (s: Stage): void => {
    try {
      opts.onStage?.(s);
    } catch (err) {
      throw new StoreFailure("files", errorCode(err), true);
    }
  };
  const t0 = Date.now();
  // Refusals that need no database come before it is opened.
  requireFolder(opts.kbRoot, "KB_NOT_A_FOLDER");
  requireFolder(opts.archiveDir, "ARCHIVE_NOT_A_FOLDER");
  const fresh = new Set<string>();
  const stores: StoreCount[] = [];
  const result: PruneResult = {
    ok: true,
    distinct: 0,
    known: 0,
    fingerprintsAdded: 0,
    seenTable: false,
    stores,
    uncovered: new Map(),
    derived: new Map(),
    scans: [],
    tablesAbsent: 0,
  };
  const db = opts.apply ? new BetterSqlite3(opts.dbPath, { fileMustExist: true }) : openForDryRun(opts.dbPath);
  // Set once the fingerprints are durable: from then on any failure leaves a run that a
  // re-run finishes, and the message must say so.
  let committed = false;
  try {
    if (opts.apply) db.pragma("busy_timeout = 5000");
    result.seenTable =
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(SEEN_TABLE) !== undefined;
    // Rule 3: without the table the collected set cannot be made durable.
    if (opts.apply && !result.seenTable) throw new Refusal("SEEN_TABLE_ABSENT");
    const { present, absent } = presentStores(db);
    result.tablesAbsent = absent;
    const kb = listKbFiles(opts.kbRoot);
    const ar = listArchives(opts.archiveDir);

    // Leftover temp files hold pruned text from an interrupted run: removed (apply) or counted.
    let tempsRemoved = 0;
    let tempsFailed = 0;
    for (const p of [...kb.temps.map((r) => join(opts.kbRoot, r)), ...ar.temps.map((n) => join(opts.archiveDir, n))]) {
      if (!opts.apply) continue;
      try {
        rmSync(p);
        tempsRemoved++;
      } catch {
        tempsFailed++;
      }
    }

    // (a) Collect from every store before anything changes; per store for the report.
    const sources = new Map<string, number>();
    const collectedBy = new Map<string, number>();
    let nonText = 0;
    for (const s of present) {
      const mine = new Set<string>();
      let n = 0;
      for (const row of selectStore(db, s).iterate() as Iterable<Record<string, unknown>>) {
        let gave = 0;
        for (const c of s.columns) {
          const v = row[c];
          if (typeof v === "string") gave += collectFromText(v, mine);
          else if (v !== null && v !== undefined) nonText++;
        }
        if (gave > 0) n++;
      }
      sources.set(s.table, n);
      collectedBy.set(s.table, mine.size);
      for (const f of mine) fresh.add(f);
    }
    // Rule 7: a file that cannot be read now may hold a value no other store has; it is
    // counted (the run fails, a re-run reads it) and left out of the rewrite pass.
    const kbBad = new Set<string>();
    const kbRead = { failed: 0, notUtf8: 0 };
    const kbMine = new Set<string>();
    let kbSources = 0;
    for (const rel of kb.files) {
      let text: string | null;
      try {
        text = readText(join(opts.kbRoot, rel));
      } catch {
        kbRead.failed++;
        kbBad.add(rel);
        continue;
      }
      if (text === null) {
        kbRead.notUtf8++;
        kbBad.add(rel);
        continue;
      }
      if (collectFromText(text, kbMine) > 0) kbSources++;
    }
    const arBad = new Set<string>();
    const arRead = { failed: 0, notUtf8: 0 };
    const arMine = new Set<string>();
    let archiveSources = 0;
    for (const name of ar.names) {
      let text: string | null;
      try {
        text = gunzipText(join(opts.archiveDir, name));
      } catch {
        arRead.failed++;
        arBad.add(name);
        continue;
      }
      if (text === null) {
        arRead.notUtf8++;
        arBad.add(name);
        continue;
      }
      let gave = 0;
      for (const line of text.split("\n")) gave += collectFromText(line, arMine);
      if (gave > 0) archiveSources++;
    }
    for (const f of [...kbMine, ...arMine]) fresh.add(f);
    result.distinct = fresh.size;

    // (b) Every fingerprint already known is pruned too.
    const known = new Set<string>();
    if (result.seenTable) {
      for (const r of db.prepare(`SELECT fingerprint FROM ${SEEN_TABLE}`).iterate() as Iterable<{ fingerprint: string }>) {
        known.add(r.fingerprint);
      }
    }
    result.known = known.size;
    const fps = new Set([...fresh, ...known]);
    const toAdd = [...fresh].filter((f) => !known.has(f));

    // (c) The collected set becomes durable before any rewrite.
    if (opts.apply && toAdd.length > 0) {
      try {
        db.transaction(() => {
          const ins = db.prepare(`INSERT OR IGNORE INTO ${SEEN_TABLE} (fingerprint) VALUES (?)`);
          for (const fp of toAdd) result.fingerprintsAdded += ins.run(fp).changes;
        }).immediate();
      } catch (err) {
        result.fingerprintsAdded = 0;
        throw new StoreFailure("fingerprints", errorCode(err));
      }
    } else if (!opts.apply) {
      result.fingerprintsAdded = toAdd.length; // would add
    }
    committed = opts.apply;
    if (opts.apply) stage("fingerprints");
    const tCollect = Date.now();

    // Plan the row changes (memory only); a JSON text that cannot stay valid is skipped.
    const changes: RowChange[] = [];
    const hits = new Map<string, number>();
    const skippedRows = new Map<string, number>();
    const derivedSql = DERIVED_BLOBS.flatMap((d) => {
      try {
        return [{ ...d, stmt: db.prepare(d.sql) }];
      } catch {
        return []; // its table or column does not exist here
      }
    });
    for (const d of derivedSql) result.derived.set(d.label, 0);
    for (const s of present) {
      let n = 0;
      if (fps.size > 0) {
        for (const row of selectStore(db, s).iterate() as Iterable<Record<string, unknown>>) {
          const after = new Map<string, string>();
          let unsafe = false;
          for (const c of s.columns) {
            const v = row[c];
            if (typeof v !== "string") continue;
            const r = replaceCollected(v, fps);
            if (r.unsafe) unsafe = true;
            if (r.replaced > 0) after.set(c, r.text);
          }
          if (unsafe) {
            skippedRows.set(s.table, (skippedRows.get(s.table) ?? 0) + 1);
            continue;
          }
          if (after.size === 0) continue;
          const key = keyOf(s, row);
          changes.push({ store: s, key, before: new Map(s.columns.map((c) => [c, row[c]])), after });
          n++;
          // Rule 9: an embedding of the old text stays; counted per table.
          for (const d of derivedSql) {
            if (d.store === s.table && d.stmt.get(key[0]) !== undefined) result.derived.set(d.label, result.derived.get(d.label)! + 1);
          }
        }
      }
      hits.set(s.table, n);
    }

    // (d) KB files: each one is replaced atomically on its own.
    const kbCount: StoreCount = { store: "kb-files", hit: 0, changed: 0, sources: kbSources, collected: kbMine.size };
    let kbLinks = 0;
    let kbFailed = 0;
    for (const rel of fps.size > 0 ? kb.files : []) {
      if (kbBad.has(rel)) continue; // counted while collecting
      const path = join(opts.kbRoot, rel);
      try {
        const text = readText(path);
        if (text === null) throw codeError("NOT_UTF8");
        const r = replaceCollected(text, fps);
        if (r.replaced === 0) continue;
        kbCount.hit++;
        // A second hard link would keep the old text after the rename.
        if (lstatSync(path).nlink > 1) {
          kbLinks++;
          continue;
        }
        if (!opts.apply) continue;
        writeAtomic(path, r.text, false);
        kbCount.changed++;
        stage("file");
      } catch (err) {
        if (err instanceof StoreFailure) throw err;
        kbFailed++;
        log(`${TAG} ERROR store=kb-files code=${errorCode(err)}`);
      }
    }
    const kbNotes = [
      kb.symlinks > 0 ? `symlinks_not_followed=${kb.symlinks}` : "",
      kbLinks > 0 ? `hard_linked_with_hit_not_written=${kbLinks}` : "",
      kbRead.notUtf8 > 0 ? `not_utf8_not_read=${kbRead.notUtf8}` : "",
      kbRead.failed > 0 ? `read_failed=${kbRead.failed}` : "",
      kb.unreadable > 0 ? `unreadable_folders=${kb.unreadable}` : "",
      kbFailed > 0 ? `failed=${kbFailed}` : "",
    ].filter(Boolean);
    if (kbNotes.length > 0) kbCount.note = kbNotes.join(" ");

    // (d) Archives: rewritten one by one, mtime kept; links with a hit are never written.
    const arCount: StoreCount = { store: "archives", hit: 0, changed: 0, sources: archiveSources, collected: arMine.size };
    const arSkipped = { symlinks: 0, links: 0, json: 0 };
    let arLines = 0;
    let arFailed = ar.unreadable ? 1 : 0;
    for (const name of fps.size > 0 ? ar.names : []) {
      if (arBad.has(name)) continue; // counted while collecting
      const path = join(opts.archiveDir, name);
      try {
        const st = lstatSync(path);
        const text = gunzipText(path);
        if (text === null) throw codeError("NOT_UTF8");
        const r = replaceArchiveText(text, fps);
        arSkipped.json += r.skipped;
        if (r.lines === 0) continue;
        arCount.hit++;
        arLines += r.lines;
        if (st.isSymbolicLink()) {
          arSkipped.symlinks++;
          continue;
        }
        if (st.nlink > 1) {
          arSkipped.links++;
          continue;
        }
        if (!opts.apply) continue;
        writeAtomic(path, gzipSync(r.text), true);
        arCount.changed++;
        stage("file");
      } catch (err) {
        if (err instanceof StoreFailure) throw err;
        arFailed++;
        log(`${TAG} ERROR store=archives code=${errorCode(err)}`);
      }
    }
    const arNotes = [
      arLines > 0 ? `lines=${arLines}` : "",
      arSkipped.json > 0 ? `skipped_json=${arSkipped.json}` : "",
      arSkipped.symlinks > 0 ? `symlinked_with_hit_not_written=${arSkipped.symlinks}` : "",
      arSkipped.links > 0 ? `hard_linked_with_hit_not_written=${arSkipped.links}` : "",
      arRead.notUtf8 > 0 ? `not_utf8_not_read=${arRead.notUtf8}` : "",
      arRead.failed > 0 ? `read_failed=${arRead.failed}` : "",
      arFailed > 0 ? `failed=${arFailed}` : "",
    ].filter(Boolean);
    if (arNotes.length > 0) arCount.note = arNotes.join(" ");
    if (opts.apply) stage("files");

    // (e) Rows: one transaction, last; compare-and-set on every pruned column of the row.
    const changedRows = new Map<string, number>();
    if (opts.apply && changes.length > 0) {
      let failedTable = "database";
      try {
        db.transaction(() => {
          for (const ch of changes) {
            const s = ch.store;
            failedTable = s.table;
            const cols = [...ch.after.keys()];
            const assign = cols.map((c) => `"${c}" = ?`);
            // Rule 4: a changed KB row is newer than any old disk copy.
            if (s.table === "jarvis_files") assign.push("updated_at = datetime('now')");
            // Compare-and-set: the row must still hold, in EVERY pruned column, what this run read.
            const where = [
              ...s.key.map((k) => `${k === "rowid" ? "rowid" : `"${k}"`} = ?`),
              ...s.columns.map((c) => `"${c}" IS ?`),
            ].join(" AND ");
            const info = db
              .prepare(`UPDATE "${s.table}" SET ${assign.join(", ")} WHERE ${where}`)
              .run(...cols.map((c) => ch.after.get(c)!), ...ch.key, ...s.columns.map((c) => ch.before.get(c)));
            if (info.changes !== 1) throw codeError("ROW_CHANGED");
            changedRows.set(s.table, (changedRows.get(s.table) ?? 0) + 1);
          }
        }).immediate();
      } catch (err) {
        throw new StoreFailure(failedTable, errorCode(err), true);
      }
    }
    for (const s of present) {
      const skipped = skippedRows.get(s.table) ?? 0;
      stores.push({
        store: s.table,
        hit: hits.get(s.table) ?? 0,
        changed: changedRows.get(s.table) ?? 0,
        sources: sources.get(s.table) ?? 0,
        collected: collectedBy.get(s.table) ?? 0,
        note: skipped > 0 ? `skipped_json=${skipped}` : undefined,
      });
    }
    stores.push(kbCount, arCount);

    // Rule 8: the safety net, after the rows are final.
    const tSweep = Date.now();
    result.uncovered = sweepUncovered(db, fps);
    // Rule 10: read-only folders.
    result.scans = (opts.scanOnly ?? []).map((d, i) => scanOnly(d, i + 1, fps));
    const sweepMs = Date.now() - tSweep;

    if (nonText > 0) log(`${TAG} note: ${nonText} non-text cells were not read`);
    if (kb.temps.length + ar.temps.length > 0) {
      log(
        opts.apply
          ? `${TAG} leftover temp files removed=${tempsRemoved}${tempsFailed > 0 ? ` failed=${tempsFailed}` : ""}`
          : `${TAG} leftover temp files found=${kb.temps.length + ar.temps.length} (removed by --apply)`,
      );
    }
    const skippedAny = [...skippedRows.values()].some((n) => n > 0) || arSkipped.json > 0;
    const uncoveredAny = [...result.uncovered.values()].some((n) => n > 0);
    const scanAny = result.scans.some((s) => s.hits > 0 || s.overCap > 0 || s.unreadable > 0);
    if (
      kbFailed > 0 ||
      arFailed > 0 ||
      kb.unreadable > 0 ||
      kbLinks > 0 ||
      kbRead.failed + kbRead.notUtf8 + arRead.failed + arRead.notUtf8 > 0 ||
      arSkipped.symlinks > 0 ||
      arSkipped.links > 0 ||
      skippedAny ||
      tempsFailed > 0 ||
      uncoveredAny ||
      scanAny
    ) {
      result.ok = false;
    }

    report(log, opts.apply, result, tCollect - t0, tSweep - tCollect, sweepMs);
    return result;
  } catch (err) {
    if (err instanceof Refusal || err instanceof StoreFailure) throw err;
    throw new StoreFailure("run", errorCode(err), committed);
  } finally {
    db.close();
  }
}

class StoreFailure extends Error {
  constructor(
    readonly store: string,
    readonly code: string,
    /** True when the collected fingerprints were already committed (a re-run finishes). */
    readonly partial = false,
  ) {
    super(`${store}:${code}`);
  }
}

/**
 * Dry-run connection: read-only, as the neighbouring scripts open it, so a dry run also
 * works while the service holds the database open. On a WAL database SQLite may create
 * its own `-wal`/`-shm` side files next to it; those are the engine's, not a change of
 * the store (the database file itself and every row stay as they were).
 */
function openForDryRun(dbPath: string): Database.Database {
  return new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true });
}

function gunzipText(path: string): string | null {
  const raw = gunzipSync(readFileSync(path));
  const text = raw.toString("utf8");
  return Buffer.from(text, "utf8").equals(raw) ? text : null;
}

function report(
  log: (l: string) => void,
  apply: boolean,
  r: PruneResult,
  collectMs: number,
  restMs: number,
  sweepMs: number,
): void {
  log(`${TAG} mode=${apply ? "apply" : "dry-run"}`);
  for (const s of r.stores) {
    log(
      `${TAG} store=${s.store} sources=${s.sources} collected=${s.collected} hit=${s.hit} changed=${s.changed}${s.note ? ` ${s.note}` : ""}`,
    );
  }
  if (r.tablesAbsent > 0) log(`${TAG} tables_absent=${r.tablesAbsent}`);
  log(`${TAG} collected_fingerprints=${r.distinct}`);
  log(
    r.seenTable
      ? `${TAG} fingerprints_known=${r.known} ${apply ? "fingerprints_added" : "fingerprints_to_add"}=${r.fingerprintsAdded}`
      : `${TAG} fingerprints: table ${SEEN_TABLE} is absent (schema below v17) — --apply refuses until it exists`,
  );
  for (const [label, n] of r.derived) log(`${TAG} derived_blob=${label} pruned_rows_with_blob=${n} (left as they are)`);
  const uncovered = [...r.uncovered.values()].reduce((a, n) => a + n, 0);
  log(`${TAG} uncovered_hits=${uncovered}`);
  for (const [col, n] of r.uncovered) log(`${TAG} uncovered column=${col} cells=${n} (not rewritten)`);
  for (const s of r.scans) {
    const notes = [
      s.missing ? "missing" : "",
      s.overCap > 0 ? `over_cap=${s.overCap}` : "",
      s.unreadable > 0 ? `unreadable=${s.unreadable}` : "",
      s.symlinks > 0 ? `symlinks_not_followed=${s.symlinks}` : "",
    ].filter(Boolean);
    log(`${TAG} scan_only=${s.position} files=${s.files} scan_only_hits=${s.hits}${notes.length > 0 ? ` ${notes.join(" ")}` : ""}`);
  }
  const pending = r.stores.reduce((a, s) => a + s.hit, 0);
  if (pending === 0) log(`${TAG} nothing to change`);
  else if (!apply) log(`${TAG} dry run — nothing written; pass --apply --i-stopped-the-service to write`);
  if (!r.ok) log(`${TAG} finished with failures (see the notes above); fix them and run the same command again`);
  log(`${TAG} timing collect_ms=${collectMs} rest_ms=${restMs} sweep_ms=${sweepMs}`);
}

// ── entry ──────────────────────────────────────────────────────────────────

export type Args = {
  apply: boolean;
  stopped: boolean;
  db: string;
  kb: string;
  archive: string;
  scanOnly: string[];
};

const TARGET_FLAGS = ["--db", "--kb", "--archive"] as const;
const FLAG_NAME_RE = /^--[a-z][a-z-]*$/;

/**
 * Flags: --db <file>, --kb <dir>, --archive <dir> (all three required, no default and no
 * environment fallback: the targets are always named), --scan-only <dir> (repeatable),
 * --apply, --i-stopped-the-service. An error names a flag or a position, never a value.
 */
export function parseArgs(argv: string[]): Args | { error: string } {
  let apply = false;
  let stopped = false;
  const vals: Record<string, string | undefined> = {};
  const scanOnly: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--apply") apply = true;
    else if (a === "--i-stopped-the-service") stopped = true;
    else if ((TARGET_FLAGS as readonly string[]).includes(a) || a === "--scan-only") {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) return { error: `missing value for ${a}` };
      i++;
      if (a === "--scan-only") scanOnly.push(v);
      else if (vals[a] !== undefined) return { error: `repeated ${a}` };
      else vals[a] = v;
    } else {
      // `--name=value`: the name only. Anything else: its position only.
      const name = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
      return { error: FLAG_NAME_RE.test(name) ? `unexpected argument: ${name}` : `unexpected argument at position ${i + 1}` };
    }
  }
  const missing = TARGET_FLAGS.filter((f) => !vals[f]);
  if (missing.length > 0) return { error: `missing ${missing.join(" ")}` };
  return { apply, stopped, db: vals["--db"]!, kb: vals["--kb"]!, archive: vals["--archive"]!, scanOnly };
}

type MainDeps = {
  requireOperatorContext: (tag: string, opts: { tty: boolean }) => void;
  findDbWriters: (dbPath: string) => { available: boolean; pids: number[] };
  runPrune: (opts: PruneOptions) => PruneResult;
  log: (line: string) => void;
  error: (line: string) => void;
};

/** Operator entry: the gate runs before any database or file access. Returns the exit code. */
export function main(
  argv: string[] = process.argv.slice(2),
  deps: MainDeps = {
    requireOperatorContext,
    findDbWriters: (p) => findDbWriters(p),
    runPrune,
    log: (l) => console.log(l),
    error: (l) => console.error(l),
  },
): number {
  deps.requireOperatorContext("prune-mailbox-passwords", { tty: false });
  const args = parseArgs(argv);
  if ("error" in args) {
    deps.error(`${TAG} ${args.error}`);
    return 2;
  }
  if (args.apply) {
    if (!args.stopped) {
      deps.error(`${TAG} REFUSED: --apply needs --i-stopped-the-service (stop the service first)`);
      return 2;
    }
    const w = deps.findDbWriters(args.db);
    if (!w.available) {
      deps.error(`${TAG} WARNING: open files cannot be inspected on this host; relying on --i-stopped-the-service alone`);
    } else if (w.pids.length > 0) {
      deps.error(
        `${TAG} REFUSED: ${w.pids.length} process(es) hold the database open for writing or cannot be inspected: pid ${w.pids.join(" ")}`,
      );
      return 2;
    }
  }
  try {
    const r = deps.runPrune({
      dbPath: args.db,
      kbRoot: args.kb,
      archiveDir: args.archive,
      scanOnly: args.scanOnly,
      apply: args.apply,
      log: deps.log,
    });
    return r.ok ? 0 : 1;
  } catch (err) {
    if (err instanceof Refusal) {
      deps.error(`${TAG} REFUSED code=${err.code}${err.detail ? ` column=${err.detail}` : ""} — nothing written`);
      return 2;
    }
    // Code only, never the message: a driver or fs message can carry stored text or a path.
    const store = err instanceof StoreFailure ? err.store : "run";
    const code = err instanceof StoreFailure ? err.code : errorCode(err);
    const state =
      err instanceof StoreFailure && err.partial
        ? "fingerprints recorded, some stores not finished — run the same command again to finish"
        : "nothing changed in the stores";
    deps.error(`${TAG} ERROR store=${store} code=${code} — ${state}`);
    return 1;
  }
}

/** True only when this file is the process entry point (never when a test imports it). */
export function isMainModule(): boolean {
  return isEntryModule(import.meta.url);
}

if (isMainModule()) process.exitCode = main();
