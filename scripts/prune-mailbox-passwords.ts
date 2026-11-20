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
 *     letter or a `\uXXXX` escape, each only at 16–64 characters. Collection needs a
 *     password word (KEYWORDS, any case, not preceded by a letter) before the run and a
 *     mailbox context in the same text (an `@domain.tld`, a verifying command name from
 *     mailbox-passwords.ts, or MAILBOX_WORDS). A run is then COLLECTED in two cases:
 *     (A) GENERATED: one of its candidates has the generated shape (exactly
 *     GENERATED_PASSWORD_LEN characters that look random, see below) and the run starts
 *     fewer than REACH units after the nearest password word. The mailbox tool generates
 *     every mailbox password itself at that length, so this is the shape of every value
 *     it ever printed. A copy cut off at some length (a stored snippet) is a shorter run
 *     that no context names, so for every value collected by (A) the fingerprint of
 *     EVERY contiguous piece of it with at least PASSWORD_MIN_LEN characters (the reply
 *     check's own floor) is collected too: its start, its end and every middle part.
 *     Never a shorter piece: the fingerprint table stores plain SHA-256, the hash of a
 *     short piece can be guessed by trying every value, and with the hashes of the next
 *     longer pieces the whole value could then be rebuilt one character at a time; from
 *     PASSWORD_MIN_LEN random characters upward no such first guess exists. The pieces
 *     are listed once per distinct value after every store was read (`collectFromText`
 *     hands the values out, `addPieceFingerprints` lists them), never per occurrence.
 *     (A) hands a value out for its pieces only when the run's LAST candidate (the run
 *     without any escape in front) is of the generated shape; a run collected because
 *     an escape letter plus a shorter run makes the length is collected as before, with
 *     no pieces, and a generated value written directly after a literal backslash gets
 *     no pieces from that copy.
 *     (B) LABELLED: the run does not have the generated shape, but it is written directly
 *     after the nearest password word (between the word's end and the run's start as the
 *     reply check sees it, an escape letter in front included, there are 1 to LABEL_GAP
 *     characters, counted raw as stored, and none is a letter or a digit of any script;
 *     a JSON escape letter b, f, n, r or t after a backslash, such as the `n` of an
 *     encoded line break, counts as part of its escape, not as a letter) and the run's
 *     LAST candidate, the value as plain text holds it, looks random, so a text is judged
 *     the same plain or JSON-encoded. A value typed by a person or made by another generator after
 *     `Contraseña:`, `"password": "…"` or `clave = …` is a mailbox password all the
 *     same. No pieces are listed for (B): such a value may have been chosen by a person,
 *     and hashes of its pieces would help guessing it.
 *     LOOKS RANDOM, at any length L: a digit, a lowercase and an uppercase letter; or no
 *     digit and at least L·DIGIT_FREE_MIN_PER_CASE/GENERATED_PASSWORD_LEN (2/7 of L)
 *     lowercase AND as many uppercase letters. The mailbox tool draws each character from
 *     letters and digits without forcing any class, so a real value may have no digit and
 *     requiring one would miss it; its letters fall in both cases about half each, while
 *     a name a person or a program writes (a word, a camelCase identifier, joined words)
 *     has one case only or only a few capitals and is left alone, after `clave` ("key",
 *     "code") too. A digit-free generated value with fewer of one case is the accepted
 *     cost, about one in eighty of the already rare digit-free values.
 *     Then the fingerprint of EVERY candidate of that run is collected: the value itself
 *     and, after a backslash, the run with the escape letter or `\uXXXX` still in front,
 *     or without its first character. Each one is the value with at most (part of) its
 *     escape in front, or a part of the value; the true value is one of the candidates
 *     (in (A) the one of the generated shape), so the fingerprint the reply check computes
 *     for it is always among them, and the pieces only add to that set.
 *     Known limits: a piece shorter than PASSWORD_MIN_LEN of a generated value is not
 *     removed (the reply check does not see runs that short, and less than that of a
 *     random value of the generated length is not a usable password); a value glued to
 *     other letters or digits (for example right after a percent escape such as `%3D`,
 *     whose two hex digits join the run) is a run of another length, so (A) does not
 *     collect it; written directly after a label (`password%3D` + value) the glued run
 *     is collected by (B) and replaced as one run, but its fingerprint covers only that
 *     glued form, so a bare copy of the value elsewhere stays unless it is collected on
 *     its own or its fingerprint is already in `mailbox_password_seen`; a labelled value
 *     with one case only or few capitals is left by design; a password that is neither
 *     generated nor written directly after a label is not covered; a value known only by
 *     its fingerprint (rule 3 (b)) has no pieces, since they cannot be listed from a
 *     hash; in the label gap an encoded line break or quote counts two characters and a
 *     `\uXXXX` escape counts as letters and digits, so near the edge, or after an escaped
 *     non-ASCII character, an encoded value is left (conservative). The accepted cost of
 *     (B): after the word `clave` (also "key", "code") a mixed-case identifier WITH a
 *     digit written directly after it in a mailbox text is taken as a password; the dry
 *     run's safety net (rule 8) shows where such a value also stands in other columns
 *     before a real run, and the dry run's counts show what would be replaced. A unit is one character, except
 *     that a whole run and a whole placeholder count as one unit, and a password word
 *     inside a placeholder is not a password word: a replacement never moves another run
 *     into reach or next to a label, so a second run collects nothing new.
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
 *     rows in ONE transaction (compare-and-set on every pruned column of the row),
 *     (f) rebuilds the full-text indexes (rule 13), (g) empties the write-ahead log
 *     (rule 14). `--apply` therefore refuses while the table does not exist (schema
 *     below v17). Limit: the table belongs to the reply check, which keeps only its
 *     newest SEEN_MAX_ROWS rows; once a write takes it above that, the service deletes
 *     the OLDEST rows, so a full table would later drop fingerprints silently, full
 *     values included, and the reply check would stop withholding them. Each generated
 *     value adds about ninety (its pieces). This script may fill at most half of the
 *     table (SCRIPT_MAX_SEEN_ROWS), so the other half stays free for the fingerprints
 *     the service records afterwards and no write of the service pushes a row out soon
 *     after a run: after (a) and (b), before anything is written (leftover temp files
 *     included), an apply run REFUSES (`SEEN_TABLE_FULL`) when the rows already in the
 *     table plus the new fingerprints (a known one collected again counts once) would
 *     exceed SCRIPT_MAX_SEEN_ROWS; exactly that many runs, and a run with no new
 *     fingerprint never refuses (it writes no row to the table and only removes copies of
 *     values already known, as when finishing an interrupted apply). The dry run then
 *     prints one line saying so. After this refusal: the stores hold more generated
 *     values than half the table can take, and the way forward is a decision to raise
 *     the reply check's row cap (a source change to SEEN_MAX_ROWS, deployed before the
 *     run); never delete rows from the table by hand and never edit this script's limit.
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
 *     earlier run (they hold pruned text) are removed by an apply run once it passed its
 *     refusals (rule 3), before the fingerprints are committed, and counted; one that
 *     cannot be removed fails the run.
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
 * 11. Binary cells: a cell stored as a BLOB is decoded as UTF-8 (invalid bytes become
 *     U+FFFD, never an error) and read like text, for collection, for the replacement
 *     check and in the safety net. Binary is never rewritten, because a byte-level edit
 *     of an unknown format could corrupt it: a hit in a BLOB of a pruned column is
 *     counted by `table.column` as `binary_hits` and fails the run; a hit in a BLOB of
 *     any other column counts with `uncovered_hits`. Running again does not clear a
 *     binary hit: convert or remove that cell by hand with the service stopped, then
 *     run again.
 * 12. The apply connection sets `PRAGMA secure_delete = ON` before its first write, so
 *     the bytes of every rewritten or removed cell and of every freed page are
 *     overwritten with zeros in the database file instead of staying in free space
 *     (the service's own connection keeps SQLite's default).
 * 13. After the row transaction, every full-text index whose content table is a store
 *     (an fts5 table with `content=<store>` in the schema; skipped when absent) is
 *     rebuilt from its table with the `'rebuild'` command, each in its own transaction.
 *     The triggers remove a changed row's old tokens from the index's answers, but the
 *     bytes stay in older segments until a merge; the rebuild writes the index anew.
 *     It runs in every apply run that has a fingerprint to prune or already known, so
 *     repeating the command after a failed rebuild redoes it; a failure is counted
 *     (`fts_rebuild_failed`) and fails the run. The dry run counts the indexes it would
 *     rebuild.
 * 14. The last step of an apply run is `wal_checkpoint(TRUNCATE)`: the write-ahead log
 *     is copied into the database file and emptied, so no old page image stays in it.
 *     When another connection keeps it from finishing, the run fails with a line saying
 *     the log still holds old pages and to run again with the service stopped.
 * 15. The closing line is `nothing to change` only on a clean run. Whenever anything
 *     above failed the run, it says `finished with failures: problems=N` instead (N is
 *     the sum of the failure counts in the notes) and to fix what the notes name, then
 *     run the same command again; it never says a re-run alone fixes it.
 *
 * The operator's wrapper takes the snapshot before --apply; this script keeps no backup
 * and never runs VACUUM. It opens the database directly (never initDatabase, which would
 * run schema migrations); the dry run opens it read-only, does none of rules 12–14 and
 * also works while the service runs. The KB files and archives are replaced by a rename
 * and the write-ahead log is truncated (rule 14); the blocks of the old files and of the
 * truncated log belong to the file system, outside what this script controls.
 *
 * VACUUM (operator, optional, service stopped): with rule 12 the removed bytes are
 * already zeroed in place, so VACUUM only returns the freed pages to the file system;
 * it is worth it after a large removal when the file size matters. It may renumber the
 * rows of a table without an INTEGER PRIMARY KEY: `jarvis_files` is one, and its index
 * `jarvis_files_fts` is keyed by row number, so after a VACUUM run
 * `INSERT INTO jarvis_files_fts(jarvis_files_fts) VALUES('rebuild')`.
 *
 * Usage (all three locations are required, in the dry run too; nothing is defaulted):
 *   npx tsx scripts/prune-mailbox-passwords.ts --db <file> --kb <dir> --archive <dir> \
 *     [--scan-only <dir>]...
 *   npx tsx scripts/prune-mailbox-passwords.ts --db <file> --kb <dir> --archive <dir> \
 *     [--scan-only <dir>]... --apply --i-stopped-the-service
 * Exit: 0 clean run (closing line `nothing to change` or, in the dry run, the hint to
 * apply); 1 finished with failures (closing line `finished with failures: problems=N`:
 * uncovered, binary, scan-only, skipped, file, read, temp, index-rebuild or checkpoint
 * failures) or stopped by an error (the message says whether to run again); 2 refused
 * (nothing written).
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
  PASSWORD_MIN_LEN,
  PASSWORD_WITHHELD_PLACEHOLDER,
  candidateRuns,
  passwordFingerprint,
} from "../src/lib/v8-4/password-gate.js";
import { SEEN_MAX_ROWS, VERIFYING_COMMANDS } from "../src/lib/v8-4/mailbox-passwords.js";
import { requireOperatorContext } from "../src/lib/operator-gate.js";
import { isMainModule as isEntryModule } from "../src/lib/is-main-module.js";

