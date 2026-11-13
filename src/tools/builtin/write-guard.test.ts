/**
 * write-guard tests — operator-config deny + symlink-following resolve.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  isOperatorConfigPath,
  realResolve,
  realResolveParent,
} from "./write-guard.js";
import { validateShellCommand } from "./shell.js";
import { validatePathSafety } from "./immutable-core.js";

// The real fs, with a hook that makes one probe of one path throw a chosen value.
const probe = vi.hoisted(() => ({
  fail: undefined as ((op: "lstat" | "readlink", p: string) => unknown) | undefined,
}));
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  const hooked =
    <F extends (p: string, ...rest: never[]) => unknown>(op: "lstat" | "readlink", f: F) =>
    (p: string, ...rest: never[]) => {
      const err = probe.fail?.(op, p);
      if (err !== undefined) throw err;
      return f(p, ...rest);
    };
  return {
    ...actual,
    lstatSync: hooked("lstat", actual.lstatSync as (p: string) => unknown),
    readlinkSync: hooked("readlink", actual.readlinkSync as (p: string) => unknown),
  };
});

describe("isOperatorConfigPath", () => {
  it("blocks the operator's own config + any top-level dotfile under /root/claude/", () => {
    for (const p of [
      "/root/claude/.claude/settings.local.json",
      "/root/claude/.claude/hooks/x.sh",
      "/root/claude/.mcp.json",
      "/root/claude/.mcp.json.bak-pre-playwright",
      "/root/claude/.env",
      "/root/claude/CLAUDE.md",
    ]) {
      expect(isOperatorConfigPath(p)).toBe(true);
    }
  });

  it("allows project-repo content (including a repo's OWN CLAUDE.md)", () => {
    for (const p of [
      "/root/claude/vlcrm/src/app.ts",
      "/root/claude/projects/EurekaMS-Landing/index.html",
      "/root/claude/mission-control/src/index.ts", // guarded elsewhere, not here
      "/root/claude/vlcrm/CLAUDE.md",
      "/tmp/whatever.txt",
    ]) {
      expect(isOperatorConfigPath(p)).toBe(false);
    }
  });
});

describe("realResolve", () => {
  it("follows a symlink to its real target (defeats symlink escape)", () => {
    const dir = realResolve(mkdtempSync(join(tmpdir(), "wg-")));
    mkdirSync(join(dir, "real"));
    writeFileSync(join(dir, "real", "f.txt"), "x");
    symlinkSync(join(dir, "real"), join(dir, "link"));
    expect(realResolve(join(dir, "link", "f.txt"))).toBe(
      join(dir, "real", "f.txt"),
    );
  });

  it("resolves a not-yet-existing leaf via its existing parent", () => {
    const dir = realResolve(mkdtempSync(join(tmpdir(), "wg-")));
    expect(realResolve(join(dir, "nope.txt"))).toBe(join(dir, "nope.txt"));
  });

  // R1 C1: a relative target is read from the link's REAL directory.
  it("resolves a relative dangling target against the link's real parent", () => {
    const dir = realResolve(mkdtempSync(join(tmpdir(), "wg-")));
    mkdirSync(join(dir, "real", "sub"), { recursive: true });
    symlinkSync(join(dir, "real", "sub"), join(dir, "lnk"));
    symlinkSync("../target.txt", join(dir, "real", "sub", "dang"));
    expect(realResolve(join(dir, "lnk", "dang"))).toBe(
      join(dir, "real", "target.txt"),
    );
  });

  // R2 C2: `..` after a directory symlink steps up from the link's target,
  // in the literal path and in a link target alike.
  it("walks `dir-symlink/..` on disk, not as text", () => {
    const dir = realResolve(mkdtempSync(join(tmpdir(), "wg-")));
    mkdirSync(join(dir, "outside", "deep"), { recursive: true });
    mkdirSync(join(dir, "allowed"));
    symlinkSync("../outside/deep", join(dir, "allowed", "evil"));
    symlinkSync("evil/../x", join(dir, "allowed", "L"));
    expect(realResolve(join(dir, "allowed", "evil") + "/../z")).toBe(
      join(dir, "outside", "z"),
    );
    expect(realResolve(join(dir, "allowed", "L"))).toBe(
      join(dir, "outside", "x"),
    );
    expect(realResolveParent(join(dir, "allowed", "evil") + "/../z")).toBe(
      join(dir, "outside", "z"),
    );
    // unlink removes the link itself: the final component is not followed.
    expect(realResolveParent(join(dir, "allowed", "L"))).toBe(
      join(dir, "allowed", "L"),
    );
  });

  // audit 2026-09-22: a write through a dangling link creates its target.
  it("follows a dangling symlink, leaf or parent, to the path a write creates", () => {
    const dir = realResolve(mkdtempSync(join(tmpdir(), "wg-")));
    symlinkSync(join(dir, "gone", "new.txt"), join(dir, "leaf"));
    symlinkSync(join(dir, "gone2"), join(dir, "dirlink"));
    expect(realResolve(join(dir, "leaf"))).toBe(join(dir, "gone", "new.txt"));
    expect(realResolve(join(dir, "dirlink", "x.txt"))).toBe(
      join(dir, "gone2", "x.txt"),
    );
  });
});

// Only a file-system error about the path itself (ENOENT, ENOTDIR, EACCES,
// ELOOP, ENAMETOOLONG) means a component cannot be followed; an error about the
// machine's state, or anything else thrown, is not evidence about the path, so
// the walk throws and the check that called it fails closed.
describe("realResolve — which probe errors end the walk", () => {
  afterEach(() => {
    probe.fail = undefined;
  });

  /** <tmp>/link -> <tmp>/real; returns <tmp>. */
  function linkFixture(): string {
    const dir = realResolve(mkdtempSync(join(tmpdir(), "wg-")));
    mkdirSync(join(dir, "real"));
    symlinkSync(join(dir, "real"), join(dir, "link"));
    return dir;
  }
  const coded = <E extends Error>(e: E, code: string): E => Object.assign(e, { code });
  const thrown = (f: () => unknown): unknown => {
    try {
      f();
    } catch (e) {
      return e;
    }
    return "returned";
  };

  it("throws when the lstat or readlink of a component fails with anything but an error about the path", () => {
    const dir = linkFixture();
    const target = join(dir, "link", "f.txt");
    for (const op of ["lstat", "readlink"] as const) {
      for (const err of [
        new RangeError("Maximum call stack size exceeded"),
        coded(new RangeError("Maximum call stack size exceeded"), "ENOENT"),
        new Error("no code"),
        coded(new Error("i/o error"), "EIO"),
        coded(new Error("out of memory"), "ENOMEM"),
        coded(new Error("invalid argument"), "EINVAL"),
        coded(new Error("no such process"), "ESRCH"),
        coded(new Error("stale file handle"), "ESTALE"),
        coded(new Error("operation not permitted"), "EPERM"),
        coded(new Error("not an errno"), "NOT_AN_ERRNO"),
        coded(new TypeError("invalid argument"), "ERR_INVALID_ARG_VALUE"),
        { code: "ENOENT" },
      ]) {
        probe.fail = (o, p) => (o === op && p === join(dir, "link") ? err : undefined);
        expect(thrown(() => realResolve(target)), `${op}: ${JSON.stringify(err)}`).toBe(err);
      }
    }
  });

  it("throws for a path the file system cannot be asked about (a NUL byte)", () => {
    const dir = linkFixture();
    expect(() => realResolve(join(dir, "link", "a\0b"))).toThrow();
  });

  it("keeps the text fallback from the component whose probe the file system refused", () => {
    const dir = linkFixture();
    const target = join(dir, "link", "f.txt");
    expect(realResolve(target)).toBe(join(dir, "real", "f.txt"));
    for (const op of ["lstat", "readlink"] as const) {
      for (const code of ["ENOENT", "ENOTDIR", "EACCES", "ELOOP", "ENAMETOOLONG"]) {
        probe.fail = (o, p) => (o === op && p === join(dir, "link") ? coded(new Error(code), code) : undefined);
        expect(realResolve(target), `${op}: ${code}`).toBe(target);
      }
    }
  });

  it("the shell write check fails closed when the walk throws", () => {
    const dir = linkFixture();
    const cmd = `echo x > ${join(dir, "link", "out.txt")}`;
    expect(validateShellCommand(cmd, { cwd: dir }).allowed).toBe(true);
    probe.fail = (_o, p) => (p === join(dir, "link") ? new RangeError("Maximum call stack size exceeded") : undefined);
    expect(() => validateShellCommand(cmd, { cwd: dir })).toThrow(RangeError);
  });

  it("the path-safety check of a write fails closed when its resolve of the target throws", () => {
    const dir = linkFixture();
    const target = join(dir, "link", "out.txt");
    let walks = 0;
    const count = (o: string, p: string) => o === "lstat" && p === join(dir, "link") && ++walks;
    probe.fail = (o, p) => void count(o, p);
    expect(validatePathSafety(target, "write").safe).toBe(true);
    // Two walks of the path: the /proc-link check, then the resolve of the write target.
    expect(walks).toBe(2);
    walks = 0;
    probe.fail = (o, p) => (count(o, p) === 2 ? new RangeError("Maximum call stack size exceeded") : undefined);
    expect(() => validatePathSafety(target, "write")).toThrow(RangeError);
  });
});
