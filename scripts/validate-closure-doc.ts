#!/usr/bin/env node
/**
 * v7.7 Spine 1 Phase 2c — closure-doc validator CLI.
 *
 * Thin wrapper around `src/audit/closure-doc-validator.ts`. Reads a
 * CLOSURE.md path from argv, runs validation, prints the report, exits
 * with the validator's verdict code.
 *
 * Usage:
 *   npx tsx scripts/validate-closure-doc.ts <path/to/CLOSURE.md>
 *
 * Exit codes (mirror `mc-ctl audit-claim` cli convention — src/audit/cli.ts):
 *   0 = clean — every scoreboard claim has an adjacent verified_against
 *   1 = warnings — one or more unverified claims found
 *   2 = parse / IO / argv error
 *
 * NOT a continuous-CI gate. Closures are infrequent enough that a manual
 * pre-tag run is sufficient. Spine 7's `mc audit-closure` continuity tool
 * will invoke this same library later.
 */

import { readFileSync } from "node:fs";
import {
  validateClosureDoc,
  renderReport,
} from "../src/audit/closure-doc-validator.js";

const argvPath = process.argv[2];
if (!argvPath) {
  process.stderr.write(
    "validate-closure-doc: usage: validate-closure-doc.ts <path/to/CLOSURE.md>\n",
  );
  process.exit(2);
}

let contents: string;
try {
  contents = readFileSync(argvPath, "utf-8");
} catch (e) {
  process.stderr.write(
    `validate-closure-doc: cannot read ${argvPath}: ${e instanceof Error ? e.message : String(e)}\n`,
  );
  process.exit(2);
}

const report = validateClosureDoc(argvPath, contents);
process.stdout.write(renderReport(report));
process.exit(report.exitCode);
