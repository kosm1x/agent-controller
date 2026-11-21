/**
 * Complaints digest CLI. Never opens a database: run it through
 * scripts/complaints-digest.sh, which feeds it `sqlite3 -readonly -json` rows.
 *
 *   --print-sql [--facts-table] [flags]  print the sqlite3 script (bound
 *                        parameters + SELECT); --facts-table, passed by the
 *                        wrapper when the database has task_completion_facts,
 *                        selects the SQL that reads it
 *   [flags] < rows.json  print the digest of the rows on stdin
 *
 * Flags: --days 30  --last 7  --min 5  --type <ritual|schedule>:<id>  --json
 *        --now <ISO time> (default: the current time)
 * Verdict mode: --verdict --type <key> --since <ISO time> --max-complaints K
 *        [--runs 7]: CONFIRMED, REFUTED or COUNTING; the rule is in
 *        src/complaints/verdict.ts. K must be below N, and --since (floored
 *        to the second) must fall inside the --days window before --now.
 * Ledger mode: --ledger <file> [--now <ISO time>]: every prediction in the
 *        file (docs/planning/predictions.jsonl), checked over the 30 days
 *        before --now; the rules are in src/complaints/ledger.ts. The file is
 *        read and validated before any rows are, and never written. Exit 2 on
 *        any file problem, 3 when a recorded closure disagrees with the recheck.
 * Every value is validated here; the SQL only ever sees @since/@now strings
 * regenerated from a parsed Date.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { complaintsSql } from "../src/complaints/query.js";
import { buildDigest, renderDigest, type TaskRow } from "../src/complaints/digest.js";
import { checkRow, LEDGER_DAYS, parseLedger, renderLedger, type Prediction } from "../src/complaints/ledger.js";
import { buildVerdict, ISO_TIME, nowIsAfterClock, renderVerdict, TYPE_PATTERN } from "../src/complaints/verdict.js";

function fail(msg: string): never {
  process.stderr.write(`complaints-digest: ${msg}\n`);
  process.exit(2);
}

function int(name: string, value: string, lo: number, hi: number): number {
  if (!/^\d{1,4}$/.test(value)) fail(`--${name} must be an integer`);
  const n = Number(value);
  if (n < lo || n > hi) fail(`--${name} must be between ${lo} and ${hi}`);
  return n;
}

/** UTC 'YYYY-MM-DD HH:MM:SS', the shape of tasks.created_at. */
const sqlTime = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

