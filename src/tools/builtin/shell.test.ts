/**
 * Shell command validation tests.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  shellTool,
  validateShellCommand,
  checkUnscopedTestRun,
  isDbOp,
  resolveShellTimeout,
  isSecretEnvKey,
  buildScrubbedEnv,
} from "./shell.js";
import { _resetFlailingGuard } from "../flailing-guard.js";

describe("resolveShellTimeout — DB ops get a larger budget; cap is a real hard cap", () => {
  const DB = "docker exec supabase-db psql -U postgres -c 'TRUNCATE x CASCADE'";
  const GEN = "ls -la /root";

  it("general command, no override → 30s default", () => {
    expect(resolveShellTimeout(GEN, undefined)).toBe(30_000);
  });
  it("general command, override within cap → honored", () => {
    expect(resolveShellTimeout(GEN, 45_000)).toBe(45_000);
  });
  it("general command, override above cap → clamped to 60s", () => {
    expect(resolveShellTimeout(GEN, 200_000)).toBe(60_000);
  });
  it("DB op, no override → 120s default (not the 30s general default)", () => {
    expect(resolveShellTimeout(DB, undefined)).toBe(120_000);
  });
  it("DB op, large override → clamped to the 300s DB ceiling", () => {
    expect(resolveShellTimeout(DB, 999_999)).toBe(300_000);
  });
  it("DB op, small explicit override → honored (only RAISES default/ceiling)", () => {
    expect(resolveShellTimeout(DB, 5_000)).toBe(5_000);
  });
  // W1: a non-positive / non-numeric timeout_ms must NOT become 0 — Node's exec
  // treats timeout:0 as "no timeout", which would bypass the ceiling.
  it("timeout_ms=0 falls back to the default (never unbounded)", () => {
    expect(resolveShellTimeout(GEN, 0)).toBe(30_000);
    expect(resolveShellTimeout(DB, 0)).toBe(120_000);
  });
  it("negative / non-numeric timeout_ms falls back to the default", () => {
    expect(resolveShellTimeout(GEN, -5)).toBe(30_000);
    expect(resolveShellTimeout(GEN, "60000")).toBe(30_000);
    expect(resolveShellTimeout(GEN, null)).toBe(30_000);
  });
});

describe("env scrub — shell_exec child cannot inherit secrets (H1)", () => {
  it("flags secret-shaped env keys (incl. mid-name and no-keyword cases)", () => {
    const secret = [
      "MC_API_KEY",
      "INFERENCE_PRIMARY_KEY",
      "TELEGRAM_BOT_TOKEN",
      "GOOGLE_CLIENT_SECRET",
      "GOOGLE_REFRESH_TOKEN",
      "EMAIL_COMUNIDADES_PASSWORD",
      "X_AUTH_TOKEN__iooking4ward", // _TOKEN is mid-name, not a suffix
      "X_CT0__mexiconecesario", // no secret keyword at all — prefix rule
    ];
    for (const k of secret) expect(isSecretEnvKey(k)).toBe(true);
  });

  it("leaves plain operational vars alone", () => {
    const plain = [
      "PATH",
      "HOME",
      "LANG",
      "TZ",
      "USER",
      "MC_DB_PATH",
      "MC_PORT",
    ];
    for (const k of plain) expect(isSecretEnvKey(k)).toBe(false);
  });

  it("removes secret keys from the child env but preserves PATH/HOME", () => {
    const priorKey = process.env.MC_API_KEY;
    const priorTok = process.env.SOME_FAKE_TOKEN;
    process.env.MC_API_KEY = "real-control-plane-key";
    process.env.SOME_FAKE_TOKEN = "abc123";
    try {
      const env = buildScrubbedEnv();
      expect(env.MC_API_KEY).toBeUndefined();
      expect(env.SOME_FAKE_TOKEN).toBeUndefined();
      expect(env.PATH).toBe(process.env.PATH);
      expect(env.HOME).toBe(process.env.HOME);
    } finally {
      if (priorKey === undefined) delete process.env.MC_API_KEY;
      else process.env.MC_API_KEY = priorKey;
      if (priorTok === undefined) delete process.env.SOME_FAKE_TOKEN;
      else process.env.SOME_FAKE_TOKEN = priorTok;
    }
  });
});

describe("isDbOp — DB commands get the larger timeout budget", () => {
  const dbOps = [
    "psql -U postgres -c 'TRUNCATE minisu.ventas CASCADE'",
    "docker exec supabase-db psql -U postgres -d postgres -c 'COPY x FROM ...'",
    "pg_dump mydb > /tmp/dump.sql",
    "pg_dumpall -U postgres",
    "pg_restore -d db /tmp/dump.sql",
    "mysql -u root -e 'SELECT 1'",
    "mysqldump db > /tmp/db.sql",
    "mariadb -e 'SHOW TABLES'",
  ];
  for (const cmd of dbOps) {
    it(`detects DB op: ${cmd.slice(0, 48)}`, () => {
      expect(isDbOp(cmd)).toBe(true);
    });
  }

  const nonDbOps = [
    "ls /root",
    "npm test",
    "node --version",
    "cat /etc/hostname",
    "echo psqlfoo", // word-boundary: 'psql' inside a longer token does not match
    "curl https://example.com",
  ];
  for (const cmd of nonDbOps) {
    it(`leaves general command alone: ${cmd}`, () => {
      expect(isDbOp(cmd)).toBe(false);
    });
  }
});

describe("validateShellCommand", () => {
  describe("allowed commands", () => {
    const allowed = [
      "ls /root",
      "node --version",
      "cat /etc/hostname",
      "echo hello",
      "pwd",
      "git status",
      "curl https://example.com",
      'python3 -c "print(1+1)"',
      "ls -la | grep .ts | wc -l",
      "echo hello > /root/claude/cuatro-flor/test.txt",
      "echo hello > /tmp/test.txt",
      "cp /root/claude/projects/a.txt /root/claude/projects/b.txt",
      "tee /workspace/output.log",
    ];

    for (const cmd of allowed) {
      it(`should allow: ${cmd}`, () => {
        expect(validateShellCommand(cmd)).toEqual({ allowed: true });
      });
    }
  });

  describe("blocked commands", () => {
    // 2026-07-12 vitest-saturation incident: npm test = bare full-suite run.
    it("blocks `npm test` (unscoped full-suite, deliberate change)", () => {
      const r = validateShellCommand("npm test");
      expect(r.allowed).toBe(false);
      expect(r.reason).toMatch(/FULL vitest suite/);
    });

    const blocked: [string, string][] = [
      ["rm -rf /", "command 'rm' is blocked"],
      ["rm file.txt", "command 'rm' is blocked"],
      ["shutdown now", "command 'shutdown' is blocked"],
      ["reboot", "command 'reboot' is blocked"],
      ["kill -9 1234", "command 'kill' is blocked"],
      ["killall node", "command 'killall' is blocked"],
      ["systemctl stop nginx", "command 'systemctl' is blocked"],
      ["mkfs.ext4 /dev/sda1", "filesystem format"],
      ["dd if=/dev/zero of=/dev/sda", "command 'dd' is blocked"],
      ["iptables -F", "command 'iptables' is blocked"],
      ["passwd root", "command 'passwd' is blocked"],
      ["mount /dev/sda1 /mnt", "command 'mount' is blocked"],
      ["crontab -e", "command 'crontab' is blocked"],
    ];

    for (const [cmd, reason] of blocked) {
      it(`should block: ${cmd}`, () => {
        const result = validateShellCommand(cmd);
        expect(result.allowed).toBe(false);
        expect(result.reason).toBe(reason);
      });
    }
  });

  describe("blocked patterns", () => {
    it("should block rm with absolute paths in pipes", () => {
      const result = validateShellCommand("echo test | rm -rf /tmp/foo");
      expect(result.allowed).toBe(false);
    });

    it("should block redirect to /etc/", () => {
      const result = validateShellCommand("echo x > /etc/passwd");
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("redirect to system directory");
    });

    it("should block redirect to /boot/", () => {
      const result = validateShellCommand("echo x > /boot/grub/grub.cfg");
      expect(result.allowed).toBe(false);
    });

    it("should block chmod 777", () => {
      const result = validateShellCommand("chmod 777 /root/claude/file");
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("overly permissive chmod");
    });

    it("should block dd anywhere in command", () => {
      const result = validateShellCommand(
        "echo test && dd if=/dev/zero of=disk.img",
      );
      expect(result.allowed).toBe(false);
    });

    it("should block reading mission-control .env (the bot-token extraction, 2026-06-20)", () => {
      // The grep alternation arg ("A\|B") contains a `|` — the guard must still fire.
      const result = validateShellCommand(
        'grep -n "TELEGRAM_BOT_TOKEN\\|TELEGRAM_OWNER" /root/claude/mission-control/.env',
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe(
        "read of mission-control .env (secrets) blocked",
      );
      // Also blocks suffixed variants and other reader commands.
      expect(
        validateShellCommand("cat /root/claude/mission-control/.env.local")
          .allowed,
      ).toBe(false);
    });

    it("blocks cut/tr reading mission-control .env (near-variants of the incident)", () => {
      expect(
        validateShellCommand("cut -d= -f2- /root/claude/mission-control/.env")
          .allowed,
      ).toBe(false);
    });

    it("does NOT block project .env reads (DENUE analyzer API-key retrieval)", () => {
      // fast-runner.ts instructs the agent to read the analyzer's own API key this
      // way — a blanket .env block would break every authenticated DENUE query.
      expect(
        validateShellCommand(
          "grep '^API_KEY=' /root/claude/projects/data-intelligence/denue-data-analysis/.env | cut -d= -f2-",
        ).allowed,
      ).toBe(true);
    });

    it("does NOT block mission-control .environment (word char after env)", () => {
      expect(
        validateShellCommand("cat /root/claude/mission-control/.environment")
          .allowed,
      ).toBe(true);
    });
  });

  describe("git command blocking", () => {
    it("blocks git push", () => {
      const result = validateShellCommand("git push -u origin main");
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/git operations blocked|mutating git/);
    });

    it("blocks git commit", () => {
      const result = validateShellCommand('git commit -m "test"');
      expect(result.allowed).toBe(false);
    });

    it("blocks git add", () => {
      const result = validateShellCommand("git add .");
      expect(result.allowed).toBe(false);
    });

    it("blocks git -C /path push (flag-before-subcommand bypass)", () => {
      const result = validateShellCommand(
        "git -C /root/claude/cuatro-flor push",
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/git operations blocked|mutating git/);
    });

    it("blocks git -C /path commit", () => {
      const result = validateShellCommand(
        'git -C /root/claude/cuatro-flor commit -m "msg"',
      );
      expect(result.allowed).toBe(false);
    });

    it("allows git status (read-only)", () => {
      expect(validateShellCommand("git status")).toEqual({ allowed: true });
    });

    it("allows git log (read-only)", () => {
      expect(validateShellCommand("git log --oneline -5")).toEqual({
        allowed: true,
      });
    });

    it("allows git diff (read-only)", () => {
      expect(validateShellCommand("git diff HEAD")).toEqual({ allowed: true });
    });

    it("blocks git --work-tree /path push (long-flag bypass)", () => {
      const result = validateShellCommand(
        "git --work-tree=/root/claude/cuatro-flor push",
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/git operations blocked|mutating git/);
    });

    it("blocks git --no-verify commit (long-flag bypass)", () => {
      const result = validateShellCommand('git --no-verify commit -m "msg"');
      expect(result.allowed).toBe(false);
    });

    it("blocks git remote set-url", () => {
      const result = validateShellCommand(
        "git remote set-url origin https://example.com",
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("git remote modification");
    });
  });

  describe("write path enforcement", () => {
    it("should block writes outside allowed paths", () => {
      const result = validateShellCommand("echo x > /var/log/test.log");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("outside allowed paths");
    });

    it("should allow writes to project dirs under /root/claude/", () => {
      expect(
        validateShellCommand("echo x > /root/claude/cuatro-flor/test.txt"),
      ).toEqual({ allowed: true });
    });

    it("should allow writes to /tmp/", () => {
      expect(validateShellCommand("echo x > /tmp/test.txt")).toEqual({
        allowed: true,
      });
    });

    it("should block cp to system directories", () => {
      const result = validateShellCommand("cp file.txt /usr/local/bin/foo");
      expect(result.allowed).toBe(false);
    });

    it("should allow cp within project dirs", () => {
      expect(
        validateShellCommand(
          "cp /root/claude/projects/a.ts /root/claude/projects/b.ts",
        ),
      ).toEqual({ allowed: true });
    });
  });

  describe("path-prefixed commands", () => {
    it("should block /usr/bin/rm", () => {
      const result = validateShellCommand("/usr/bin/rm -rf /");
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("command 'rm' is blocked");
    });

    it("should block /sbin/shutdown", () => {
      const result = validateShellCommand("/sbin/shutdown -h now");
      expect(result.allowed).toBe(false);
    });
  });

  describe("chained commands", () => {
    it("should block rm in a chain with &&", () => {
      const result = validateShellCommand("echo hello && rm -rf /");
      expect(result.allowed).toBe(false);
    });

    it("should block rm in a chain with ;", () => {
      const result = validateShellCommand("ls; rm file.txt");
      expect(result.allowed).toBe(false);
    });

    it("should block rm in a chain with ||", () => {
      const result = validateShellCommand("false || rm file.txt");
      expect(result.allowed).toBe(false);
    });
  });

  describe("command substitution bypass", () => {
    it("should block $(...) substitution", () => {
      const result = validateShellCommand("ls $(rm -rf /)");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("$(...) is blocked");
    });

    it("should block backtick substitution", () => {
      const result = validateShellCommand("echo `cat /etc/passwd`");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("backtick");
    });

    it("should block nested $() in find -exec", () => {
      const result = validateShellCommand(
        "find . -name '*.ts' -exec $(killall node) \\;",
      );
      expect(result.allowed).toBe(false);
    });

    it("should block dangerous commands in ${} expansion", () => {
      const result = validateShellCommand("echo ${rm -rf /tmp}");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("dangerous command");
    });

    it("should allow safe variable references", () => {
      expect(validateShellCommand("echo $HOME").allowed).toBe(true);
      expect(validateShellCommand("echo ${PATH}").allowed).toBe(true);
      expect(validateShellCommand("ls $PWD/src").allowed).toBe(true);
    });

    it("should allow arithmetic expansion $((...))", () => {
      expect(validateShellCommand("echo $((3*4))").allowed).toBe(true);
      expect(validateShellCommand("echo $((1+2))").allowed).toBe(true);
    });

    it("should block process substitution <() and >()", () => {
      const r1 = validateShellCommand(
        "diff <(cat /etc/shadow) <(cat /etc/passwd)",
      );
      expect(r1.allowed).toBe(false);
      expect(r1.reason).toContain("process substitution");

      const r2 = validateShellCommand("cat <(rm -rf /)");
      expect(r2.allowed).toBe(false);

      const r3 = validateShellCommand("cmd1 | tee >(grep error)");
      expect(r3.allowed).toBe(false);
      expect(r3.reason).toContain("process substitution");
    });

    it("allows JS arrow with paren body — not bash process-sub", () => {
      // `=>(` is JavaScript arrow returning an object literal. Bash
      // process-substitution always has a separator before the `<`/`>`,
      // so we anchor the rule on that to avoid this false-positive.
      const r1 = validateShellCommand('node -e "[1,2].map(x=>({n:x}))"');
      expect(r1.allowed).toBe(true);
    });

    it("allows TS generic instantiation Map<T>()", () => {
      // TypeScript `new Map<string,boolean>()` produces `>(` immediately
      // after a generic type parameter. Same anchor rule keeps this allowed.
      const r1 = validateShellCommand(
        'node -e "const m = new Map<string,boolean>()"',
      );
      expect(r1.allowed).toBe(true);
    });
  });

  describe("quoted heredoc body bypass", () => {
    // Bash treats `<<'EOF'` and `<<"EOF"` heredoc bodies as literal text — no
    // var expansion, no command substitution. Validating them as shell syntax
    // false-positives on every JS/TS/JSON/Python file Jarvis writes via
    // `cat > path << 'EOF' ... EOF`. Strip the body before validation.
    it("allows JS template literals in single-quoted heredoc body", () => {
      const cmd = `cat > /tmp/foo.ts << 'EOF'
const url = \`https://api.example.com/q?id=\${id}\`;
console.log(\`done: \${count}\`);
EOF`;
      const r = validateShellCommand(cmd);
      expect(r.allowed).toBe(true);
    });

    it("allows TS generics + arrow + backticks together in heredoc body", () => {
      const cmd = `cat > /tmp/foo.ts << 'SCRIPT'
const m = new Map<string,number>();
const fn = (x: number) => ({ doubled: x * 2 });
const msg = \`x=\${fn(3).doubled}\`;
SCRIPT`;
      const r = validateShellCommand(cmd);
      expect(r.allowed).toBe(true);
    });

    it("allows double-quoted heredoc delimiter too", () => {
      const cmd = `cat > /tmp/foo.json << "EOF"
{"key": \`backtick\`, "arrow": "=>("}
EOF`;
      const r = validateShellCommand(cmd);
      expect(r.allowed).toBe(true);
    });

    it("still blocks process-sub OUTSIDE the heredoc", () => {
      const cmd = `cat <(echo hi) > /tmp/foo.ts << 'EOF'
safe body content
EOF`;
      const r = validateShellCommand(cmd);
      expect(r.allowed).toBe(false);
      expect(r.reason).toContain("process substitution");
    });

    it("still blocks backticks OUTSIDE the heredoc", () => {
      const cmd = "echo `whoami` > /tmp/foo.ts";
      const r = validateShellCommand(cmd);
      expect(r.allowed).toBe(false);
      expect(r.reason).toContain("backtick");
    });

    it("still validates the redirect target path for quoted heredocs", () => {
      // The first-line redirect must still be checked — strip removes the
      // body but preserves `cat > /etc/hostname` for path validation.
      const cmd = `cat > /etc/hostname << 'EOF'
malicious
EOF`;
      const r = validateShellCommand(cmd);
      expect(r.allowed).toBe(false);
    });

    it("does NOT strip unquoted heredocs (vars/cmds expand there)", () => {
      // `<< EOF` (no quotes) DOES expand $vars and $(cmds), so we must keep
      // scanning the body for command substitution.
      const cmd = `cat > /tmp/foo.txt << EOF
\${HOME} is your home
$(whoami) is the user
EOF`;
      const r = validateShellCommand(cmd);
      expect(r.allowed).toBe(false);
      expect(r.reason).toContain("command substitution");
    });

    // Audit Critical: quote-context blind strip lets `$(...)` hide inside
    // a double-quoted string that LOOKS like a heredoc to a regex but
    // is actually literal text from bash's perspective. Inside `"…"`,
    // bash does NOT recognize `<<'X'` as a heredoc, but DOES expand
    // `$(...)` and backticks. Strip must skip when inside an open `"…"`.
    it("does NOT strip a fake heredoc inside a double-quoted string (PoC)", () => {
      const cmd = `echo "see <<'EOF'
$(whoami)
EOF
done"`;
      const r = validateShellCommand(cmd);
      expect(r.allowed).toBe(false);
      expect(r.reason).toContain("command substitution");
    });

    it("does NOT strip a fake heredoc with backtick-sub inside double quotes", () => {
      const cmd = `echo "fake <<'X'
\`whoami\`
X"`;
      const r = validateShellCommand(cmd);
      expect(r.allowed).toBe(false);
      expect(r.reason).toContain("backtick");
    });

    // Audit Major 1: <<- permits tab-indented closer.
    it("strips <<- variant with tab-indented closer", () => {
      const body = `\tconst foo = \`hello\`;`;
      const cmd = `cat > /tmp/foo.ts <<-'EOF'\n${body}\n\tEOF`;
      const r = validateShellCommand(cmd);
      expect(r.allowed).toBe(true);
    });

    // Audit Major 2: delimiters with hyphen / digits / dots allowed by bash.
    it("strips heredoc with hyphenated delimiter", () => {
      const cmd = `cat > /tmp/foo.ts << 'EOF-1'
const x = \`backtick\`;
EOF-1`;
      const r = validateShellCommand(cmd);
      expect(r.allowed).toBe(true);
    });

    // Audit Minor 2: multiple heredocs in one command.
    it("strips multiple heredocs in a single command", () => {
      const cmd = `cat > /tmp/a.ts << 'A'
const x = \`a\`;
A
cat > /tmp/b.ts << 'B'
const y = \`b\`;
B`;
      const r = validateShellCommand(cmd);
      expect(r.allowed).toBe(true);
    });
  });

  describe("/dev/null discard sinks", () => {
    // Pre-fix the WRITE_INDICATORS regex matched `2>/dev/null` and treated
    // /dev/null as a write target outside ALLOW_WRITE_PREFIXES, blocking
    // every command that silenced stderr — one of the most common idioms.
    it("allows 2>/dev/null stderr discard", () => {
      // Neutral filename: `.env` reads are now blocked by the secrets guard, so
      // this discard-idiom test uses a non-secret file (the suffix is the subject).
      const r = validateShellCommand("cat config.log 2>/dev/null");
      expect(r.allowed).toBe(true);
    });

    it("allows >/dev/null stdout discard", () => {
      const r = validateShellCommand("npm install >/dev/null");
      expect(r.allowed).toBe(true);
    });

    it("allows &>/dev/null both-stream discard", () => {
      const r = validateShellCommand("some-command &>/dev/null");
      expect(r.allowed).toBe(true);
    });

    it("allows chained discard idiom", () => {
      const r = validateShellCommand(
        'cat config.log 2>/dev/null || ls *.log || echo "no file"',
      );
      expect(r.allowed).toBe(true);
    });

    it("still blocks writes to other system paths", () => {
      const r = validateShellCommand("echo bad > /etc/hostname");
      expect(r.allowed).toBe(false);
    });

    it("still blocks /dev/sda writes", () => {
      const r = validateShellCommand("echo bad > /dev/sda");
      expect(r.allowed).toBe(false);
      expect(r.reason).toContain("redirect to system directory");
    });

    // Adversarial path-suffix variants: pre-fix the `\b` after `null` let
    // these slip past DENY_PATTERN. Now they hit the deny path with the
    // expected reason, not a generic "outside allowed paths" fallback.
    it("blocks /dev/null.bak suffix variant at deny stage", () => {
      const r = validateShellCommand("echo data > /dev/null.bak");
      expect(r.allowed).toBe(false);
    });

    it("blocks /dev/null/foo path-traversal variant at deny stage", () => {
      const r = validateShellCommand("echo data > /dev/null/foo");
      expect(r.allowed).toBe(false);
    });

    it("blocks /dev/nullsomething concatenated variant", () => {
      const r = validateShellCommand("echo data > /dev/nullsomething");
      expect(r.allowed).toBe(false);
    });
  });

  describe("williams-entry-radar write access", () => {
    // The radar repo is Jarvis's autonomous build. He needs write access
    // for tooling/scripts the operator authorizes (see CLAUDE.md in the
    // repo). Pre-fix /root/claude/williams-entry-radar/ was not in
    // ALLOW_WRITE_PREFIXES — heredoc-based file writes were rejected.
    it("allows writes inside the radar repo", () => {
      const r = validateShellCommand(
        "echo data > /root/claude/williams-entry-radar/results/scan.csv",
      );
      expect(r.allowed).toBe(true);
    });

    it("allows tee writes inside the radar repo", () => {
      const r = validateShellCommand(
        "tee /root/claude/williams-entry-radar/data/log.txt",
      );
      expect(r.allowed).toBe(true);
    });

    it("allows writes to any project repo under /root/claude/", () => {
      // Sibling repos (vlcrm, intelligence-ops-mcp, eurekams-intelligence-ui, …)
      // are all legitimate targets — the allow-list is a single /root/claude/ prefix,
      // so it can't drift out of date and block a repo it forgot to enumerate.
      const r = validateShellCommand(
        "echo data > /root/claude/eurekams-intelligence-ui/web/build.log",
      );
      expect(r.allowed).toBe(true);
    });

    it("still blocks writes outside the /root/claude/ git domain", () => {
      // The prefix carries a trailing slash, so a similarly-named sibling like
      // /root/claude-backups is NOT inside the domain and stays blocked.
      const r = validateShellCommand(
        "echo bad > /root/claude-backups/sprint-1/file.txt",
      );
      expect(r.allowed).toBe(false);
    });

    it("blocks writes to the operator's own config under /root/claude/ (C1 regression guard)", () => {
      // The broad /root/claude/ allow-list must NOT expose the operator's Claude
      // Code settings/hooks, MCP config, or umbrella CLAUDE.md — rewriting them is
      // a guardrail-tamper / command-execution vector.
      for (const cmd of [
        "echo x > /root/claude/.claude/settings.local.json",
        "tee /root/claude/.mcp.json",
        "echo x > /root/claude/CLAUDE.md",
      ]) {
        expect(validateShellCommand(cmd).allowed).toBe(false);
      }
    });
  });
});

describe("shellTool flailing guard integration", () => {
  beforeEach(() => {
    _resetFlailingGuard();
  });

  it("blocks the 4th attempt after 3 prior failures share a token", async () => {
    // Three prior failures running the same kind of nonexistent script.
    // exit(127) is what bash returns for "command not found"; the integer
    // doesn't matter — what matters is non-zero.
    for (const variant of ["v1", "v2", "v3"]) {
      const result = await shellTool.execute({
        command: `node /tmp/flailing_probe_${variant}_nonexistent.cjs`,
      });
      const parsed = JSON.parse(result);
      expect(parsed.exit_code).not.toBe(0);
    }

    const blocked = await shellTool.execute({
      command: "node /tmp/flailing_probe_v4_nonexistent.cjs",
    });
    const parsed = JSON.parse(blocked);
    expect(parsed.exit_code).toBe(-1);
    expect(parsed.stderr).toContain("FLAILING DETECTED");
    expect(parsed.stderr).toContain("3-strike");
    expect(parsed.stdout).toBe("");
  });

  it("does not block unrelated commands even after others have failed", async () => {
    // Three failures on script-A
    for (const variant of ["v1", "v2", "v3"]) {
      await shellTool.execute({
        command: `node /tmp/scriptA_${variant}_nope.cjs`,
      });
    }
    // An unrelated, succeeding command should still run cleanly
    const result = await shellTool.execute({ command: "true" });
    const parsed = JSON.parse(result);
    expect(parsed.exit_code).toBe(0);
  });
});

// Direct coverage of the exec contract (execSync → promisify(exec) conversion).
// These exercise the exact lines that changed: success shape, stderr capture,
// non-zero exit code from `error.code`, output truncation, and the timeout kill.
describe("shellTool exec contract", () => {
  beforeEach(() => {
    _resetFlailingGuard();
  });

  it("returns stdout and exit_code 0 on success", async () => {
    const parsed = JSON.parse(await shellTool.execute({ command: "echo hi" }));
    expect(parsed.exit_code).toBe(0);
    expect(parsed.stdout).toBe("hi\n");
    // No stderr field when the command wrote nothing to stderr.
    expect(parsed.stderr).toBeUndefined();
  });

  it("surfaces non-empty stderr even on a zero-exit command", async () => {
    const parsed = JSON.parse(
      await shellTool.execute({ command: "echo diag >&2" }),
    );
    expect(parsed.exit_code).toBe(0);
    expect(parsed.stderr).toContain("diag");
  });

  it("reports the real non-zero exit code (from error.code, not status)", async () => {
    const parsed = JSON.parse(
      await shellTool.execute({
        command: "sh -c 'echo out; echo err >&2; exit 3'",
      }),
    );
    expect(parsed.exit_code).toBe(3);
    expect(parsed.stdout).toContain("out");
    expect(parsed.stderr).toContain("err");
  });

  it("truncates stdout beyond MAX_OUTPUT with a marker", async () => {
    // `seq 1 20000` prints one number per line — well over MAX_OUTPUT (10000
    // chars). No command substitution (the guard blocks `$()`).
    const parsed = JSON.parse(
      await shellTool.execute({ command: "seq 1 20000" }),
    );
    expect(parsed.exit_code).toBe(0);
    expect(parsed.stdout).toContain("truncated");
  });

  it("flags a timed-out command distinctly (exit_code -2), not as a generic failure", async () => {
    const parsed = JSON.parse(
      await shellTool.execute({ command: "sleep 2", timeout_ms: 100 }),
    );
    expect(parsed.exit_code).toBe(-2);
    expect(parsed.stderr).toContain("timed out");
  });
});

describe("validateShellCommand — RITUAL_WRITABLE_DOCS append-only gate (2026-06-17)", () => {
  // Coverage note: these pin the WRITE_INDICATORS-captured overwrite forms the
  // gate actually blocks (`>`, tee, etc.). The gate is best-effort, NOT airtight —
  // it does NOT close `>|` / `truncate` / `sed -i` / relative-path truncation
  // (those skip WRITE_INDICATORS entirely). Durable git persistence is the real
  // backstop; see feedback_evolution_log_truncation.
  //
  // The append-only restriction applies only when NOT on a jarvis/* dev branch —
  // those branches allow ALL mission-control writes (isMissionControlWriteAllowed
  // short-circuits before the gate). Commits/CI run on main, where the gate is
  // active; skip the block-assertions on a dev branch so the suite stays green
  // regardless of the checked-out branch.
  function onJarvisBranch(): boolean {
    try {
      const b = execFileSync("git", ["branch", "--show-current"], {
        cwd: "/root/claude/mission-control",
        encoding: "utf-8",
        timeout: 5000,
      }).trim();
      return /^jarvis\/(feat|fix|refactor)\/.+$/.test(b);
    } catch {
      return false;
    }
  }
  const itOnMain = onJarvisBranch() ? it.skip : it;
  const LOG = "/root/claude/mission-control/docs/EVOLUTION-LOG.md";

  it("ALLOWS an append redirect (`>>`) to the ritual log", () => {
    expect(validateShellCommand(`echo "x" >> ${LOG}`)).toEqual({
      allowed: true,
    });
  });

  it("ALLOWS a heredoc append (`cat >> log << 'ENTRY'`) to the ritual log", () => {
    const cmd = `cat >> ${LOG} << 'ENTRY'\n## 2026-06-18\nbody\nENTRY`;
    expect(validateShellCommand(cmd)).toEqual({ allowed: true });
  });

  itOnMain("BLOCKS a bare `>` overwrite of the ritual log (truncation)", () => {
    const result = validateShellCommand(`echo "x" > ${LOG}`);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("append-only");
  });

  itOnMain("BLOCKS `printf >` overwrite of the ritual log", () => {
    const result = validateShellCommand(`printf 'x' > ${LOG}`);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("append-only");
  });

  itOnMain("BLOCKS `: >` truncate-to-empty of the ritual log", () => {
    const result = validateShellCommand(`: > ${LOG}`);
    expect(result.allowed).toBe(false);
  });

  itOnMain("BLOCKS `tee` (overwrite, no -a) of the ritual log", () => {
    const result = validateShellCommand(`echo x | tee ${LOG}`);
    expect(result.allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unscoped test-run guard (2026-07-12 vitest-saturation incident)
// ---------------------------------------------------------------------------

describe("checkUnscopedTestRun — the shell-tool mirror of vitest-scope-guard", () => {
  it("blocks bare vitest runs, including the incident's exact commands", () => {
    expect(checkUnscopedTestRun("npx vitest run")).toMatch(/unscoped/);
    expect(checkUnscopedTestRun("vitest run")).toMatch(/unscoped/);
    expect(
      checkUnscopedTestRun("timeout 90 npx vitest run --reporter=verbose 2>&1"),
    ).toMatch(/unscoped/);
    expect(checkUnscopedTestRun("npm test")).toMatch(/FULL vitest suite/);
    expect(checkUnscopedTestRun("npm run test")).toMatch(/FULL vitest suite/);
  });

  it("allows scoped runs", () => {
    expect(
      checkUnscopedTestRun("npx vitest run src/lib/deliverable.test.ts"),
    ).toBeNull();
    expect(checkUnscopedTestRun("npx vitest run --changed")).toBeNull();
    expect(checkUnscopedTestRun('npx vitest run -t "extractor"')).toBeNull();
    expect(
      checkUnscopedTestRun("vitest related src/db/drive-sync.ts"),
    ).toBeNull();
  });

  // Audit W2 fold (2026-07-12): a slash inside a FLAG is not a scope.
  it("blocks slash-bearing flags that don't scope the run", () => {
    expect(
      checkUnscopedTestRun("npx vitest run --config ./vitest.config.ts"),
    ).toMatch(/unscoped/);
    expect(
      checkUnscopedTestRun(
        "npx vitest run --reporter=json --outputFile=./out.json",
      ),
    ).toMatch(/unscoped/);
  });

  it("still allows a real positional path next to flags", () => {
    expect(
      checkUnscopedTestRun(
        "npx vitest run --reporter=dot src/lib/deliverable.test.ts",
      ),
    ).toBeNull();
  });

  it("does not false-positive on non-invocations", () => {
    expect(checkUnscopedTestRun("cat vitest.config.ts")).toBeNull();
    expect(checkUnscopedTestRun("grep vitest package.json")).toBeNull();
    expect(checkUnscopedTestRun("npm run test-health-report")).toBeNull();
  });

  it("is wired into validateShellCommand per segment", () => {
    const blocked = validateShellCommand(
      "timeout 90 npx vitest run 2>&1",
    );
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toMatch(/unscoped/);

    const ok = validateShellCommand(
      "cd /root/claude/mission-control && npx vitest run src/db/drive-sync.test.ts",
    );
    expect(ok.allowed).toBe(true);
  });
});

describe("execGroupKill — timeout reaps the whole process group", () => {
  it("kills backgrounded grandchildren on timeout (no orphan survives)", async () => {
    const marker = `orphan-probe-${Date.now()}`;
    const result = JSON.parse(
      await shellTool.execute({
        // A grandchild that would outlive a naive parent-only kill.
        command: `sh -c "sleep 30 #${marker}" & echo started; sleep 30`,
        timeout_ms: 1000,
      }),
    ) as { exit_code: number; stderr: string };

    expect(result.exit_code).toBe(-2); // timeout signature
    expect(result.stderr).toMatch(/timed out/);

    // Give the SIGKILL a beat, then assert no survivor from our group.
    await new Promise((r) => setTimeout(r, 300));
    const { execSync } = await import("node:child_process");
    // Bracket trick: the checker's own cmdline contains "orphan[-]probe",
    // which the regex does not match — only the true survivor would.
    const bracketed = marker.replace("orphan-probe", "orphan[-]probe");
    const survivors = execSync(`pgrep -f "${bracketed}" | wc -l`, {
      encoding: "utf-8",
    }).trim();
    expect(Number(survivors)).toBe(0);
  }, 15_000);
});

// ---------------------------------------------------------------------------
// P1 (2026-07-12): mutating git on the shared primary mc checkout is blocked
// ---------------------------------------------------------------------------

describe("checkPrimaryMcGitMutation — shared-worktree protection", () => {
  it("blocks mutating git with no cd (default cwd IS the primary)", () => {
    expect(validateShellCommand("git add src/foo.ts").allowed).toBe(false);
    expect(validateShellCommand("git checkout -b jarvis/feat/x").allowed).toBe(
      false,
    );
    expect(validateShellCommand("git stash").allowed).toBe(false);
  });

  it("blocks mutating git explicitly targeting the primary", () => {
    expect(
      validateShellCommand(
        "git commit -m x src/a.ts",
      ).allowed,
    ).toBe(false);
    expect(
      validateShellCommand(
        "git -C /root/claude/mission-control reset --hard HEAD",
      ).allowed,
    ).toBe(false);
  });

  it("allows worktree-state git (checkout/stash/reset) in the jarvis worktree and other repos", () => {
    // push/commit/add stay blanket-blocked by the pre-existing DENY pattern
    // (git_commit/git_push tools are the sanctioned path); this guard governs
    // the worktree-STATE gap: checkout/switch/reset/stash/etc.
    expect(
      validateShellCommand(
        "cd /root/claude/mission-control-jarvis && git checkout jarvis/feat/x",
      ).allowed,
    ).toBe(true);
    expect(
      validateShellCommand("cd /root/claude/vlved && git stash").allowed,
    ).toBe(true);
    expect(
      validateShellCommand(
        "git -C /root/claude/mission-control-jarvis reset --hard HEAD",
      ).allowed,
    ).toBe(true);
  });

  it("allows read-only git anywhere, including the primary", () => {
    expect(validateShellCommand("git status --short").allowed).toBe(true);
    expect(validateShellCommand("git log --oneline -5").allowed).toBe(true);
    expect(
      validateShellCommand(
        "cd /root/claude/mission-control && git diff HEAD~1",
      ).allowed,
    ).toBe(true);
    expect(validateShellCommand("git branch --show-current").allowed).toBe(
      true,
    );
  });
});
