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
 *        [--runs 7]: CONFIRMED, REFUTED or COUNTING for "at most K complaints
 *        in the type's first N finished runs started at or after --since";
 *        --since must fall inside the --days window before --now.
 * Every value is validated here; the SQL only ever sees @since/@now strings
 * regenerated from a parsed Date.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { complaintsSql } from "../src/complaints/query.js";
import { buildDigest, renderDigest, type TaskRow } from "../src/complaints/digest.js";
import { buildVerdict, renderVerdict } from "../src/complaints/verdict.js";

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
      days: { type: "string", default: "30" },
      last: { type: "string", default: "7" },
      min: { type: "string", default: "5" },
      type: { type: "string" },
      json: { type: "boolean" },
      now: { type: "string" },
      verdict: { type: "boolean" },
      since: { type: "string" },
      "max-complaints": { type: "string" },
      runs: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  }).values;
} catch (err) {
  fail((err as Error).message);
}

const days = int("days", parsed.days, 1, 365);
const last = int("last", parsed.last, 1, 100);
const min = int("min", parsed.min, 1, last);
const type = parsed.type;
if (type !== undefined && !/^(ritual|schedule):[A-Za-z0-9_-]+$/.test(type)) {
  fail("--type must match ^(ritual|schedule):[A-Za-z0-9_-]+$");
}
const ISO_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:\d\d)$/;
if (parsed.now !== undefined && !ISO_TIME.test(parsed.now)) {
  fail("--now must be an ISO time with Z or an offset, e.g. 2026-11-20T18:00:00Z");
}
const nowMs = parsed.now === undefined ? Date.now() : Date.parse(parsed.now);
if (Number.isNaN(nowMs)) fail("--now must be a date");
const now = new Date(nowMs).toISOString();

let verdictOpts: { type: string; since: string; maxComplaints: number; runs: number } | undefined;
if (parsed.verdict) {
  if (type === undefined) fail("--verdict needs --type");
  if (parsed.since === undefined) fail("--verdict needs --since");
  if (parsed["max-complaints"] === undefined) fail("--verdict needs --max-complaints");
  const runs = int("runs", parsed.runs ?? "7", 1, 100);
  const maxComplaints = int("max-complaints", parsed["max-complaints"], 0, 9999);
  if (!ISO_TIME.test(parsed.since)) fail("--since must be an ISO time with Z or an offset, e.g. 2026-11-20T18:00:00Z");
  const sinceMs = Date.parse(parsed.since);
  if (Number.isNaN(sinceMs)) fail("--since must be a date");
  // The SQL window is (now - days, now]: a --since at or before its start
  // could miss runs, so it is refused rather than half counted.
  if (sinceMs <= nowMs - days * 86_400_000) fail(`--since must be later than --now minus --days (${days} days)`);
  verdictOpts = { type, since: new Date(sinceMs).toISOString(), maxComplaints, runs };
} else if (parsed.since !== undefined || parsed["max-complaints"] !== undefined || parsed.runs !== undefined) {
  fail("--since, --max-complaints and --runs need --verdict");
}

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
  if (verdictOpts) {
    const v = buildVerdict(rows, { now, ...verdictOpts });
    process.stdout.write(parsed.json ? `${JSON.stringify(v, null, 2)}\n` : renderVerdict(v));
  } else {
    const digest = buildDigest(rows, { now, days, last, min, type });
    process.stdout.write(parsed.json ? `${JSON.stringify(digest, null, 2)}\n` : renderDigest(digest));
  }
}
