import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { operatorContextReason } from "../../src/lib/operator-gate.js";

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

  it("appends a publish receipt from one call site and one attempt record", () => {
    expect(src.match(/appendReceipt\(/g)).toHaveLength(2);
    expect(src.match(/mexiconecesario\.jsonl/g)).toHaveLength(2); // header comment + path
  });

  it("checks and records the attempt BEFORE the Post click", () => {
    const guard = src.indexOf("findRecentAttempt(attemptsFile");
    const record = src.indexOf("appendReceipt(attemptsFile");
    const click = src.indexOf("page.evaluate(el => el.click(), btn)");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(record);
    expect(record).toBeLessThan(click);
    expect(src).toContain("process.exit(8)");
  });

  it("decides the override only through overrideAllowed(process.env, gate, cgroup)", () => {
    expect(src).toContain(
      "const loadOperatorGate = () => require(path.resolve(__dirname, '..', 'dist', 'lib', 'operator-gate.js'));",
    );
    expect(src).toContain("const readSelfCgroup = () => fs.readFileSync('/proc/self/cgroup', 'utf8');");
    expect(src).toMatch(
      /let force = false;\s*if \(overrideRequested\(process\.env\)\) \{\s*force = overrideAllowed\(process\.env, loadOperatorGate, readSelfCgroup\);\s*if \(!force\) console\.log\('OVERRIDE_IGNORADO[^\n]*\n\s*\}\s*const prior = force \? null : findRecentAttempt\(attemptsFile/,
    );
    expect(src.match(/force = /g)).toHaveLength(2); // the false default + the gated assignment
    // The script never reads the variable itself, in any spelling.
    expect(src).not.toMatch(/process\.env\s*(\.\s*X_POST_FORCE|\[)/);
  });

  it("closes the browser before exit 8", () => {
    expect(src).toMatch(
      /console\.log\('DUPLICADO_BLOQUEADO[^\n]*\n\s*await browser\.close\(\);\s*process\.exit\(8\);/,
    );
  });

  it("keeps the override out of the header exit table", () => {
    const row = src.split("\n").find((l) => l.startsWith("//   8  DUPLICADO_BLOQUEADO"));
    expect(row).toBeDefined();
    expect(row).not.toContain("X_POST_FORCE");
  });
});

describe("duplicate guard", () => {
  const { textHash, findRecentAttempt } = createRequire(import.meta.url)("./x-post-receipt.cjs") as {
    textHash: (t: string) => string;
    findRecentAttempt: (f: string, h: string, w: number, now?: number) => { ts: string } | null;
  };

  it("hashes ignoring whitespace and case", () => {
    expect(textHash("Hola  Mundo\n")).toBe(textHash(" hola mundo"));
    expect(textHash("a")).not.toBe(textHash("b"));
  });

  it("finds a same-text attempt inside the window, not outside, not for other text", () => {
    root = mkdtempSync(join(tmpdir(), "x-attempt-"));
    const file = join(root, "attempts.jsonl");
    const day = 24 * 3600 * 1000;
    const now = Date.parse("2026-10-29T18:00:00Z");
    expect(findRecentAttempt(file, "h1", day, now)).toBeNull(); // missing file
    appendReceipt(file, { ts: "2026-10-28T18:00:00.000Z", hash: "h1" });
    expect(findRecentAttempt(file, "h1", 2 * day, now)).not.toBeNull();
    expect(findRecentAttempt(file, "h1", day / 2, now)).toBeNull();
    expect(findRecentAttempt(file, "h2", 2 * day, now)).toBeNull();
  });
});

describe("overrideAllowed", () => {
  const { overrideAllowed } = createRequire(import.meta.url)("./x-post-receipt.cjs") as {
    overrideAllowed: (
      env: Record<string, string | undefined>,
      loadGate: () => unknown,
      readCgroup: () => string,
    ) => boolean;
  };
  const FORCE = { X_POST_FORCE: "1" };
  const realGate = () => ({ operatorContextReason });
  const TASK = "0::/system.slice/mission-control.service\n";
  const OPERATOR = "0::/user.slice/user-0.slice/session-1.scope\n";
  const boom = () => {
    throw new Error("boom");
  };

  it("is false when the override is not requested", () => {
    expect(overrideAllowed({}, realGate, () => OPERATOR)).toBe(false);
    expect(overrideAllowed({ X_POST_FORCE: "true" }, realGate, () => OPERATOR)).toBe(false);
  });

  it("is false when the gate is missing, throws, or lacks the function", () => {
    expect(overrideAllowed(FORCE, boom, () => OPERATOR)).toBe(false);
    expect(overrideAllowed(FORCE, () => undefined, () => OPERATOR)).toBe(false);
    expect(overrideAllowed(FORCE, () => ({}), () => OPERATOR)).toBe(false);
    expect(overrideAllowed(FORCE, () => ({ operatorContextReason: null }), () => OPERATOR)).toBe(false);
    expect(overrideAllowed(FORCE, () => ({ operatorContextReason: boom }), () => OPERATOR)).toBe(false);
  });

  it("is false when the cgroup is unreadable", () => {
    expect(overrideAllowed(FORCE, realGate, boom)).toBe(false);
  });

  it("is false inside mission-control.service (a task)", () => {
    expect(overrideAllowed(FORCE, realGate, () => TASK)).toBe(false);
  });

  it("is true only from an operator login session", () => {
    expect(overrideAllowed(FORCE, realGate, () => OPERATOR)).toBe(true);
  });
});