const TAG = "[prune-mailbox-passwords]";

/** Password words, lowercase; matched case-insensitively, never right after a letter. */
export const KEYWORDS = ["password", "contraseña", "contrasena", "clave", "passwd", "pwd"];
/** Mailbox words, lowercase (the accent-less spelling of buzón included, as for contraseña). */
export const MAILBOX_WORDS = ["buzón", "buzon", "mailbox", "correo"];
/** A value starts fewer than REACH units after the end of a password word. */
export const REACH = 80;
/**
 * Rule 1 (A): the length of a generated value. The mailbox tool generates every mailbox
 * password itself, always as this many ASCII letters and digits, each drawn at random
 * with no class forced (its set-password takes no value). A run of another length after
 * a password word is usually something else (a file or document identifier, a link id, a
 * key of another system), and replacing it would damage text that holds no mailbox
 * password, so it is collected only when it is written directly after a password label
 * and looks random (rule 1 (B)). A shorter run that is a piece of a collected generated
 * value (a copy cut off at some length) is removed by the piece fingerprints, down to
 * PASSWORD_MIN_LEN characters. Known limit: a value glued to other letters or digits
 * (for example right after a percent escape such as `%3D`, whose two hex digits join the
 * run) is a run of another length, so (A) does not collect it; written directly after a
 * label it is collected by (B) as the whole glued run, which covers only that same glued
 * form, never a bare copy of the value elsewhere. Values already in the fingerprint table
 * are pruned whatever their length (rule 3 (b)).
 */
