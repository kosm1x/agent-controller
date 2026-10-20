import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { appendReceipt } = createRequire(import.meta.url)("./x-post-receipt.cjs") as {
  appendReceipt: (file: string, receipt: unknown) => void;
};

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("appendReceipt", () => {
  it("creates the missing parent dir and appends one JSON line per receipt", () => {
    root = mkdtempSync(join(tmpdir(), "x-receipt-"));
    const file = join(root, "a", "b", "receipts.jsonl");
    appendReceipt(file, { ts: "2026-10-20T19:00:00.000Z", account: "x", url: "u1", toast: null });
    appendReceipt(file, { ts: "2026-10-20T19:01:00.000Z", account: "x", url: "u2", toast: "Your post was sent." });
    const lines = readFileSync(file, "utf-8").split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe("");
    expect(JSON.parse(lines[0]!)).toMatchObject({ url: "u1", toast: null });
    expect(JSON.parse(lines[1]!)).toMatchObject({ url: "u2", toast: "Your post was sent." });
  });
});
