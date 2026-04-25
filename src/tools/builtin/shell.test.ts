/**
 * Shell command validation tests.
 */

import { describe, it, expect } from "vitest";
import { validateShellCommand } from "./shell.js";

describe("validateShellCommand", () => {
  describe("allowed commands", () => {
    const allowed = [
      "ls /root",
      "node --version",
      "npm test",
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
  });

  describe("git command blocking", () => {
    it("blocks git push", () => {
      const result = validateShellCommand("git push -u origin main");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("git operations blocked");
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
      expect(result.reason).toContain("git operations blocked");
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
      expect(result.reason).toContain("git operations blocked");
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
      const r = validateShellCommand("cat .env 2>/dev/null");
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
        'cat .env 2>/dev/null || ls *.env || echo "no env"',
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

    it("still blocks writes to siblings outside allowed prefixes", () => {
      const r = validateShellCommand(
        "echo bad > /root/claude/some-other-repo/file.txt",
      );
      expect(r.allowed).toBe(false);
    });
  });
});
