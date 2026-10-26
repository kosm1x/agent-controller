import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isMainModule } from "./is-main-module.js";

describe("isMainModule", () => {
  let dir: string;
  let argv1: string | undefined;
  let exitCode: typeof process.exitCode;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "is-main-module-"));
    mkdirSync(join(dir, "scripts"));
    for (const f of ["kb-tool.ts", "one-shot.mjs", "other.ts", "kb.v2.ts"]) writeFileSync(join(dir, "scripts", f), "");
    symlinkSync(join(dir, "scripts", "kb-tool.ts"), join(dir, "scripts", "alias.ts"));
    argv1 = process.argv[1];
    exitCode = process.exitCode;
  });

  afterEach(() => {
    process.argv[1] = argv1 as string;
    process.exitCode = exitCode;
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  const url = (f: string) => pathToFileURL(join(dir, "scripts", f)).href;

  it("argv[1] is the module → true, no output, exit code untouched", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    process.argv[1] = join(dir, "scripts", "kb-tool.ts");
    expect(isMainModule(url("kb-tool.ts"))).toBe(true);
    expect(err).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(exitCode);
  });

  it("argv[1] names the module without its extension → false + one stderr line + exit code 2", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    process.argv[1] = join(dir, "scripts", "kb-tool");
    expect(isMainModule(url("kb-tool.ts"))).toBe(false);
    expect(err.mock.calls).toEqual([
      ["[kb-tool] entry skipped: run it as scripts/kb-tool.ts (argv[1] was kb-tool)"],
    ]);
    expect(process.exitCode).toBe(2);
  });

  it("same for a .mjs module", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    process.argv[1] = join(dir, "scripts", "one-shot");
    expect(isMainModule(url("one-shot.mjs"))).toBe(false);
    expect(err.mock.calls).toEqual([
      ["[one-shot] entry skipped: run it as scripts/one-shot.mjs (argv[1] was one-shot)"],
    ]);
    expect(process.exitCode).toBe(2);
  });

  it("tsx `<name>.js` resolving to the .ts module → false + the same stderr line + exit code 2", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    process.argv[1] = join(dir, "scripts", "kb-tool.js");
    expect(isMainModule(url("kb-tool.ts"))).toBe(false);
    expect(err.mock.calls).toEqual([
      ["[kb-tool] entry skipped: run it as scripts/kb-tool.ts (argv[1] was kb-tool.js)"],
    ]);
    expect(process.exitCode).toBe(2);
  });

  it("a dotted basename spelled without its extension still warns", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    process.argv[1] = join(dir, "scripts", "kb.v2");
    expect(isMainModule(url("kb.v2.ts"))).toBe(false);
    expect(err.mock.calls).toEqual([
      ["[kb.v2] entry skipped: run it as scripts/kb.v2.ts (argv[1] was kb.v2)"],
    ]);
    expect(process.exitCode).toBe(2);
  });

  it("symlinked path: the link to the module → true; the link without extension warns naming the real file", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    process.argv[1] = join(dir, "scripts", "alias.ts");
    expect(isMainModule(url("kb-tool.ts"))).toBe(true);
    expect(err).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(exitCode);
    process.argv[1] = join(dir, "scripts", "alias");
    expect(isMainModule(url("kb-tool.ts"))).toBe(false);
    expect(err.mock.calls).toEqual([
      ["[kb-tool] entry skipped: run it as scripts/kb-tool.ts (argv[1] was alias)"],
    ]);
    expect(process.exitCode).toBe(2);
  });

  it("unrelated argv[1] (another script, its extension-less name, a missing path, none) → false, no output, exit code untouched", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const a of [join(dir, "scripts", "other.ts"), join(dir, "scripts", "other"), join(dir, "nope.ts"), undefined]) {
      process.argv[1] = a as string;
      expect(isMainModule(url("kb-tool.ts")), String(a)).toBe(false);
    }
    expect(err).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(exitCode);
  });
});
