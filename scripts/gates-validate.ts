#!/usr/bin/env tsx
/**
 * V8.4 — validate a gates JSON payload (file path or "-" for stdin) with the
 * same parser the runtime uses. Exit 0 = valid (prints the normalized JSON),
 * exit 2 = invalid (prints the reason). Used by `mc-ctl gates set-ritual`
 * BEFORE the SQL write so a malformed ledger never lands on a schedule.
 * Read-only: touches no database.
 */
import { readFileSync } from "node:fs";
import { parseGateSpecs } from "../src/lib/v8-4/gates.js";

const src = process.argv[2];
if (!src) {
  console.error("usage: gates-validate.ts <file.json|->");
  process.exit(2);
}
const raw = readFileSync(src === "-" ? 0 : src, "utf-8");
try {
  const specs = parseGateSpecs(raw);
  if (specs.length === 0) {
    console.error("gates: empty array — nothing to set");
    process.exit(2);
  }
  process.stdout.write(JSON.stringify(specs));
} catch (err) {
  console.error(`gates: invalid — ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}
