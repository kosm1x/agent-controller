/**
 * The per-task proven set is a leaf: numbers.ts frees it, so it must not
 * pull the database (or anything that reaches the registry) into numbers.ts.
 */
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  _resetMailboxProven,
  forgetProvenPasswords,
  provenPasswords,
  recordUserPasswordProof,
} from "./mailbox-proven.js";
import { passwordFingerprint } from "./password-gate.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../..");
const IMPORT_RE = /from "(\.{1,2}\/[^"]+)"/g;

function relativeImports(file: string): string[] {
  const text = readFileSync(file, "utf8");
  return [...text.matchAll(IMPORT_RE)].map((m) =>
    resolve(dirname(file), m[1].replace(/\.js$/, ".ts")),
  );
}

function importClosure(file: string): string[] {
  const seen = new Set<string>();
  const queue = [file];
  while (queue.length > 0) {
    const next = queue.pop()!;
    for (const dep of relativeImports(next)) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      queue.push(dep);
    }
  }
  return [...seen].map((f) => relative(SRC, f)).sort();
}

describe("mailbox-proven is a leaf", () => {
  it("imports nothing from db/, tools/ or messaging/, directly or transitively", () => {
    const closure = importClosure(join(HERE, "mailbox-proven.ts"));
    expect(closure).toEqual([
      "lib/v8-4/ledger-lines.ts",
      "lib/v8-4/password-gate.ts",
    ]);
  });

  it("numbers.ts reaches the mailbox code only through the leaf", () => {
    const mailbox = relativeImports(join(HERE, "numbers.ts"))
      .map((f) => relative(SRC, f))
      .filter((f) => /mailbox|password/.test(f));
    expect(mailbox).toEqual(["lib/v8-4/mailbox-proven.ts"]);
  });
});

describe("proven set", () => {
  it("records per task, frees with the task, and refuses a freed task id", () => {
    _resetMailboxProven();
    const pw = "FakeTestPassWordLEAF2345";
    recordUserPasswordProof("t1", `es ${pw}`);
    expect(provenPasswords("t1").has(passwordFingerprint(pw))).toBe(true);
    forgetProvenPasswords("t1");
    expect(provenPasswords("t1").size).toBe(0);
    recordUserPasswordProof("t1", `es ${pw}`);
    expect(provenPasswords("t1").size).toBe(0);
    _resetMailboxProven();
  });
});
