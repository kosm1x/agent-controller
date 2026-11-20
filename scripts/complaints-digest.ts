/**
 * Complaints digest CLI. Never opens a database: run it through
 * scripts/complaints-digest.sh, which feeds it `sqlite3 -readonly -json` rows.
 *
 *   --print-sql [flags]  print the sqlite3 script (bound parameters + SELECT)
 *   [flags] < rows.json  print the digest of the rows on stdin
 *
 * Flags: --days 30  --last 7  --min 5  --type <ritual|schedule>:<id>  --json
 *        --now <ISO time> (default: the current time)
 * Every value is validated here; the SQL only ever sees @since/@now strings
 * regenerated from a parsed Date.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { COMPLAINTS_SQL } from "../src/complaints/query.js";
import { buildDigest, renderDigest, type TaskRow } from "../src/complaints/digest.js";

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
      days: { type: "string", default: "30" },
      last: { type: "string", default: "7" },
      min: { type: "string", default: "5" },
      type: { type: "string" },
      json: { type: "boolean" },
      now: { type: "string" },
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
if (parsed.now !== undefined && !/^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:\d\d)$/.test(parsed.now)) {
  fail("--now must be an ISO time with Z or an offset, e.g. 2026-11-20T18:00:00Z");
}
const nowMs = parsed.now === undefined ? Date.now() : Date.parse(parsed.now);
if (Number.isNaN(nowMs)) fail("--now must be a date");
const now = new Date(nowMs).toISOString();

if (parsed["print-sql"]) {
  process.stdout.write(
    [
      ".parameter init",
      `.parameter set @since "'${sqlTime(nowMs - days * 86_400_000)}'"`,
      `.parameter set @now "'${sqlTime(nowMs)}'"`,
      COMPLAINTS_SQL,
      "",
    ].join("\n"),
  );
} else {
  const input = readFileSync(0, "utf8").trim();
  const rows = (input ? JSON.parse(input) : []) as TaskRow[];
  const digest = buildDigest(rows, { now, days, last, min, type });
  process.stdout.write(parsed.json ? `${JSON.stringify(digest, null, 2)}\n` : renderDigest(digest));
}