let parsed;
try {
  parsed = parseArgs({
    options: {
      "print-sql": { type: "boolean" },
      "facts-table": { type: "boolean" },
      days: { type: "string" },
      last: { type: "string" },
      min: { type: "string" },
      type: { type: "string" },
      json: { type: "boolean" },
      now: { type: "string" },
      verdict: { type: "boolean" },
      since: { type: "string" },
      "max-complaints": { type: "string" },
      runs: { type: "string" },
      ledger: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  }).values;
} catch (err) {
  fail((err as Error).message);
}

const ledgerFile = parsed.ledger;
if (ledgerFile !== undefined) {
  // Ledger rows carry their own type, since, K and N, and the window is fixed:
  // any of these flags would be ignored, so it is refused instead.
  for (const flag of ["verdict", "type", "since", "max-complaints", "runs", "days", "last", "min", "json"] as const) {
    if (parsed[flag] !== undefined) fail(`--ledger cannot be used with --${flag}`);
  }
}
const days = ledgerFile === undefined ? int("days", parsed.days ?? "30", 1, 365) : LEDGER_DAYS;
const last = int("last", parsed.last ?? "7", 1, 100);
const min = int("min", parsed.min ?? "5", 1, last);
const type = parsed.type;
if (type !== undefined && !TYPE_PATTERN.test(type)) fail(`--type must match ${TYPE_PATTERN.source}`);
if (parsed.now !== undefined && !ISO_TIME.test(parsed.now)) {
  fail("--now must be an ISO time with Z or an offset, e.g. 2026-11-20T18:00:00Z");
}
const nowMs = parsed.now === undefined ? Date.now() : Date.parse(parsed.now);
if (Number.isNaN(nowMs)) fail("--now must be a date");
const now = new Date(nowMs).toISOString();

// The clock is read here, after the wrapper pinned its --now.
const judged = parsed.verdict ? "--verdict" : ledgerFile === undefined ? null : "--ledger";
if (judged && nowIsAfterClock(nowMs, Date.now())) fail(`--now must not be later than the current time with ${judged}`);

let verdictOpts: { type: string; since: string; maxComplaints: number; runs: number } | undefined;
if (parsed.verdict) {
  if (type === undefined) fail("--verdict needs --type");
  if (parsed.since === undefined) fail("--verdict needs --since");
  if (parsed["max-complaints"] === undefined) fail("--verdict needs --max-complaints");
  const runs = int("runs", parsed.runs ?? "7", 1, 100);
  const maxComplaints = int("max-complaints", parsed["max-complaints"], 0, 9999);
  if (maxComplaints >= runs) fail(`--max-complaints must be below --runs (${runs}): K >= N is a prediction that cannot be refuted`);
  if (!ISO_TIME.test(parsed.since)) fail("--since must be an ISO time with Z or an offset, e.g. 2026-11-20T18:00:00Z");
  const parsedSince = Date.parse(parsed.since);
  if (Number.isNaN(parsedSince)) fail("--since must be a date");
  // tasks.created_at has whole seconds: a run stamped in the second of
  // --since is at or after it.
  const sinceMs = Math.floor(parsedSince / 1000) * 1000;
  // The SQL window is (now - days, now]: a --since at or before its start
  // could miss runs, so it is refused rather than half counted.
  if (sinceMs <= nowMs - days * 86_400_000) fail(`--since must be later than --now minus --days (${days} days)`);
  verdictOpts = { type, since: new Date(sinceMs).toISOString(), maxComplaints, runs };
} else if (parsed.since !== undefined || parsed["max-complaints"] !== undefined || parsed.runs !== undefined) {
  fail("--since, --max-complaints and --runs need --verdict");
}

/** The ledger's predictions, or every problem in the file on stderr and exit 2. */
function readLedger(file: string): Prediction[] {
  let src: string;
  try {
    src = readFileSync(file, "utf8");
  } catch (err) {
    fail(`ledger ${file}: cannot be read (${(err as NodeJS.ErrnoException).code ?? "error"})`);
  }
  const { predictions, problems } = parseLedger(src);
  if (problems.length === 0) return predictions;
  for (const p of problems) process.stderr.write(`complaints-digest: ledger ${file} line ${p.line}: ${p.reason}\n`);
  process.exit(2);
}
// Read on the --print-sql call too, so a bad file stops the wrapper before sqlite3.
const predictions = ledgerFile === undefined ? undefined : readLedger(ledgerFile);

if (parsed["print-sql"]) {
  process.stdout.write(
    [
      ".parameter init",
      `.parameter set @since "'${sqlTime(nowMs - days * 86_400_000)}'"`,
      `.parameter set @now "'${sqlTime(nowMs)}'"`,
      complaintsSql(parsed["facts-table"] === true),
      "",
    ].join("\n"),
  );
} else {
  const input = readFileSync(0, "utf8").trim();
  const rows = (input ? JSON.parse(input) : []) as TaskRow[];
  if (ledgerFile !== undefined && predictions) {
    const checks = predictions.map((p) => checkRow(p, rows, now));
    process.stdout.write(renderLedger(ledgerFile, now, checks));
    if (checks.some((c) => c.mismatch)) process.exitCode = 3;
  } else if (verdictOpts) {
    const v = buildVerdict(rows, { now, ...verdictOpts });
    process.stdout.write(parsed.json ? `${JSON.stringify(v, null, 2)}\n` : renderVerdict(v));
  } else {
    const digest = buildDigest(rows, { now, days, last, min, type });
    process.stdout.write(parsed.json ? `${JSON.stringify(digest, null, 2)}\n` : renderDigest(digest));
  }
}
