/**
 * write-guard tests — operator-config deny + symlink-following resolve.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  isOperatorConfigPath,
  realResolve,
  realResolveParent,
} from "./write-guard.js";

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