export const GENERATED_PASSWORD_LEN = 28;
/**
 * Rule 1: a value of the generated length with no digit needs at least this many
 * lowercase AND at least this many uppercase letters; at any other length L the same
 * proportion applies (L·DIGIT_FREE_MIN_PER_CASE/GENERATED_PASSWORD_LEN, 2/7 of L), so the
 * generated and the labelled rule cannot drift apart. A generated value without a digit
 * has its letters drawn at random from both cases, about half each, so fewer than this
 * of one case practically never happens; a name a person or a program writes (a camelCase
 * identifier, joined words) has only a few capitals and must not be withheld for good.
 * A digit-free generated value below the threshold (about one in eighty of the already
 * rare digit-free values) is the accepted cost. With a digit the threshold does not apply.
 */
export const DIGIT_FREE_MIN_PER_CASE = 8;
/**
 * Rule 1 (B): a run that is not of the generated shape is collected only when at most
 * this many characters, none a letter or a digit, stand between the end of the nearest
 * password word and the run (`Contraseña: **value**`, `"password": "value"`,
 * `clave = value`). Characters as stored, not REACH units: a line break is allowed, and
 * a JSON escape letter after a backslash belongs to its escape, but an encoded line
 * break or quote counts two characters, so near the edge an encoded text is left where
 * its plain form is collected (conservative, a known limit).
 */
