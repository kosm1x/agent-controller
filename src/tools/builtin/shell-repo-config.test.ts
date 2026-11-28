/**
 * Git configuration writes in the shell gate: a tripwire for plainly written forms. Both directions are
 * pinned: the plain write forms and command-line aliases are refused, configuration reads and other git
 * verbs are not.
 */

import { describe, it, expect } from "vitest";
import { validateShellCommand } from "./shell.js";

const CONFIG_REASON =
  "changing git configuration is not done from shell_exec — a read names its action first (`git config --get <key>`, `git config --list`; a scope option such as `--global` goes before the action, other options after it, none of them negated (`--no-…`)); when a change is needed, report the exact command for the operator instead";
const ALIAS_REASON =
  "a git alias defined on the command line (`-c alias.…`, `--config-env alias.…`) is not run from shell_exec — spell the git command out";
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

describe("git configuration writes, and spellings without a read action first, are refused", () => {
  it.each([
    "git config core.x 1",
    "git -C /root/claude/proj-a config user.name proj-a-bot",
    "git config --global user.name proj-a-bot",
    "git config --file /tmp/site-b/cfg user.name proj-a-bot",
    "git config --replace-all core.x 1",
    "git config --unset core.x",
    "git config --unset-all core.x",
    "git config --rename-section core.a core.b",
    "git config --remove-section core.a",
    "git config --edit",
    "git config -e",
    "git config --get --no-get core.x 1",
    "git config --list --no-list core.x 1",
    "git config --get -z --no-get core.x 1",
    "git config --getx core.x 1",
    "git config user.name",
    "git config set user.name proj-a-bot",
    "git config get user.name",
    "git config --local core.x 1",
    "git config",
  ])("%s", (cmd) => refusedWith(cmd, CONFIG_REASON));
});

describe("git configuration writes are refused behind other spellings", () => {
  it.each([
    "/usr/bin/git config core.x 1",
    "env X=1 git config core.x 1",
    "command git config core.x 1",
    "(git config core.x 1)",
    "ls && git config core.x 1",
    'git "config" core.x 1',
    "g'i't config core.x 1",
    "git --git-dir /tmp/site-b/repo config core.x 1",
    "git --work-tree /root/claude/proj-a config core.x 1",
    "git -c x.y=1 config core.x 1",
    "git --attr-source HEAD config core.x 1",
    "git --shallow-file /tmp/site-b/s config core.x 1",
    "git --namespace ns config core.x 1",
    "git --no-such-option v config core.x 1",
    "git --no-such-flag config core.x 1",
    "git --no-literal-pathspecs -C /tmp/site-b config core.x 1",
    "git --no-such-flag -C /tmp/site-b config core.x 1",
    "git --no-pager config core.x 1",
    "git -p config core.x 1",
    "bash -c 'git config core.x 1'",
    "/usr/lib/git-core/git-config core.x 1",
    "G=/usr/bin/git git config core.x 1",
  ])("%s", (cmd) => refusedWith(cmd, CONFIG_REASON));
});

describe("git configuration reads are allowed", () => {
  it.each([
    "git config --get user.name",
    "git config --get-all remote.origin.url",
    "git config --get-regexp user",
    "git config --get-urlmatch http https://site.example",
    "git config -l",
    "git config --list",
    "git config --get-color color.diff.new red",
    "git config --get-colorbool color.ui",
    "git config --global --get user.name",
    "git config --get -f /tmp/site-b/cfg user.name",
    "git config --list --show-origin",
    "git config --get-regexp user name",
    "git config --get user.email 2>/dev/null",
    "git config --list && git log --no-merges",
    "git --no-pager config --get user.name",
  ])("%s", (cmd) => allowed(cmd));
});

describe("git verbs other than config, and quoted mentions, are not judged by this rule", () => {
  it.each([
    "git grep config",
    "git log -- config",
    "git --no-pager log --oneline -- config",
    "git status",
    'grep -rn "git config" /root/claude/proj-a/docs',
    "git -c x.y=1 status",
  ])("%s", (cmd) => allowed(cmd));
});

describe("a git alias defined on the command line is refused, whatever the verb", () => {
  it.each([
    "git -c alias.st=status st",
    "git -c ALIAS.st=status st",
    "git --config-env=alias.st=NAME st",
    "git --config-env alias.st=NAME st",
    "git -c alias.st=status config --list",
  ])("%s", (cmd) => refusedWith(cmd, ALIAS_REASON));

  it("another -c value before the verb is allowed", () => allowed("git -c color.ui=false log"));
});

describe("a command refused by an earlier check keeps that check's reason", () => {
  it("a configuration write the push/commit/add pattern matches carries that pattern's reason", () => {
    const r = validateShellCommand("git config --add core.x 1");
    expect(r).toEqual({ allowed: false, reason: PUSH_COMMIT_ADD_REASON });
  });
});
