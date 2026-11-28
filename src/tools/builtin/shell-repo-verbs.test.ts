/**
 * Repository setup verbs in the shell gate: a tripwire for plainly written forms. Both directions are pinned:
 * `git init` / `git clone` in their plain forms, `git maintenance run` and the `git remote` reads are allowed;
 * other options, other maintenance sub-verbs and the remote writes are refused, also through a word the
 * global-option walk passes as a value and through the dashed binaries.
 */

import { describe, it, expect } from "vitest";
import { validateShellCommand } from "./shell.js";

const SETUP_REASON = "`git init` / `git clone` is run from shell_exec only in its plain form";
const MAINTENANCE_REASON = "`git maintenance` is run from shell_exec only as `git maintenance run`";
const REMOTE_REASON =
  "git remote modification blocked — use gh_repo_create(cwd) for a new repo or git_push(remote) for an existing one";
const CONFIG_REASON = "changing git configuration is not done from shell_exec";
const ALIAS_REASON = "a git alias defined on the command line";
const PUSH_COMMIT_ADD_REASON = "git operations blocked in shell_exec — use git_commit/git_push tools";
const URL = "https://site.example/r.git";

function refusedWith(cmd: string, reason: string): void {
  const r = validateShellCommand(cmd);
  expect(r.allowed, cmd).toBe(false);
  expect(r.reason, cmd).toContain(reason);
}
function refusedAsRemote(cmd: string): void {
  expect(validateShellCommand(cmd), cmd).toEqual({ allowed: false, reason: REMOTE_REASON });
}
function allowed(cmd: string): void {
  const r = validateShellCommand(cmd);
  expect(r, cmd).toEqual({ allowed: true });
}

describe("git init and git clone in their plain forms are allowed", () => {
  it.each([
    "git init",
    "git init -q /root/claude/proj-a",
    "git init --bare -b main /root/claude/proj-a/r.git",
    "git init --initial-branch=main /root/claude/proj-a",
    "git init --object-format=sha256 /root/claude/proj-a",
    "git init -- /root/claude/proj-a",
    "git -C /root/claude/proj-a init",
    "git --no-pager -C /root/claude/proj-a init",
    "git -C -C init",
    "git init-db",
    `git clone ${URL}`,
    `git clone --depth 1 --branch main ${URL} /root/claude/proj-a/r`,
    `git clone --depth=1 --single-branch -b main ${URL}`,
    `git clone --filter=blob:none ${URL}`,
    `git clone -o up --no-tags ${URL}`,
    `git clone -- ${URL} /root/claude/proj-a/r`,
    `git clone -q -n ${URL} 2>&1`,
  ])("%s", allowed);
});

describe("git init and git clone with an option outside their lists are refused", () => {
  it.each([
    "git init --template=/tmp/site-b/t",
    "git init --template /tmp/site-b/t",
    "git init --templ=/tmp/site-b/t",
    "git init --separate-git-dir /tmp/site-b/g",
    "git init --shared=group",
    "git init-db --template=/tmp/site-b/t",
    `git clone -c core.hooksPath=/tmp/site-b/h ${URL}`,
    `git clone --config a.b=c ${URL}`,
    `git clone -ca.b=c ${URL}`,
    `git clone -qc a.b=c ${URL}`,
    `git clone -u /tmp/site-b/p ${URL}`,
    `git clone --upload-pack=/tmp/site-b/p ${URL}`,
    `git clone --reference /tmp/site-b/r ${URL}`,
    `git clone -s ${URL}`,
    `git clone --recurse-submodules ${URL}`,
    `git clone --mirror ${URL}`,
    `git clone --barex ${URL}`,
    `git clone ${URL} /root/claude/proj-a/r --template=/tmp/site-b/t`,
    `git clone -- ${URL} --template=/tmp/site-b/t`,
    "git init --depth 1",
  ])("%s", (cmd) => refusedWith(cmd, SETUP_REASON));
  it("a second git word in a segment is judged too", () =>
    refusedWith("git log x git init --template=/tmp/site-b/t", SETUP_REASON));
});

