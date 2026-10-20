/**
 * The MexicoNecesario tweet ritual's G1 gate (docs/planning/gates/
 * mexiconecesario-tweet-diario.gates.json): it must pass the same parser
 * `mc-ctl gates set-ritual` runs (scripts/gates-validate.ts), the shell guard,
 * and the undefined-variable guard, and the real executor must grade it on the
 * receipt file's mtime — MET when fresh, FAILED (not abandoned) when absent or
 * older than 60 min. The publisher writes the receipt only on a toast that
 * confirms the send.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseGateSpecs } from "./gates.js";
import { expectMatches, runCheck, runShellCheck, undefinedShellVars } from "./gate-check.js";
import { validateShellCommand } from "../../tools/builtin/shell.js";

const SPEC_FILE = resolve(__dirname, "../../../docs/planning/gates/mexiconecesario-tweet-diario.gates.json");
const RECEIPTS_DIR = "/root/claude/mission-control/data/x-post-receipts";

const [spec] = parseGateSpecs(readFileSync(SPEC_FILE, "utf-8"));
const check = spec!.check!;

let scratch: string | undefined;
afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

/** A scratch receipts dir holding one receipt file whose mtime is `ageMin` minutes old. */
function receiptAged(ageMin: number): string {
  scratch = mkdtempSync(join(tmpdir(), "mn-gate-"));
  const file = join(scratch, "mexiconecesario.jsonl");
  writeFileSync(file, '{"ts":"x"}\n');
  const at = new Date(Date.now() - ageMin * 60 * 1000);
  utimesSync(file, at, at);
  return scratch;
}

async function runAgainst(dir: string) {
  const row = { check_cmd: check.replace(RECEIPTS_DIR, dir), expect: spec!.expect ?? null };
  return runCheck(row, { timeoutMs: 10_000, exec: runShellCheck, taskId: "t-ritual-gate" });
}

describe("MexicoNecesario ritual gate G1", () => {
  it("is accepted by the set-ritual parser as one G1 shell gate", () => {
    expect(parseGateSpecs(readFileSync(SPEC_FILE, "utf-8"))).toHaveLength(1);
    expect(spec).toMatchObject({ id: "G1", expect: "gt 0" });
    expect(spec!.abandonReason).toBeUndefined();
    expect(check).toContain(RECEIPTS_DIR);
    expect(check).not.toContain("$");
  });

  it("passes the shell guard and references no undefined variable", () => {
    expect(validateShellCommand(check).allowed).toBe(true);
    expect(undefinedShellVars(check, {})).toEqual([]);
  });

  it("is MET when a fresh receipt file exists", async () => {
    scratch = mkdtempSync(join(tmpdir(), "mn-gate-"));
    writeFileSync(join(scratch, "mexiconecesario.jsonl"), '{"ts":"x"}\n');
    const r = await runAgainst(scratch);
    expect(r.notRunnable).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(expectMatches("gt 0", r.evidence)).toBe(true);
  });

  it("FAILS (runnable, not abandoned) when the receipts dir is empty", async () => {
    scratch = mkdtempSync(join(tmpdir(), "mn-gate-"));
    const r = await runAgainst(scratch);
    expect(r.notRunnable).toBeUndefined();
    expect(r.ok).toBe(false);
    expect(r.evidence).not.toMatch(/not found/);
  });

  it("is MET when the receipt file is 20 min old (inside the 60 min window)", async () => {
    const r = await runAgainst(receiptAged(20));
    expect(r.notRunnable).toBeUndefined();
    expect(r.ok).toBe(true);
  });

  it.each([70, 120])("FAILS when the receipt file is %i min old", async (ageMin) => {
    const r = await runAgainst(receiptAged(ageMin));
    expect(r.notRunnable).toBeUndefined();
    expect(r.ok).toBe(false);
  });

  it("names the same receipt file the publisher writes", () => {
    const src = readFileSync(resolve(__dirname, "../../../scripts/post-mexiconecesario.cjs"), "utf-8");
    expect(src).toContain("__dirname, '..', 'data', 'x-post-receipts', 'mexiconecesario.jsonl'");
    expect(check).toContain("/root/claude/mission-control/data/x-post-receipts ");
    expect(check).toContain("-name mexiconecesario.jsonl");
  });
});
