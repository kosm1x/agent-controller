/**
 * write-guard tests — operator-config deny + symlink-following resolve.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { isOperatorConfigPath, realResolve } from "./write-guard.js";

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
});