describe("a word before init or clone other than a plain flag, -C or the folder after -C is refused", () => {
  it.each([
    "git -c init.templateDir=/tmp/site-b/t init",
    "git --config-env=init.templateDir=T init",
    `git --config-env init.templateDir=T clone ${URL}`,
    "git --git-dir /tmp/site-b/g init",
    "git --git-dir=/tmp/site-b/g --work-tree=/root/claude/proj-a init",
    `git --exec-path=/tmp/site-b/b clone ${URL}`,
    "git --no-lazy-fetch init",
    "git -C -C --git-dir=/tmp/site-b/g init",
    "git -C -C --config-env=init.templateDir=T init",
    `git -C -C --git-dir=/tmp/site-b/g clone ${URL}`,
    "git -C -C -C -C --git-dir=/tmp/site-b/g init",
  ])("%s", (cmd) => refusedWith(cmd, SETUP_REASON));
  it("a word paired with -C is taken as a folder, not as an option", () => allowed("git -C . -C --git-dir=x init"));
});

describe("a word the walk passes as a value is judged, and does not hide the verb that follows", () => {
  it("a value spelled `init` is judged as init (two -C words: the walk takes init as the second -C's value)", () =>
    refusedWith("git -C -C init --template=/tmp/site-b/t", SETUP_REASON));
  it("a value spelled `remote` is judged as remote", () => refusedAsRemote("git --no-lazy-fetch remote rm origin"));
  it("a value spelled `maintenance` is judged as maintenance", () =>
    refusedWith("git --no-lazy-fetch maintenance start", MAINTENANCE_REASON));
  it("a -C value `init` before `remote rm` gets the remote refusal", () => refusedAsRemote("git -C init remote rm x"));
  it("a -C value `init` before `maintenance start` gets the maintenance refusal", () =>
    refusedWith("git -C init maintenance start", MAINTENANCE_REASON));
  it("a -C value `clone` before `init --template` is refused", () =>
    refusedWith("git -C clone init --template=/tmp/site-b/t", SETUP_REASON));
  it("a -C value `maintenance` before `clone -c` is refused", () =>
    refusedWith(`git -C maintenance clone -c a.b=c ${URL}`, SETUP_REASON));
});

describe("a -C folder named like one of the five verbs is judged as that verb", () => {
  it("git -C init log --oneline is refused: --oneline is not an init option", () =>
    refusedWith("git -C init log --oneline", SETUP_REASON));
  it("git -C init status is allowed", () => allowed("git -C init status"));
  it("git -C init config --get a.b is refused: --get is not an init option", () =>
    refusedWith("git -C init config --get a.b", SETUP_REASON));
  it("git -C remote log is refused: log is not a remote read", () => refusedAsRemote("git -C remote log"));
  it("git -C remote show is allowed", () => allowed("git -C remote show"));
});

describe("git maintenance is allowed as `run` and refused otherwise", () => {
  it.each(["git maintenance run", "git maintenance run --task=gc --quiet", "git -C /root/claude/proj-a maintenance run"])(
    "%s is allowed",
    allowed,
  );
  it.each([
    "git maintenance start",
    "git maintenance stop",
    "git maintenance register",
    "git maintenance unregister",
    "git maintenance",
    "git maintenance --quiet run",
    "git -c a.b=c maintenance start",
  ])("%s is refused", (cmd) => refusedWith(cmd, MAINTENANCE_REASON));
});

describe("git remote reads are allowed and its other sub-verbs are refused with the remote text", () => {
  it.each([
    "git remote",
    "git remote -v",
    "git remote --verbose",
    "git remote show origin",
    "git remote -v show origin",
    "git remote get-url origin",
    "git remote update",
    "git remote prune origin",
  ])("%s is allowed", allowed);
  it.each([
    "git remote rm origin",
    "git remote -v rm origin",
    "git remote --verbose rm origin",
    "git remote set-head origin -a",
    "git remote set-branches origin main",
    "git -c a.b=c remote rm origin",
    `git --git-dir=/tmp/site-b/g remote set-url origin ${URL}`,
    "git -C /tmp/site-b/r remote rm origin",
    "git remote --help",
  ])("%s is refused", refusedAsRemote);
  it("the refusal of a sub-verb is the text the deny pattern gives `git remote set-url`", () => {
    const denied = validateShellCommand(`git remote set-url origin ${URL}`);
    expect(denied.allowed).toBe(false);
    expect(validateShellCommand("git remote rm origin").reason).toBe(denied.reason);
  });
});

