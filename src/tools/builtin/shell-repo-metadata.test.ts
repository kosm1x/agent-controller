/**
 * A repository's `.git` folder and `.git` pointer file as shell write targets. Both directions are
 * pinned: a captured write, copy or move into such a folder or onto a final `.git`, and a move out of
 * such a folder, are refused (by the resolved target, so a relative word after `cd` and a symlink
 * count too); a file whose name only starts or ends with `.git`, and reads, are not.
 */

import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { validateShellCommand } from "./shell.js";

const METADATA_REASON = "are not written, moved or removed from shell_exec — git maintains them";
const PUSH_COMMIT_ADD_REASON = "git operations blocked in shell_exec — use git_commit/git_push tools";

function refusedWith(cmd: string, reason: string): void {
  const r = validateShellCommand(cmd);
  expect(r.allowed, cmd).toBe(false);
  expect(r.reason, cmd).toContain(reason);
}
function allowed(cmd: string): void {
  const r = validateShellCommand(cmd);
  expect(r, cmd).toEqual({ allowed: true });
}

describe("shell writes inside a .git folder or onto a final .git are refused", () => {
  it.each([
    "echo x > /root/claude/proj-a/.git/config",
    "echo x >> /tmp/site-b/.git/hooks/post-checkout",
    "echo x | tee /tmp/site-b/.git/info/attributes",
    "cp /tmp/h /root/claude/proj-a/.git/hooks/",
    "cp /tmp/h /tmp/site-b/.git/hooks/post-merge",
    "echo 'gitdir: /tmp/x' > /root/claude/proj-a/.git",
    "mv /tmp/f /tmp/site-b/.git",
    "mv /tmp/site-b/.git /tmp/site-b/old",
    "mv /tmp/site-b/.git/HEAD /tmp/old",
    "cd /root/claude/proj-a && echo x > .git/config",
    "echo x > /tmp/site-b.git/hooks/post-receive",
  ])("%s", (cmd) => refusedWith(cmd, METADATA_REASON));

  it("an append whose tail is an append-only ritual doc is refused inside a .git folder too", () => {
    refusedWith("echo x >> /tmp/site-b/.git/mission-control/docs/EVOLUTION-LOG.md", METADATA_REASON);
  });

  it("an overwrite whose tail is an append-only ritual doc carries the .git reason, not the append-only one", () => {
    refusedWith("echo x > /tmp/site-b/.git/mission-control/docs/EVOLUTION-LOG.md", METADATA_REASON);
  });

  describe("through a symlink", () => {
    it("a write through a link to a .git folder is refused", () => {
      const dir = mkdtempSync(join(tmpdir(), "shell-gitlink-"));
      try {
        mkdirSync(join(dir, "repo", ".git"), { recursive: true });
        symlinkSync(join(dir, "repo", ".git"), join(dir, "lnk"));
        refusedWith(`echo x > ${join(dir, "lnk", "config")}`, METADATA_REASON);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

describe("writes next to a .git folder, and reads inside one, are allowed", () => {
  it.each([
    "echo x > /tmp/site-b/.gitignore",
    "echo x > /tmp/site-b/.gitattributes",
    "echo x > /tmp/site-b/.github/w.yml",
    "echo x > /tmp/site-b/x.git",
    "cat /tmp/site-b/.git/HEAD",
  ])("%s", (cmd) => allowed(cmd));
});

describe("a target refused by an earlier check keeps that check's reason", () => {
  it("a hook name the push/commit/add pattern matches carries that pattern's reason", () => {
    const r = validateShellCommand("echo x > /tmp/site-b/.git/hooks/pre-commit");
    expect(r).toEqual({ allowed: false, reason: PUSH_COMMIT_ADD_REASON });
  });
});
