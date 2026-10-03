import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Spec for the cloud-session copy of the mc-guard PreToolUse hook
 * (.claude/hooks/mc-guard.sh). It is a string-level seatbelt: these cases pin the
 * operator-only actions it must deny and the reads it must keep allowing.
 */
const HOOK = resolve(dirname(fileURLToPath(import.meta.url)), "../.claude/hooks/mc-guard.sh");

function run(payload: unknown, env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync("bash", [HOOK], { input: JSON.stringify(payload), env, encoding: "utf8" });
}

function decide(command: string, env?: NodeJS.ProcessEnv): "deny" | "allow" {
  const out = run({ tool_name: "Bash", tool_input: { command } }, env).trim();
  if (out === "") return "allow";
  const parsed = JSON.parse(out) as {
    hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string };
  };
  expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
  expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
  expect(parsed.hookSpecificOutput.permissionDecisionReason).toMatch(/^mc-guard: /);
  return "deny";
}

describe("mc-guard hook (cloud copy)", () => {
  it.each([
    // a. executing deploy.sh
    "./scripts/deploy.sh",
    "scripts/deploy.sh",
    "bash scripts/deploy.sh",
    "sh ./scripts/deploy.sh",
    "/root/claude/mission-control/scripts/deploy.sh",
    "npm run typecheck && ./scripts/deploy.sh",
    // b. sqlite3 on mc.db without -readonly
    "sqlite3 data/mc.db 'ALTER TABLE x ADD COLUMN y'",
    "sqlite3 ./data/mc.db < ddl.sql",
    "echo 'select 1' | sqlite3 /root/claude/mission-control/data/mc.db",
    // c. destroying or overwriting the DB
    "rm data/mc.db",
    "rm -f data/mc.db-wal data/mc.db-shm",
    "mv data/mc.db /tmp/old.db",
    "cp /tmp/empty.db data/mc.db",
    "> data/mc.db",
    "echo x >> data/mc.db",
    "truncate -s 0 data/mc.db",
    // d. service lifecycle
    "systemctl restart mission-control",
    "systemctl stop mission-control.service",
    "npm run build\nsystemctl start mission-control",
    // W1: real command positions still count
    "bash <<EOF\n./scripts/deploy.sh\nEOF",
    "echo $(./scripts/deploy.sh)",
    "echo \"$(./scripts/deploy.sh)\"",
    "echo `./scripts/deploy.sh`",
    "bash -c './scripts/deploy.sh'",
    "cat <<'EOF' | bash\nsystemctl restart mission-control\nEOF",
    "echo 'rm -f data/mc.db' | sh",
    "bash <<< 'rm data/mc.db'",
    "bash < scripts/deploy.sh",
    // W2: wrappers by basename, wrapper options, glued redirect, non-reader programs
    "/usr/bin/sudo ./scripts/deploy.sh",
    "sudo -u root ./scripts/deploy.sh",
    "timeout -s KILL 60 ./scripts/deploy.sh",
    "nice -n 5 ./scripts/deploy.sh",
    "env -u FOO ./scripts/deploy.sh",
    "env A=1 B=2 ./scripts/deploy.sh",
    "setsid ./scripts/deploy.sh",
    "flock /tmp/x.lock ./scripts/deploy.sh",
    "ionice -c 3 ./scripts/deploy.sh",
    "chrt 10 ./scripts/deploy.sh",
    "stdbuf -oL ./scripts/deploy.sh",
    "ls | xargs -I{} sudo ./scripts/deploy.sh {}",
    "eval ./scripts/deploy.sh",
    "eval 'systemctl restart mission-control'",
    "watch -n 5 'systemctl restart mission-control'",
    "./scripts/deploy.sh>out.log",
    "./scripts/deploy.sh 2>&1",
    "source scripts/deploy.sh",
    ". scripts/deploy.sh",
    "nohup bash scripts/deploy.sh &",
    // W3: more systemctl verbs and `service`
    "systemctl kill mission-control",
    "systemctl try-restart mission-control",
    "systemctl reload-or-restart mission-control",
    "systemctl try-reload-or-restart mission-control",
    "systemctl condrestart mission-control",
    "systemctl force-reload mission-control",
    "systemctl reload mission-control",
    "systemctl disable --now mission-control",
    "systemctl mask --now mission-control",
    "systemctl isolate rescue.target",
    "sudo systemctl --no-pager restart mission-control.service",
    "service mission-control restart",
    "service mission-control stop",
    // W4: git clean -x/-X, ln onto, rm of the data dir, find -delete/-exec rm, >| clobber
    "git clean -fdx",
    "git clean -fX",
    "git -C /root/claude/mission-control clean -f -x",
    "ln -sf /tmp/empty.db data/mc.db",
    "rm -rf data",
    "rm -rf data/",
    "rm -rf data/*",
    "rm -rf /root/claude/mission-control/data",
    "find . -name mc.db -delete",
    "find data -type f -delete",
    "find . -name '*.db' -exec rm {} +",
    "echo x >| data/mc.db",
    "echo x &> data/mc.db",
    // W5: file: URIs and readonly only as a real flag
    "sqlite3 file:data/mc.db 'drop table t'",
    "sqlite3 'file:data/mc.db?cache=shared' 'drop table t'",
    "sqlite3 data/mc.db 'drop table t -- -readonly'",
    // Round 2: printf / echo -e escapes piped into a shell
    "printf './scripts/deploy.sh\\n' | bash",
    "echo -e './scripts/deploy.sh\\n' | sh",
    "printf 'ls\\nsystemctl restart mission-control\\n' | bash",
    "printf 'ls\\t; rm data/mc.db' | bash",
    // Round 2: repo data dir under the anchored patterns
    "rm -rf ./data",
    "rm -rf /root/claude/mission-control-jarvis/data/*",
    "find ./data -name '*.json' -delete",
    // Round 2: deploy.sh where it still runs
    "bash scripts/deploy.sh -n",
    "npx tsx scripts/deploy.sh",
    "cp /tmp/evil.sh scripts/deploy.sh",
    // Round 2: sqlite3 ATTACH of mc.db from another database
    "sqlite3 :memory: \"ATTACH 'data/mc.db' AS m; DELETE FROM m.t\"",
    "sqlite3 'file:data/mc.db?mode=ro' \"ATTACH 'data/mc.db' AS w; DELETE FROM w.t\"",
    // Round 2: escapes inside double quotes do not end the string early
    'bash -c "echo \\"hi\\"; ./scripts/deploy.sh"',
    // Round 2: <<- strips leading tabs from the delimiter, so the next line is a command
    "cat <<-EOF\n\tnotes\n\tEOF\n./scripts/deploy.sh",
    "bash <<-EOF\n\t./scripts/deploy.sh\n\tEOF",
    // Round 2: past the nesting cap is a deny, not an allow
    "eval eval eval eval eval eval eval eval ls",
  ])("denies %j", (command) => {
    expect(decide(command)).toBe("deny");
  });

  it.each([
    "cat scripts/deploy.sh",
    "less scripts/deploy.sh",
    "grep -n verify scripts/deploy.sh",
    "sed -n 1,40p scripts/deploy.sh",
    "git diff scripts/deploy.sh",
    'sqlite3 -readonly data/mc.db "select 1"',
    "cp data/mc.db /tmp/mc-backup.db",
    "systemctl status mission-control",
    "systemctl is-active mission-control",
    "npm test",
    "npm run typecheck",
    "ls data/",
    "ls 2>&1 > out.txt",
    // W1: quoted text, markdown bullets and heredoc bodies fed to non-shells are data
    'git commit -m "fix\n\n- ./scripts/deploy.sh is operator-run"',
    "git commit -m 'fix\n\n- systemctl restart mission-control is operator-run'",
    "gh pr create --title t --body \"$(cat <<'EOF'\n## Checks\n- Deploy: `scripts/deploy.sh` is operator-run; never `rm data/mc.db`\nEOF\n)\"",
    "cat > notes.md <<'EOF'\n- ./scripts/deploy.sh\n- systemctl restart mission-control\n- rm -rf data/\nEOF",
    "tee docs/x.md <<EOF\nsqlite3 data/mc.db 'drop table t'\nEOF",
    'grep -rn "> data/mc.db" docs',
    'echo "a; rm data/mc.db"',
    "echo 'systemctl restart mission-control' # just a note",
    "printf '%s\\n' scripts/deploy.sh",
    "vim scripts/deploy.sh",
    "git log -p -- scripts/deploy.sh",
    "diff scripts/deploy.sh /tmp/deploy.sh",
    // W2-W5 near misses
    "sudo -u root ls data/",
    "timeout -s KILL 60 npm test",
    "systemctl status mission-control.service",
    "systemctl disable other.service",
    "service mission-control status",
    "git clean -fd",
    "git clean -n",
    "ln -s data/mc.db /tmp/mc-link.db",
    "rm -rf dist/",
    "rm -rf node_modules/data-utils",
    "find . -name '*.db' -print",
    "find src -name '*.test.ts' -delete",
    "sqlite3 'file:data/mc.db?mode=ro' 'select 1'",
    "sqlite3 --readonly data/mc.db .schema",
    "sqlite3 /tmp/scratch.db 'create table t(x)'",
    // Round 2: deploy.sh as an argument to readers, checkers and copies
    "find . -name deploy.sh",
    "fd deploy.sh",
    "[ -x scripts/deploy.sh ] && echo yes",
    "[[ -x scripts/deploy.sh ]] && echo yes",
    "test -x scripts/deploy.sh",
    "bash -n scripts/deploy.sh",
    "sh -n scripts/deploy.sh",
    "shellcheck scripts/deploy.sh",
    "chmod +x scripts/deploy.sh",
    "cp scripts/deploy.sh /tmp/",
    "rsync -a scripts/deploy.sh /tmp/x/",
    "sha256sum scripts/deploy.sh",
    "md5sum scripts/deploy.sh",
    "npx prettier --check scripts/deploy.sh",
    "which deploy.sh",
    "type scripts/deploy.sh",
    "command -v scripts/deploy.sh",
    "stat scripts/deploy.sh",
    "gh api repos/kosm1x/agent-controller/contents/scripts/deploy.sh",
    // Round 2: data dirs that are not the repo's
    "rm -rf /tmp/build/data",
    "rm -rf src/tools/data/",
    "rm -f tests/fixtures/data/*",
    "find src/tools/data -type f -delete",
    // Round 2: escapes inside double quotes keep the text one word
    'echo "a \\"; rm data/mc.db; echo \\""',
    'echo "\\$(./scripts/deploy.sh)"',
    // Round 2: <<- body fed to a non-shell stays data; << does not strip tabs
    "cat <<-EOF\n\t./scripts/deploy.sh\n\tEOF\necho ok",
    "cat <<EOF\n\tnotes\n\tEOF\n./scripts/deploy.sh",
    "eval eval ls",
  ])("allows %j", (command) => {
    expect(decide(command)).toBe("allow");
  });

  it("ignores non-Bash tools", () => {
    expect(run({ tool_name: "Read", tool_input: { file_path: "data/mc.db" } })).toBe("");
  });

  it("works with a minimal PATH (bash and node only)", () => {
    // jq is not needed: the script parses and lexes with node.
    const bin = mkdtempSync(join(tmpdir(), "mc-guard-path-"));
    for (const tool of ["bash", "node"]) {
      const real = execFileSync("bash", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim();
      symlinkSync(real, join(bin, tool));
    }
    const env = { ...process.env, PATH: bin };
    expect(decide("systemctl restart mission-control", env)).toBe("deny");
    expect(decide("npm test", env)).toBe("allow");
  });
});