describe("git remote followed by a redirection", () => {
  it.each(["git remote -v 2>&1", "git remote 2>/dev/null", "git remote >>/dev/null"])(
    "%s is allowed: an operator and a plain target end the segment",
    allowed,
  );
  it.each(["git remote <x(y", "git remote <{a,b}", "git remote <$X", "git remote <a,b"])(
    "%s is refused: the target is not plain",
    refusedAsRemote,
  );
  it("an operator word that does not end the segment is refused", () => refusedAsRemote("git remote 2>/dev/null rm x"));
  it("a bare operator and one plain target is allowed", () => allowed("git remote -v > /dev/null"));
  it("a bare operator and two words is refused", () => refusedAsRemote("git remote > /dev/null rm"));
  it("a bare operator and a target that is not plain is refused", () => refusedAsRemote("git remote < x,y"));
  it.each(["git remote >& /dev/null", "git remote 2>&1 rm x"])(
    "%s is refused: a complete operator that does not end in < or > and a word after it",
    refusedAsRemote,
  );
  it.each([
    "git remote {rm,origin}>/dev/null",
    "git remote {rm,origin}> /dev/null",
    "git remote rm${IFS}origin>/dev/null",
  ])("%s is refused: the word does not start with the operator", refusedAsRemote);
});

describe("the dashed binaries are judged as their verb", () => {
  it("git-init with a template is refused", () =>
    refusedWith("/usr/lib/git-core/git-init --template=/tmp/site-b/t", SETUP_REASON));
  it("git-init-db with a separate git dir is refused", () =>
    refusedWith("/usr/lib/git-core/git-init-db --separate-git-dir /tmp/site-b/g", SETUP_REASON));
  it("git-clone with -c is refused", () =>
    refusedWith(`/usr/lib/git-core/git-clone -c core.hooksPath=/tmp/site-b/h ${URL}`, SETUP_REASON));
  it("git-maintenance start is refused", () => refusedWith("/usr/lib/git-core/git-maintenance start", MAINTENANCE_REASON));
  it("git-maintenance run is allowed", () => allowed("/usr/lib/git-core/git-maintenance run"));
  it("git-remote rm is refused", () => refusedAsRemote("/usr/lib/git-core/git-remote rm origin"));
  it("git-remote rm written without a path is refused", () => refusedAsRemote("git-remote rm origin"));
});

describe("an older pattern answers a read of the push address", () => {
  it("git remote get-url --push is refused by the push/commit/add pattern", () =>
    refusedWith("git remote get-url --push origin", PUSH_COMMIT_ADD_REASON));
});

describe("an earlier check keeps its reason", () => {
  it("an alias defined by -c", () => refusedWith("git -c alias.x=clone x --template=/tmp/site-b/t", ALIAS_REASON));
  it("git remote add (the deny pattern)", () => refusedAsRemote(`git remote add origin ${URL}`));
  it("git -C <dir> remote rename (the deny pattern)", () => refusedAsRemote("git -C /tmp/site-b/r remote rename a b"));
  it("-c before remote add (the push/commit/add pattern)", () =>
    refusedWith(`git -c a.b=c remote add x ${URL}`, PUSH_COMMIT_ADD_REASON));
  it("git-remote add (the push/commit/add pattern)", () =>
    refusedWith(`/usr/lib/git-core/git-remote add x ${URL}`, PUSH_COMMIT_ADD_REASON));
  it("a -C value `init` before a configuration write (the configuration check)", () =>
    refusedWith("git -C init config a.b c", CONFIG_REASON));
  it("a -C value `init` before a configuration write with an option that is not an init option (the configuration check)", () =>
    refusedWith("git -C init config --unset a.b", CONFIG_REASON));
});
