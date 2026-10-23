import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { appendReceipt, classifyToast } = createRequire(import.meta.url)("./x-post-receipt.cjs") as {
  appendReceipt: (file: string, receipt: unknown) => void;
  classifyToast: (toastText: string) => { confirmed: boolean; toast: string };
};

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "post-mexiconecesario.cjs");

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

describe("classifyToast", () => {
  it.each(["Your post was sent.", "Tu post se envió", "SENT"])("confirms %j", (t) => {
    expect(classifyToast(t).confirmed).toBe(true);
  });

  it.each([
    "",
    "You are over the daily limit for sending posts.",
    "Has superado el límite diario de posts",
    "post",
    "sentinel",
  ])("does not confirm %j", (t) => {
    expect(classifyToast(t).confirmed).toBe(false);
  });

  it("returns the trimmed toast text", () => {
    expect(classifyToast("  Your post was sent.\n ")).toEqual({ confirmed: true, toast: "Your post was sent." });
    expect(classifyToast("   ")).toEqual({ confirmed: false, toast: "" });
  });
});

describe("post-mexiconecesario.cjs source pin", () => {
  const src = readFileSync(SCRIPT, "utf-8");

  it("decides the marker and exit code only through classifyToast", () => {
    expect(src).not.toContain("includes('post')");
    expect(src).not.toContain("includes('sent')");
    expect(src).not.toContain("RECEIPT_SKIPPED");
    expect(src).not.toContain("se envi[oó]");
    expect(src).toContain("classifyToast(");
    expect(src).toContain("process.exit(7)");
  });

  it("prints TWEET_PUBLICADO once, only inside the confirmed branch", () => {
    expect(src.match(/console\.log\('TWEET_PUBLICADO/g)).toHaveLength(1);
    expect(src).toMatch(/if \(confirmed\) \{\s*console\.log\('TWEET_PUBLICADO/);
    expect(src).toMatch(/console\.log\('PUBLICACION_NO_CONFIRMADA[^\n]*\n\s*await browser\.close\(\);\s*process\.exit\(7\);/);
  });

  it("ends the confirmed branch with exit 0 before the unconfirmed log", () => {
    expect(src).toMatch(/await browser\.close\(\);\s*process\.exit\(0\);\s*\}\s*\n\s*console\.log\('PUBLICACION_NO_CONFIRMADA/);
  });

  it("appends a receipt from one call site only", () => {
    expect(src.match(/appendReceipt\(/g)).toHaveLength(1);
  });
});
