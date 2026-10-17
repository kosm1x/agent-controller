/**
 * Lock test (queue 4a (e)): every `vi.mock(...)` / `vi.doMock(...)` target in
 * a test file vitest runs (src/ and scripts/, per vitest.config.ts) must name
 * a module that exists. A mock of a missing module is silently inert —
 * provenance-wiring.test.ts mocked `db/jarvis-sync.js` (no such file), so the
 * real syncToDrive ran inside that test.
 *
 * Resolution: relative specifiers resolve from the test file (`.js` → `.ts`
 * source, as tsc/vitest resolve them); node builtins pass; any other bare
 * specifier must have `<root>/node_modules/<package>/package.json`. Every
 * `@/` specifier is an offender: tsconfig maps `@/*` but vitest.config.ts
 * declares no alias, so such a mock targets nothing (pinned below). Both the
 * string form and the `vi.mock(import("…"))` form are scanned.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url); // its fixtures are offenders by design
const REPO = resolve(dirname(SELF), "..", "..");
const SCAN_DIRS = ["src", "scripts"];
const MOCK_RE =
  /\bvi\s*\.\s*(?:mock|doMock)\s*\(\s*(?:import\s*\(\s*)?(["'`])([^"'`]+)\1/g;

function fileCandidates(abs: string): string[] {
  const out = [abs];
  const m = /\.(m|c)?js$/.exec(abs);
  if (m) {
    const stem = abs.slice(0, -m[0].length);
    out.push(`${stem}.${m[1] ?? ""}ts`, `${stem}.tsx`);
  } else if (!/\.[a-z]+$/i.test(abs)) {
    out.push(`${abs}.ts`, join(abs, "index.ts"));
  }
  return out;
}

/** Why vitest could not load `spec` from a test file at `file`; null = it can. */
function unresolvedReason(spec: string, file: string, root: string): string | null {
  const missing = "no such module";
  if (spec.startsWith("./") || spec.startsWith("../"))
    return fileCandidates(resolve(dirname(file), spec)).some((c) => existsSync(c)) ? null : missing;
  if (spec.startsWith("@/")) return "alias not configured in vitest";
  if (isBuiltin(spec)) return null;
  const parts = spec.split("/");
  const pkg = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  return existsSync(join(root, "node_modules", pkg, "package.json")) ? null : missing;
}

function testFiles(root: string, dirs: string[]): string[] {
  return dirs
    .filter((d) => existsSync(join(root, d)))
    .flatMap((d) =>
      (readdirSync(join(root, d), { recursive: true }) as string[])
        .filter((f) => f.endsWith(".test.ts") && !f.split(/[\\/]/).includes("node_modules"))
        .map((f) => join(root, d, f)),
    );
}

/** `<file>:<line> → <specifier>` for every mock target that does not resolve. */
function findMockOffenders(root: string, dirs: string[]): string[] {
  const offenders: string[] = [];
  for (const file of testFiles(root, dirs).filter((f) => f !== SELF)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(MOCK_RE)) {
      const spec = m[2];
      if (spec.includes("${")) continue; // template with a runtime part
      const reason = unresolvedReason(spec, file, root);
      if (reason !== null) {
        const line = text.slice(0, m.index).split("\n").length;
        offenders.push(`${relative(root, file)}:${line} → ${spec} (${reason})`);
      }
    }
  }
  return offenders;
}

describe("vi.mock targets — real tree", () => {
  it("finds the test files and their mocks in src/ and scripts/ (scan is not vacuous)", () => {
    const files = testFiles(REPO, SCAN_DIRS);
    expect(files.some((f) => f.startsWith(join(REPO, "scripts")))).toBe(true);
    expect(files.length).toBeGreaterThan(100);
    const mocks = files.flatMap((f) => [...readFileSync(f, "utf8").matchAll(MOCK_RE)]);
    expect(mocks.length).toBeGreaterThan(100);
    expect(mocks.some((m) => !m[2].startsWith("."))).toBe(true); // bare specifiers are scanned
  });

  it("every vi.mock target in src/ and scripts/ resolves", () => {
    expect(findMockOffenders(REPO, SCAN_DIRS)).toEqual([]);
  });

  it("vitest still declares no alias (else teach the scanner the alias map)", () => {
    expect(readFileSync(join(REPO, "vitest.config.ts"), "utf8")).not.toMatch(/\balias\b/);
  });
});

describe("vi.mock targets — scratch tree (each offender class is caught)", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "vi-mock-targets-"));
    for (const d of ["src/db", "src/lib", "scripts", "node_modules/real-pkg", "node_modules/@scope/real"])
      mkdirSync(join(root, d), { recursive: true });
    writeFileSync(join(root, "src/db/drive-sync.ts"), "");
    writeFileSync(join(root, "node_modules/real-pkg/package.json"), "{}");
    writeFileSync(join(root, "node_modules/@scope/real/package.json"), "{}");
    writeFileSync(
      join(root, "src/lib/good.test.ts"),
      [
        'vi.mock("../db/drive-sync.js", () => ({}));',
        'vi.mock(import("../db/drive-sync.js"), () => ({}));',
        'vi.mock("node:fs");',
        'vi.mock("child_process");',
        'vi.doMock("real-pkg");',
        'vi.mock("@scope/real/sub/path.js");',
      ].join("\n"),
    );
    writeFileSync(
      join(root, "src/lib/bad.test.ts"),
      [
        'vi.mock("../db/jarvis-sync.js", () => ({}));',
        'vi.mock("not-a-real-pkg-xyz");',
        'vi.mock("@/db/jarvis-sync.js");',
        'vi.mock(import("../db/missing.js"), () => ({}));',
        'vi.mock("@scope/missing");',
        'vi.mock("@/db/drive-sync.js");',
        'vi.doMock("../db/doesnt-exist.js");',
      ].join("\n"),
    );
    writeFileSync(join(root, "scripts/bad.test.ts"), 'vi.mock("../src/db/nope.js");\n');
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("reports exactly the offenders, with file and line, and passes every valid form", () => {
    expect(findMockOffenders(root, SCAN_DIRS).sort()).toEqual(
      [
        "scripts/bad.test.ts:1 → ../src/db/nope.js (no such module)",
        "src/lib/bad.test.ts:1 → ../db/jarvis-sync.js (no such module)",
        "src/lib/bad.test.ts:2 → not-a-real-pkg-xyz (no such module)",
        "src/lib/bad.test.ts:3 → @/db/jarvis-sync.js (alias not configured in vitest)",
        "src/lib/bad.test.ts:4 → ../db/missing.js (no such module)",
        "src/lib/bad.test.ts:5 → @scope/missing (no such module)",
        // The target exists (src/db/drive-sync.ts) but vitest cannot map `@/`.
        "src/lib/bad.test.ts:6 → @/db/drive-sync.js (alias not configured in vitest)",
        "src/lib/bad.test.ts:7 → ../db/doesnt-exist.js (no such module)",
      ].sort(),
    );
  });
});
