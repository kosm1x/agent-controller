/**
 * Git environment names in the shell gate. Both directions are pinned: a command that writes out `GIT_CONFIG…` or
 * `GIT_TEMPLATE_DIR`, or one that writes out `GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR` or a name ending in
 * `HOME` together with an `init`, `init-db` or `clone` word, is refused; the `$NAME`, `${NAME}` and `${NAME:-w}` reads
 * listed below, a place name without a setup word and a setup word without a place name are allowed; a command
 * another check refuses keeps that check's reason.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { validateShellCommand } from "./shell.js";

const CONFIG_ENV_REASON = "`GIT_CONFIG…` and `GIT_TEMPLATE_DIR` are not written out in a shell_exec command";
const SETUP_ENV_REASON =
  "a command with an `init`, `init-db` or `clone` word is not run from shell_exec when it also writes out `GIT_DIR`";
const SETUP_REASON = "`git init` / `git clone` is run from shell_exec only in its plain form";
const CONFIG_REASON = "changing git configuration is not done from shell_exec";
const ALIAS_REASON = "a git alias defined on the command line";
const PUSH_COMMIT_ADD_REASON = "git operations blocked in shell_exec — use git_commit/git_push tools";
const ENV_RESET_REASON = "replaces the child PATH/environment";
const PIP_ENV_REASON = "changes pip's environment";
const URL = "https://site.example/r.git";

beforeEach(() => {
  vi.stubEnv("HOME", "/root");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

function refusedWith(cmd: string, reason: string): void {
  const r = validateShellCommand(cmd);
  expect(r.allowed, cmd).toBe(false);
  expect(r.reason, cmd).toContain(reason);
}
function allowed(cmd: string): void {
  expect(validateShellCommand(cmd), cmd).toEqual({ allowed: true });
}

describe("a configuration name written out in the command is refused", () => {
  it.each([
    "GIT_CONFIG_COUNT=0 git fetch",
    "export GIT_CONFIG_COUNT=0; git fetch",
    "env GIT_CONFIG_COUNT=0 git fetch",
    "readonly GIT_CONFIG_COUNT=0; git fetch",
    "export \"GIT_CONFIG_COUNT=0\"; git fetch",
    "env 'GIT_CONFIG_COUNT=0' git fetch",
    "GIT_CONFIG_COUNT= git fetch",
    "unset GIT_CONFIG_COUNT; git fetch",
    "env -uGIT_CONFIG_COUNT git fetch",
    "env -vuGIT_CONFIG_COUNT git fetch",
    "read GIT_CONFIG_COUNT </tmp/site-b/n; git fetch",
    "for GIT_CONFIG_COUNT in 0; do git fetch; done",
    ": $((GIT_CONFIG_COUNT=0)); git fetch",
    ": $((GIT_CONFIG_COUNT-=1)); git fetch",
    "export \"GIT_\"\"CONFIG_COUNT=0\"; git fetch",
    "n=GIT_CONFIG_COUNT; export $n=0; git fetch",
    "n=xGIT_CONFIG_COUNT; export ${n#x}=0; git fetch",
    "export${IFS}GIT_CONFIG_COUNT=0; git fetch",
    "GIT_CONFIG_COUNT=0;git fetch",
    "(GIT_CONFIG_COUNT=0 git fetch)",
    "GIT_CONFIG_COUNT=0>/dev/null git fetch",
    "export GIT_CON\\FIG_COUNT=0; git fetch",
    "node -e \"process.env.GIT_CONFIG_COUNT='0'\"",
    "GIT_CONFIG_KEY_1=core.hooksPath GIT_CONFIG_VALUE_1=/tmp/site-b/h git fetch",
    "GIT_CONFIG_PARAMETERS=\"'core.hookspath'='/tmp/site-b/h'\" git fetch",
    "GIT_CONFIG_GLOBAL=/tmp/site-b/c git fetch",
    "GIT_CONFIG_NOSYSTEM=1 git fetch",
    "GIT_TEMPLATE_DIR=/tmp/site-b/t git -C /root/claude/proj-a init",
    "echo GIT_CONFIG_COUNT",
    "grep -n GIT_CONFIG src/x.ts",
  ])("%s", (cmd) => refusedWith(cmd, CONFIG_ENV_REASON));

  it("a name inside `bash -c` is refused from the inner validation", () => {
    refusedWith("bash -c 'GIT_CONFIG_COUNT+=0 git fetch'", `inside \`bash\`: ${CONFIG_ENV_REASON}`);
    refusedWith("bash -c 'unset GIT_CONFIG_COUNT; git fetch'", `inside \`bash\`: ${CONFIG_ENV_REASON}`);
  });

  it("a name joined by a line continuation is refused", () => {
    refusedWith("GIT_CON\\\nFIG_COUNT=0 git fetch", CONFIG_ENV_REASON);
  });

  it("a name in a quoted heredoc body fed to a shell is refused", () => {
    refusedWith("sh <<'EOF'\nGIT_CONFIG_COUNT=0 git fetch\nEOF", CONFIG_ENV_REASON);
  });

  it("a longer name that holds GIT_CONFIG is refused too (substring match)", () => {
    refusedWith("MY_GIT_CONFIG=1 ls", CONFIG_ENV_REASON);
  });

  it("a `$NAME` read stored in another variable and read back by a plain read of that variable is refused", () => {
    refusedWith("x=$GIT_CONFIG_COUNT; echo \"$x\"", CONFIG_ENV_REASON);
  });
});

describe("a configuration name only in a `${NAME=…}` / `${NAME:=…}` assignment is refused by the raw rule", () => {
  it.each([
    "set -a; : \"${GIT_CONFIG_PARAMETERS:='core.hookspath'='/tmp/site-b/h'}\"; git fetch",
    ": \"${GIT_CONFIG_COUNT:=0}\"; git fetch",
    "set -a; : \"${GIT_TEMPLATE_DIR=/tmp/site-b/t}\"; git init",
  ])("%s", (cmd) => refusedWith(cmd, CONFIG_ENV_REASON));

  it("a line continuation inside the assigned name is joined before the raw rule", () => {
    refusedWith("set -a; : \"${GIT_CONFIG_PARA\\\nMETERS:=x}\"; git fetch", CONFIG_ENV_REASON);
  });
});

describe("a plain read of a configuration name is allowed", () => {
  it.each([
    "echo \"$GIT_CONFIG_COUNT\"",
    "echo \"${GIT_CONFIG_KEY_0}\"",
    "echo \"${GIT_CONFIG_COUNT:-0}\"",
    "echo \"$GIT_TEMPLATE_DIR\"",
    "x=$GIT_CONFIG_COUNT",
  ])("%s", allowed);
});

describe("a command with none of the listed names is allowed", () => {
  it.each([
    "git config --get user.name",
    "git -C /root/claude/proj-a status",
    "git -C /root/claude/proj-a fetch",
  ])("%s", allowed);
});

describe("a place name written out with a setup word is refused", () => {
  it.each([
    "HOME=/tmp/site-b git init",
    "export HOME=/tmp/site-b; git init",
    "git init; HOME=/tmp/site-b",
    `XDG_CONFIG_HOME=/tmp/site-b git clone ${URL}`,
    `env HOME=/tmp/site-b git clone ${URL}`,
    "HOME=/tmp/site-b sh -c 'git init'",
    "export HOME=/tmp/site-b; sh <<'EOF'\ngit init\nEOF",
    "HOME=/tmp/site-b git init>/dev/null",
    `git clone ${URL} HOME`,
    "GIT_DIR=/tmp/site-b/g git init",
    "GIT_WORK_TREE=/root/claude/proj-a git init",
    "GIT_COMMON_DIR=/tmp/site-b/g git init-db",
    "cd /tmp/site-b && : $((HOME=0)) && git init",
    "for HOME in /tmp/site-b; do git init; done",
    "export${IFS}HOME=/tmp/site-b; git init",
    "HOME=/tmp/site-b gh repo clone o/r",
    `HOME=/tmp/site-b /usr/lib/git-core/git-clone ${URL}`,
    `JAVA_HOME=/tmp/site-b git clone ${URL}`,
  ])("%s", (cmd) => refusedWith(cmd, SETUP_ENV_REASON));

  it("a place name inside `bash -c` is refused from the inner validation", () => {
    refusedWith("bash -c 'HOME=/tmp/site-b git init'", `inside \`bash\`: ${SETUP_ENV_REASON}`);
  });

  it("a setup word joined by a line continuation is refused", () => {
    refusedWith("HOME=/tmp/site-b git in\\\nit", SETUP_ENV_REASON);
  });

  it("a `$NAME` read stored in another variable and read back by a plain read of that variable is refused", () => {
    refusedWith(`D=$HOME/r; git clone ${URL} "$D"`, SETUP_ENV_REASON);
  });
});

describe("a place name only in a `${NAME=…}` / `${NAME:=…}` assignment with a setup word is refused by the raw rule", () => {
  it.each([
    "set -a; : \"${XDG_CONFIG_HOME:=/tmp/site-b}\"; git init",
    "set -a; : \"${GIT_DIR:=/tmp/site-b/g}\"; git init",
    "set -a; : \"${GIT_WORK_TREE:=/tmp/site-b}\"; git init",
    "set -a; : \"${GIT_COMMON_DIR=/tmp/site-b/g}\"; git init",
  ])("%s", (cmd) => refusedWith(cmd, SETUP_ENV_REASON));

  it("a line continuation inside the assigned name is joined before the raw rule", () => {
    refusedWith("set -a; : \"${XDG_CONFIG_HO\\\nME:=/tmp/site-b}\"; git init", SETUP_ENV_REASON);
  });
});

describe("a place name without a setup word, or a setup word without a place name, is allowed", () => {
  it.each([
    "HOME=/tmp/site-b ls",
    "GIT_DIR=/tmp/site-b/g git status",
    "set -a; : \"${XDG_CONFIG_HOME:=/tmp/site-b}\"; ls",
    "HOME=/tmp/site-b git submodule update --init",
    "HOME=/tmp/site-b git config --get init.defaultBranch",
    "HOMEDIR=/tmp/site-b git init",
    "git init",
    `git clone ${URL} /root/claude/proj-a/r`,
    "cd \"$HOME\" && git init",
    "cd \"${HOME}\" && git init",
    `git clone ${URL} "\${HOME}/claude/proj-a/r"`,
  ])("%s", allowed);
});

describe("a command another check refuses keeps that check's reason", () => {
  it("git push keeps the push/commit/add reason", () => {
    refusedWith("GIT_CONFIG_COUNT=0 git -C /tmp/site-b/r push", PUSH_COMMIT_ADD_REASON);
  });
  it("an array element inside `bash -c` keeps the glob reason", () => {
    refusedWith("bash -c 'GIT_CONFIG_COUNT[0]=0; git fetch'", "inside `bash`: command name from a glob is not judged");
  });
  it.each(["env -u GIT_CONFIG_COUNT git fetch", "env --unset=GIT_CONFIG_COUNT git fetch"])(
    "%s keeps the environment-reset reason",
    (cmd) => refusedWith(cmd, ENV_RESET_REASON),
  );
  it("an alias keeps the alias reason", () => {
    refusedWith("git -c alias.x=y x; GIT_CONFIG_COUNT=0", ALIAS_REASON);
  });
  it("a pip name keeps the pip reason", () => {
    refusedWith("export PIP_X=1 GIT_CONFIG_COUNT=0", PIP_ENV_REASON);
  });
  it("a configuration write keeps the configuration reason", () => {
    refusedWith("GIT_CONFIG_COUNT=0 git config core.x v", CONFIG_REASON);
  });
  it("a setup option keeps the setup reason", () => {
    refusedWith("HOME=/tmp/site-b git init --template=/tmp/site-b/t", SETUP_REASON);
  });
});
