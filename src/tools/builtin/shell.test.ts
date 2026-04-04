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
    });
  });
});
