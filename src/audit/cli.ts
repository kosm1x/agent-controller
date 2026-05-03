/**
 * V8 substrate S2 — audit CLI entry point.
 *
 * Invoked by `mc-ctl audit-claim` via `node dist/audit/cli.js <json-req>`.
 * Initializes the database singleton against the standard mc.db path,
 * runs the audit, prints rendered output, and exits with verdict-coded
 * status.
 *
 * Exit codes:
 *   0 = verified (no warnings, sample sufficient)
 *   1 = warnings present
 *   2 = insufficient n (no warnings other than small-n) — caller's
 *       choice whether to merge with 1
 *   3 = invalid argv / module / DB error (stderr describes)
 */

import { resolve } from "node:path";
import { initDatabase } from "../db/index.js";
import {
  runAudit,
  renderAuditResult,
  type AuditClaimRequest,
} from "./self-audit.js";

const DEFAULT_DB =
  process.env.MC_DB_PATH ?? resolve(process.cwd(), "data/mc.db");

function fail(msg: string, code = 3): never {
  process.stderr.write(`audit-cli: ${msg}\n`);
  process.exit(code);
}

const argvJson = process.argv[2];
if (!argvJson) fail("missing JSON request as first argument");

let req: AuditClaimRequest;
try {
  req = JSON.parse(argvJson) as AuditClaimRequest;
} catch (e) {
  fail(`invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
}

if (!req.metric || !req.window) {
  fail("request must include 'metric' and 'window'");
}

try {
  initDatabase(DEFAULT_DB);
} catch (e) {
  fail(`DB init failed: ${e instanceof Error ? e.message : String(e)}`);
}

let result;
try {
  result = runAudit(req);
} catch (e) {
  fail(`audit run failed: ${e instanceof Error ? e.message : String(e)}`);
}

process.stdout.write(renderAuditResult(result) + "\n");

if (result.verified) process.exit(0);
if (result.warnings.length === 1 && result.warnings[0] === "small-n")
  process.exit(2);
process.exit(1);