export const LABEL_GAP = 12;
/**
 * Rule 3, limit: the most rows this script lets the fingerprint table hold, half of the
 * reply check's SEEN_MAX_ROWS, so the other half stays free for what the service records
 * afterwards and its oldest-first trim does not drop a fingerprint soon after a run.
 */
const SCRIPT_MAX_SEEN_ROWS = Math.floor(SEEN_MAX_ROWS / 2);
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
 * is deliberately absent: it is the credential store. A gate's criterion and check
 * command are free text written from the task like its evidence, so all three are listed.
 */
export const DB_STORES: ReadonlyArray<DbStore> = [
  { table: "conversations", key: R, columns: ["content"] },
  { table: "tasks", key: R, columns: ["title", "description", "input", "output", "error", "metadata"] },
  { table: "runs", key: R, columns: ["input", "output", "trace", "error", "goal_graph"] },
  { table: "task_outcomes", key: R, columns: ["concern_detail"] },
  { table: "task_completion_facts", key: R, columns: ["concern_detail"] },
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
  { table: "task_gates", key: R, columns: ["criterion", "check_cmd", "evidence"] },
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

/**
 * Rule 1: a candidate looks random: a digit, a lowercase and an uppercase letter, or no
 * digit and, of its length L, at least L·DIGIT_FREE_MIN_PER_CASE/GENERATED_PASSWORD_LEN
 * (2/7 of L) letters of each case. At the generated length that is exactly
 * DIGIT_FREE_MIN_PER_CASE of each case: one proportion for both rules.
 */
function looksRandom(text: string, c: Span): boolean {
  let lower = 0;
  let upper = 0;
  let digit = 0;
  for (let i = c.start; i < c.end; i++) {
    const k = text.charCodeAt(i);
    if (k >= 97 && k <= 122) lower++;
    else if (k >= 65 && k <= 90) upper++;
    else if (k >= 48 && k <= 57) digit++;
  }
  if (digit > 0) return lower > 0 && upper > 0;
  const need = DIGIT_FREE_MIN_PER_CASE * (c.end - c.start);
  return lower * GENERATED_PASSWORD_LEN >= need && upper * GENERATED_PASSWORD_LEN >= need;
}

/** Rule 1 (A): a candidate has the shape the mailbox tool generates: the generated length, and it looks random. */
function hasGeneratedShape(text: string, c: Span): boolean {
  return c.end - c.start === GENERATED_PASSWORD_LEN && looksRandom(text, c);
}

const LETTER_OR_DIGIT_RE = /[\p{L}\p{Nd}]/u;
/** A JSON escape letter after a backslash (`\n`, `\t`, …): part of its escape, not a letter. */
const ESCAPE_LETTER_RE = /\\[bfnrt]/g;

/**
 * Rule 1 (B): the run starts 1 to LABEL_GAP characters after the password word's end
 * and none of them is a letter or a digit of any script. The gap ends where the run
 * starts as the reply check sees it, an escape letter in front included (`\n` + value:
 * the backslash is the gap's last character). Characters are counted raw, as stored, so
 * an encoded line break or quote counts two. Only the JSON escape letters b, f, n, r
 * and t after a backslash count as part of their escape; a `\uXXXX` escape in the gap
 * (an escaped non-ASCII character) holds letters or digits and leaves the value. Both
 * are conservative: a value is left, never one taken that plain text would not give.
 * The gap is never 0: every password word ends with an ASCII letter, and a run never
 * starts right after a letter or digit (it would have started earlier and contain the
 * word), so such a run is not after the word at all.
 */
function isLabelled(text: string, wordEnd: number, runStart: number): boolean {
  if (runStart - wordEnd > LABEL_GAP) return false;
  return !LETTER_OR_DIGIT_RE.test(text.slice(wordEnd, runStart).replace(ESCAPE_LETTER_RE, "\\"));
}

/**
 * Adds to `into` the fingerprints rule 1 collects from one text; returns how many runs
 * the text gave (0 = no hit). Linear in the text length. Each value collected by its
 * generated shape (rule 1 (A)) is also added to `values`, in memory only, so that
 * `addPieceFingerprints` lists its pieces once per distinct value after every text was
 * read; this function never lists pieces itself.
 */
export function collectFromText(text: string, into: Set<string>, values?: Set<string>): number {
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
    // The run's last candidate is the run without any escape in front: the value as the
    // plain text holds it. Pieces are listed from it only, and only when it is itself of
    // the generated shape, so no string that is not a piece of a generated value is
    // hashed; given up: a generated value written directly after a literal backslash
    // (its first character then counts as an escape letter) gets no pieces from that copy.
    const last = g.candidates[g.candidates.length - 1]!;
    if (g.candidates.some((c) => hasGeneratedShape(text, c))) {
      if (hasGeneratedShape(text, last)) values?.add(text.slice(last.start, last.end));
    } else if (!isLabelled(text, e, g.start) || !looksRandom(text, last)) continue;
    for (const c of g.candidates) into.add(passwordFingerprint(text.slice(c.start, c.end)));
    given++;
  }
  return given;
}

