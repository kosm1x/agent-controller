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
      "echo hello > /root/claude/test.txt",
      "echo hello > /tmp/test.txt",
      "cp /root/claude/a.txt /root/claude/b.txt",
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

  describe("write path enforcement", () => {
    it("should block writes outside allowed paths", () => {
      const result = validateShellCommand("echo x > /var/log/test.log");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("outside allowed paths");
    });

    it("should allow writes to /root/claude/", () => {
      expect(validateShellCommand("echo x > /root/claude/test.txt")).toEqual({
        allowed: true,
      });
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

    it("should allow cp within project", () => {
      expect(
        validateShellCommand("cp /root/claude/a.ts /root/claude/b.ts"),
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
});
