/**
 * The MexicoNecesario tweet ritual's G1 gate (docs/planning/gates/
 * mexiconecesario-tweet-diario.gates.json): it must pass the same parser
 * `mc-ctl gates set-ritual` runs (scripts/gates-validate.ts), the shell guard,
 * and the undefined-variable guard (runnable only because the harness injects
 * MC_TASK_ID), and the real executor must grade it on a receipt bound to THIS
 * task — MET when a receipt carries the task's id, FAILED (not abandoned) when
 * only another task's receipt exists or the file is missing. The publisher
 * writes the receipt only on a toast that confirms the send, stamped with the
 * MC_TASK_ID that shell_exec hands its child (queue 4aa).
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseGateSpecs } from "./gates.js";
import { expectMatches, runCheck, runShellCheck, undefinedShellVars } from "./gate-check.js";
import { validateShellCommand } from "../../tools/builtin/shell.js";

const { appendReceipt } = createRequire(import.meta.url)("../../../scripts/lib/x-post-receipt.cjs") as {
  appendReceipt: (file: string, receipt: unknown) => void;
};

const SPEC_FILE = resolve(__dirname, "../../../docs/planning/gates/mexiconecesario-tweet-diario.gates.json");
const RECEIPTS_FILE = "/root/claude/mission-control/data/x-post-receipts/mexiconecesario.jsonl";
const TASK_ID = "t-ritual-gate";

const [spec] = parseGateSpecs(readFileSync(SPEC_FILE, "utf-8"));
const check = spec!.check!;

let scratch: string | undefined;
afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

/** A scratch receipts file written by the publisher's own helper, one receipt per task id. */
function receiptsFor(...taskIds: (string | null)[]): string {
  scratch = mkdtempSync(join(tmpdir(), "mn-gate-"));
  const file = join(scratch, "mexiconecesario.jsonl");
  for (const task_id of taskIds) {
    appendReceipt(file, { ts: "2026-10-20T19:00:00.000Z", account: "mn", url: "u", toast: "Your post was sent.", task_id });
  }
  return file;
}

async function runAgainst(file: string, taskId = TASK_ID) {
  const row = { check_cmd: check.replace(RECEIPTS_FILE, file), expect: spec!.expect ?? null };
  return runCheck(row, { timeoutMs: 10_000, exec: runShellCheck, taskId });
}

describe("MexicoNecesario ritual gate G1", () => {
  it("is accepted by the set-ritual parser as one G1 shell gate", () => {
    expect(parseGateSpecs(readFileSync(SPEC_FILE, "utf-8"))).toHaveLength(1);
    expect(spec).toMatchObject({ id: "G1", expect: "gt 0" });
    expect(spec!.abandonReason).toBeUndefined();
    expect(check).toContain(RECEIPTS_FILE);
  });

  it("passes the shell guard and is runnable only with the harness's MC_TASK_ID", () => {
    expect(validateShellCommand(check).allowed).toBe(true);
    expect(undefinedShellVars(check, { MC_TASK_ID: "x" })).toEqual([]);
    expect(undefinedShellVars(check, {})).toEqual(["MC_TASK_ID"]);
  });

  it("is MET when a receipt carries this task's id", async () => {
    const r = await runAgainst(receiptsFor("t-other", TASK_ID, null));
    expect(r.notRunnable).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(expectMatches("gt 0", r.evidence)).toBe(true);
  });

  it("FAILS (runnable, not abandoned) when only another task's receipt exists", async () => {
    const r = await runAgainst(receiptsFor("t-other", `${TASK_ID}-2`, null));
    expect(r.notRunnable).toBeUndefined();
    expect(r.ok).toBe(false);
  });

  it("FAILS (runnable, not abandoned) when the harness has no task id (empty MC_TASK_ID)", async () => {
    const r = await runAgainst(receiptsFor(null, "t-other"), "");
    expect(r.notRunnable).toBeUndefined();
    expect(r.ok).toBe(false);
  });

  it("FAILS (runnable, not abandoned) when the receipts file is missing", async () => {
    scratch = mkdtempSync(join(tmpdir(), "mn-gate-"));
    const r = await runAgainst(join(scratch, "mexiconecesario.jsonl"));
    expect(r.notRunnable).toBeUndefined();
    expect(r.ok).toBe(false);
    expect(r.evidence).toMatch(/^not a number: /);
    expect(r.evidence).not.toMatch(/not found/);
  });

  it("names the same receipt file and task id the publisher writes", () => {
    const src = readFileSync(resolve(__dirname, "../../../scripts/post-mexiconecesario.cjs"), "utf-8");
    expect(src).toContain("__dirname, '..', 'data', 'x-post-receipts', 'mexiconecesario.jsonl'");
    expect(src).toContain("task_id: process.env.MC_TASK_ID || null");
    expect(check).toContain(`"\\"task_id\\":\\"$MC_TASK_ID\\""`);
    expect(check.endsWith(` ${RECEIPTS_FILE}`)).toBe(true);
  });
});