/**
 * Rule 1 (A), pieces: adds to `into` the fingerprint of every contiguous piece of each
 * value with PASSWORD_MIN_LEN or more characters (the value itself included). Only for
 * values of the generated shape (what `collectFromText` hands out): never a piece shorter
 * than PASSWORD_MIN_LEN, whose hash could be guessed and would open the way to rebuilding
 * the value from the hashes of the longer pieces, and never a piece of a labelled value
 * (rule 1 (B)), which a person may have chosen.
 */
export function addPieceFingerprints(values: Iterable<string>, into: Set<string>): void {
  for (const v of values) {
    for (let len = PASSWORD_MIN_LEN; len <= v.length; len++) {
      for (let i = 0; i + len <= v.length; i++) into.add(passwordFingerprint(v.slice(i, i + len)));
    }
  }
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
  /** Distinct fingerprints collected (with context) from this store; pieces (rule 1 (A)) count in the total only. */
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
  /** Distinct fingerprints collected from the stores in this run: every candidate and every piece (rule 1). */
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
  /** `table.column` → BLOB cells of pruned columns that hold a pruned run (rule 11, never rewritten). */
  binary: Map<string, number>;
  /** Full-text indexes rebuilt (apply) or that would be rebuilt (dry run), rule 13. */
  fts: number;
  ftsFailed: number;
  /** The final checkpoint could not empty the write-ahead log (rule 14). */
  checkpointBusy: boolean;
  /** Sum of every failure count; the run is ok only when it is 0. */
  problems: number;
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

/** Rule 11: a string as it is; a BLOB decoded as UTF-8 (invalid bytes become U+FFFD); other cells have no text. */
function cellText(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (Buffer.isBuffer(v)) return v.toString("utf8");
  return null;
}

/** Rule 13: the fts5 tables in the schema whose `content=` table is one of `tables`. */
function ftsIndexesOver(db: Database.Database, tables: ReadonlySet<string>): string[] {
  const rows = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE%'")
    .all() as Array<{ name: string; sql: string | null }>;
  const out: string[] = [];
  for (const r of rows) {
    const args = /\bUSING\s+fts5\s*\(([\s\S]*)\)\s*$/i.exec(r.sql ?? "")?.[1];
    const content = args ? /\bcontent\s*=\s*['"]?([A-Za-z_][A-Za-z0-9_]*)/i.exec(args)?.[1] : undefined;
    if (content !== undefined && tables.has(content)) out.push(r.name);
  }
  return out.sort();
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
        const text = cellText(v);
        if (text !== null && hasKnownRun(text, fps)) {
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
    binary: new Map(),
    fts: 0,
    ftsFailed: 0,
    checkpointBusy: false,
    problems: 0,
  };
  const db = opts.apply ? new BetterSqlite3(opts.dbPath, { fileMustExist: true }) : openForDryRun(opts.dbPath);
  // Set once the fingerprints are durable: from then on any failure leaves a run that a
  // re-run finishes, and the message must say so.
  let committed = false;
  try {
    if (opts.apply) {
      db.pragma("busy_timeout = 5000");
      // Rule 12: freed and rewritten bytes are zeroed, before the first write.
      db.pragma("secure_delete = ON");
    }
    result.seenTable =
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(SEEN_TABLE) !== undefined;
    // Rule 3: without the table the collected set cannot be made durable.
    if (opts.apply && !result.seenTable) throw new Refusal("SEEN_TABLE_ABSENT");
    const { present, absent } = presentStores(db);
    result.tablesAbsent = absent;
    const kb = listKbFiles(opts.kbRoot);
    const ar = listArchives(opts.archiveDir);

    // (a) Collect from every store before anything changes; per store for the report.
    // `values`: the generated values seen (memory only), for their pieces after the loop.
    const values = new Set<string>();
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
          const text = cellText(v);
          if (text !== null) gave += collectFromText(text, mine, values);
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
      if (collectFromText(text, kbMine, values) > 0) kbSources++;
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
      for (const line of text.split("\n")) gave += collectFromText(line, arMine, values);
      if (gave > 0) archiveSources++;
    }
    for (const f of [...kbMine, ...arMine]) fresh.add(f);
    // Rule 1 (A): the pieces of every generated value, once per distinct value, before (c).
    addPieceFingerprints(values, fresh);
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
    // Rule 3, limit: the service deletes the oldest rows once the table is above its cap,
    // so an apply that would take it there refuses before its first write.
    // A run that adds nothing never refuses: it only removes copies of values already known.
    if (opts.apply && toAdd.length > 0 && known.size + toAdd.length > SCRIPT_MAX_SEEN_ROWS) throw new Refusal("SEEN_TABLE_FULL");

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
            if (Buffer.isBuffer(v)) {
              // Rule 11: binary is read, never rewritten; a hit is counted and fails the run.
              const k = `${s.table}.${c}`;
              if (hasKnownRun(v.toString("utf8"), fps)) result.binary.set(k, (result.binary.get(k) ?? 0) + 1);
              continue;
            }
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
    // (f) Rule 13: each full-text index over a store is rebuilt from its table, after the rows are final.
    const fts = fps.size > 0 ? ftsIndexesOver(db, new Set(present.map((s) => s.table))) : [];
    result.fts = fts.length;
    if (opts.apply) {
      for (const name of fts) {
        try {
          db.transaction(() => db.prepare(`INSERT INTO "${name}"("${name}") VALUES('rebuild')`).run()).immediate();
        } catch (err) {
          result.ftsFailed++;
          log(`${TAG} ERROR store=fts index=${name} code=${errorCode(err)}`);
        }
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
    // (g) Rule 14: last, the write-ahead log is copied into the file and emptied.
    if (opts.apply) {
      const [cp] = db.pragma("wal_checkpoint(TRUNCATE)") as Array<{ busy: number }>;
      result.checkpointBusy = cp !== undefined && cp.busy !== 0;
    }

    const sum = (m: Map<string, number>): number => [...m.values()].reduce((a, n) => a + n, 0);
    result.problems =
      kbFailed +
      arFailed +
      kb.unreadable +
      kbLinks +
      kbRead.failed +
      kbRead.notUtf8 +
      arRead.failed +
      arRead.notUtf8 +
      arSkipped.symlinks +
      arSkipped.links +
      sum(skippedRows) +
      arSkipped.json +
      tempsFailed +
      sum(result.uncovered) +
      result.scans.reduce((a, s) => a + s.hits + s.overCap + s.unreadable, 0) +
      sum(result.binary) +
      result.ftsFailed +
      (result.checkpointBusy ? 1 : 0);
    result.ok = result.problems === 0;

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
  // Rule 3, limit: said before the operator stops the service for an apply that would refuse.
  if (!apply && r.fingerprintsAdded > 0 && r.known + r.fingerprintsAdded > SCRIPT_MAX_SEEN_ROWS) {
    log(
      `${TAG} fingerprint_limit=${SCRIPT_MAX_SEEN_ROWS} (half of the table cap ${SEEN_MAX_ROWS}): known plus to_add is above it — --apply refuses (code=SEEN_TABLE_FULL) and writes nothing`,
    );
  }
  for (const [label, n] of r.derived) log(`${TAG} derived_blob=${label} pruned_rows_with_blob=${n} (left as they are)`);
  const uncovered = [...r.uncovered.values()].reduce((a, n) => a + n, 0);
  log(`${TAG} uncovered_hits=${uncovered}`);
  for (const [col, n] of r.uncovered) log(`${TAG} uncovered column=${col} cells=${n} (not rewritten)`);
  log(`${TAG} binary_hits=${[...r.binary.values()].reduce((a, n) => a + n, 0)}`);
  for (const [col, n] of r.binary) log(`${TAG} binary column=${col} cells=${n} (binary, not rewritten: this script never rewrites binary; convert or remove that cell by hand with the service stopped, then run again)`);
  log(
    apply
      ? `${TAG} fts_rebuilt=${r.fts - r.ftsFailed}${r.ftsFailed > 0 ? ` fts_rebuild_failed=${r.ftsFailed}` : ""}`
      : `${TAG} fts_to_rebuild=${r.fts}`,
  );
  if (r.checkpointBusy) {
    log(`${TAG} checkpoint busy: the write-ahead log file still holds old pages — run the same command again with the service stopped`);
  }
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
  if (pending > 0 && !apply) log(`${TAG} dry run — nothing written; pass --apply --i-stopped-the-service to write`);
  // Rule 15: "nothing to change" only on a clean run.
  if (!r.ok) {
    log(`${TAG} finished with failures: problems=${r.problems} (see the notes above); fix them and run the same command again`);
  } else if (pending === 0) {
    log(`${TAG} nothing to change`);
  }
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
