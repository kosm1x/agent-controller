import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  isImmutableCorePath,
  validatePathSafety,
  isDangerousRemovalPath,
  isPreciousPath,
} from "./immutable-core.js";

const MC = "/root/claude/mission-control/";

describe("isImmutableCorePath", () => {
  describe("immutable files", () => {
    const immutableFiles = [
      "src/index.ts",
      "src/config.ts",
      "src/inference/adapter.ts",
      "src/dispatch/dispatcher.ts",
      "src/dispatch/classifier.ts",
      "src/runners/fast-runner.ts",
      "src/messaging/router.ts",
      "src/db/index.ts",
      "src/db/jarvis-fs.ts",
      "src/rituals/scheduler.ts",
      "src/rituals/autonomous-improvement.ts",
      "src/tools/builtin/immutable-core.ts",
      "src/tools/builtin/file.ts",
      "src/tools/builtin/code-editing.ts",
      "src/tools/builtin/shell.ts",
    ];

    for (const file of immutableFiles) {
      it(`blocks ${file}`, () => {
        const result = isImmutableCorePath(`${MC}${file}`);
        expect(result.immutable).toBe(true);
        expect(result.reason).toContain(file);
      });
    }
  });

  describe("immutable directories", () => {
    it("blocks src/api/index.ts", () => {
      const result = isImmutableCorePath(`${MC}src/api/index.ts`);
      expect(result.immutable).toBe(true);
      expect(result.reason).toContain("src/api/");
    });

    it("blocks the package-manager shim directory (dependency trust audit 2026-09-16)", () => {
      const result = isImmutableCorePath(`${MC}src/tools/builtin/pm-shim/pm-shim.sh`);
      expect(result.immutable).toBe(true);
      expect(result.reason).toContain("src/tools/builtin/pm-shim/");
    });

    it("blocks src/api/routes/health.ts", () => {
      const result = isImmutableCorePath(`${MC}src/api/routes/health.ts`);
      expect(result.immutable).toBe(true);
    });

    it("blocks src/api/routes/admin.ts", () => {
      const result = isImmutableCorePath(`${MC}src/api/routes/admin.ts`);
      expect(result.immutable).toBe(true);
    });
  });

  describe("newly immutable guard files", () => {
    it("blocks src/tools/builtin/shell.ts", () => {
      expect(
        isImmutableCorePath(`${MC}src/tools/builtin/shell.ts`).immutable,
      ).toBe(true);
    });

    it("blocks src/tools/builtin/file.ts", () => {
      expect(
        isImmutableCorePath(`${MC}src/tools/builtin/file.ts`).immutable,
      ).toBe(true);
    });

    it("blocks src/dispatch/classifier.ts", () => {
      expect(
        isImmutableCorePath(`${MC}src/dispatch/classifier.ts`).immutable,
      ).toBe(true);
    });

    it("blocks src/rituals/autonomous-improvement.ts", () => {
      expect(
        isImmutableCorePath(`${MC}src/rituals/autonomous-improvement.ts`)
          .immutable,
      ).toBe(true);
    });
  });

  describe("allowed paths", () => {
    it("allows src/messaging/scope.ts", () => {
      expect(isImmutableCorePath(`${MC}src/messaging/scope.ts`).immutable).toBe(
        false,
      );
    });

    it("allows src/intel/adapters/weather.ts", () => {
      expect(
        isImmutableCorePath(`${MC}src/intel/adapters/weather.ts`).immutable,
      ).toBe(false);
    });

    it("allows src/video/composer.ts", () => {
      expect(isImmutableCorePath(`${MC}src/video/composer.ts`).immutable).toBe(
        false,
      );
    });
  });

  describe("non-mission-control paths", () => {
    it("allows /root/claude/jarvis-kb/directives/core.md", () => {
      expect(
        isImmutableCorePath("/root/claude/jarvis-kb/directives/core.md")
          .immutable,
      ).toBe(false);
    });

    it("allows /tmp/test.ts", () => {
      expect(isImmutableCorePath("/tmp/test.ts").immutable).toBe(false);
    });

    it("allows empty string", () => {
      expect(isImmutableCorePath("").immutable).toBe(false);
    });
  });

  describe("path resolution", () => {
    it("resolves relative paths with ../ traversal", () => {
      const result = isImmutableCorePath(
        "/root/claude/mission-control/src/tools/../index.ts",
      );
      expect(result.immutable).toBe(true);
    });

    it("resolves paths with trailing components", () => {
      const result = isImmutableCorePath(
        "/root/claude/mission-control/src/./config.ts",
      );
      expect(result.immutable).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// validatePathSafety
// ---------------------------------------------------------------------------

describe("validatePathSafety", () => {
  describe("empty/invalid paths", () => {
    it("rejects empty string", () => {
      expect(validatePathSafety("", "write").safe).toBe(false);
    });

    it("rejects whitespace-only", () => {
      expect(validatePathSafety("   ", "write").safe).toBe(false);
    });
  });

  describe("quote stripping", () => {
    it("strips single quotes and validates inner path", () => {
      const result = validatePathSafety("'/tmp/test.txt'", "write");
      expect(result.safe).toBe(true);
    });

    it("strips double quotes", () => {
      const result = validatePathSafety('"/tmp/test.txt"', "write");
      expect(result.safe).toBe(true);
    });

    it("blocks dangerous file even inside quotes", () => {
      const result = validatePathSafety("'/root/.bashrc'", "write");
      expect(result.safe).toBe(false);
      expect(result.reason).toContain(".bashrc");
    });
  });

  describe("UNC path blocking", () => {
    it("blocks backslash UNC paths", () => {
      const result = validatePathSafety("\\\\server\\share\\file", "read");
      expect(result.safe).toBe(false);
      expect(result.reason).toContain("UNC");
    });

    it("blocks forward-slash UNC paths", () => {
      const result = validatePathSafety("//server/share/file", "read");
      expect(result.safe).toBe(false);
    });
  });

  describe("tilde expansion", () => {
    it("allows ~/ (expands to HOME)", () => {
      const result = validatePathSafety("~/documents/file.txt", "write");
      expect(result.safe).toBe(true);
    });

    it("blocks ~user variants", () => {
      const result = validatePathSafety("~root/file.txt", "write");
      expect(result.safe).toBe(false);
      expect(result.reason).toContain("Tilde");
    });

    it("blocks ~+ (bash pwd)", () => {
      const result = validatePathSafety("~+/file.txt", "write");
      expect(result.safe).toBe(false);
    });

    it("blocks ~- (bash oldpwd)", () => {
      const result = validatePathSafety("~-/file.txt", "write");
      expect(result.safe).toBe(false);
    });
  });

  describe("shell expansion blocking (TOCTOU)", () => {
    it("blocks $VAR", () => {
      const result = validatePathSafety("/tmp/$HOME/file", "write");
      expect(result.safe).toBe(false);
      expect(result.reason).toContain("$");
    });

    it("blocks ${var}", () => {
      const result = validatePathSafety("/tmp/${USER}/file", "write");
      expect(result.safe).toBe(false);
    });

    it("blocks $(cmd)", () => {
      const result = validatePathSafety("/tmp/$(whoami)/file", "write");
      expect(result.safe).toBe(false);
    });

    it("blocks = (zsh equals expansion)", () => {
      const result = validatePathSafety("=ls", "write");
      expect(result.safe).toBe(false);
      expect(result.reason).toContain("Zsh");
    });
  });

  describe("glob blocking for write/delete", () => {
    it("blocks * in write paths", () => {
      const result = validatePathSafety("/tmp/*.txt", "write");
      expect(result.safe).toBe(false);
      expect(result.reason).toContain("Glob");
    });

    it("blocks ? in delete paths", () => {
      const result = validatePathSafety("/tmp/file?.txt", "delete");
      expect(result.safe).toBe(false);
    });

    it("blocks [] in write paths", () => {
      const result = validatePathSafety("/tmp/file[0].txt", "write");
      expect(result.safe).toBe(false);
    });

    it("blocks {} in write paths", () => {
      const result = validatePathSafety("/tmp/{a,b}.txt", "write");
      expect(result.safe).toBe(false);
    });

    it("allows * in read paths", () => {
      const result = validatePathSafety("/tmp/*.txt", "read");
      expect(result.safe).toBe(true);
    });

    it("allows ? in read paths", () => {
      const result = validatePathSafety("/tmp/file?.txt", "read");
      expect(result.safe).toBe(true);
    });
  });

  describe("dangerous files (exact match)", () => {
    const dangerousFiles = [
      ".gitconfig",
      ".gitmodules",
      ".bashrc",
      ".bash_profile",
      ".zshrc",
      ".zprofile",
      ".profile",
      ".npmrc",
      ".netrc",
    ];

    for (const file of dangerousFiles) {
      it(`blocks write to ${file}`, () => {
        const result = validatePathSafety(`/root/${file}`, "write");
        expect(result.safe).toBe(false);
        expect(result.reason).toContain("sensitive dotfile");
      });
    }

    it("allows reading dangerous files", () => {
      const result = validatePathSafety("/root/.bashrc", "read");
      expect(result.safe).toBe(true);
    });
  });

  describe("dangerous files (prefix match — .env.*)", () => {
    const envVariants = [
      ".env",
      ".env.local",
      ".env.production",
      ".env.development",
      ".env.staging",
      ".env.test",
      ".env.anything",
    ];

    for (const file of envVariants) {
      it(`blocks write to ${file}`, () => {
        const result = validatePathSafety(`/root/project/${file}`, "write");
        expect(result.safe).toBe(false);
        expect(result.reason).toContain("sensitive dotfile");
      });
    }
  });

  describe(".env files are read-blocked by SHAPE, allow-by-membership (security audit SEC-03)", () => {
    for (const p of [
      "/root/claude/mission-control/.env",
      "/root/claude/mission-control/.env.bak-20260520-200844",
      "/root/claude/Pulso-Aura-Upfront/.env",
      "/root/claude/trustr/.env",
      "/root/claude/eurekams-intelligence-ui/server/.env.longevidad",
      "/root/claude/mission-control/.env-prod",
      "/root/claude/mission-control/.env.secrets.json",
    ]) {
      it(`blocks read of ${p}`, () => {
        const r = validatePathSafety(p, "read");
        expect(r.safe).toBe(false);
        expect(r.reason).toMatch(/secrets file|read-blocked secret file/);
      });
    }
    it("allows the documented DENUE .env and template files", () => {
      expect(
        validatePathSafety(
          "/root/claude/projects/data-intelligence/denue-data-analysis/.env",
          "read",
        ).safe,
      ).toBe(true);
      expect(validatePathSafety("/root/claude/vlved/.env.example", "read").safe).toBe(true);
      expect(validatePathSafety("/root/claude/vlved/.environment", "read").safe).toBe(true);
    });
  });

  describe("dangerous directories", () => {
    it("blocks write to .git/", () => {
      const result = validatePathSafety("/root/project/.git/config", "write");
      expect(result.safe).toBe(false);
      expect(result.reason).toContain(".git/");
    });

    it("blocks write to .ssh/", () => {
      const result = validatePathSafety("/root/.ssh/authorized_keys", "write");
      expect(result.safe).toBe(false);
      expect(result.reason).toContain(".ssh/");
    });

    it("blocks write to .gnupg/", () => {
      const result = validatePathSafety("/root/.gnupg/pubring.kbx", "write");
      expect(result.safe).toBe(false);
      expect(result.reason).toContain(".gnupg/");
    });

    it("blocks reading from secret directories (Sec2 round-1 fix)", () => {
      // Reads of /root/.ssh/ are now blocked even in read mode — the
      // pre-audit behavior (reads permissive) was the vulnerability.
      const result = validatePathSafety("/root/.ssh/authorized_keys", "read");
      expect(result.safe).toBe(false);
      expect(result.reason).toContain(".ssh");
    });

    it("blocks reading credentials.json by basename (Sec2 round-1 fix)", () => {
      const result = validatePathSafety(
        "/root/.claude/.credentials.json",
        "read",
      );
      expect(result.safe).toBe(false);
    });

    it("blocks reading id_rsa regardless of directory (Sec2 round-1 fix)", () => {
      const result = validatePathSafety("/tmp/scratch/id_rsa", "read");
      expect(result.safe).toBe(false);
      expect(result.reason).toContain("id_rsa");
    });

    it("blocks every spelling of a process env/mem file (audit 2026-09-22)", () => {
      for (const p of [
        "/proc/self/environ",
        "/proc/thread-self/environ",
        "/proc/1/environ",
        "/proc/self/task/1/environ",
        "/proc/2829385/mem",
        "/proc/12/task/34/cmdline",
      ]) {
        expect(validatePathSafety(p, "read").safe, p).toBe(false);
      }
      // A process's other state stays readable (status, stat, …).
      expect(validatePathSafety("/proc/self/status", "read").safe).toBe(true);
      expect(validatePathSafety("/proc/meminfo", "read").safe).toBe(true);
    });

    it("blocks the co-located credential files (audit 2026-09-22)", () => {
      for (const p of [
        "/etc/opensandbox/api.env",
        "/root/.claude.json",
        "/root/.docker/config.json",
        "/etc/shadow-",
        "/etc/gshadow-",
      ]) {
        expect(validatePathSafety(p, "read").safe, p).toBe(false);
      }
      expect(validatePathSafety("/root/.claude.json.bak", "read").safe).toBe(
        true,
      );
    });

    it("checks the RAW spelling's symlink target, not only the trimmed one (R3)", () => {
      const dir = mkdtempSync(join(tmpdir(), "vps-raw-"));
      try {
        const raw = join(dir, "lnk ");
        symlinkSync("/etc/shadow", raw);
        expect(validatePathSafety(raw, "read").safe).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("write/delete resolve a symlinked parent or target (audit 2026-09-22)", () => {
      const dir = mkdtempSync(join(tmpdir(), "vps-wd-"));
      try {
        mkdirSync(join(dir, "repo", ".git"), { recursive: true });
        symlinkSync(join(dir, "repo", ".git"), join(dir, "lnk"));
        symlinkSync(join(dir, "repo", ".bashrc"), join(dir, "rc"));
        const viaDir = join(dir, "lnk", "config");
        expect(validatePathSafety(viaDir, "write").safe).toBe(false);
        expect(validatePathSafety(viaDir, "delete").safe).toBe(false);
        // A write follows a final symlink; unlink removes the link itself.
        expect(validatePathSafety(join(dir, "rc"), "write").safe).toBe(false);
        expect(validatePathSafety(join(dir, "rc"), "delete").safe).toBe(true);
        expect(validatePathSafety(join(dir, "plain.txt"), "write").safe).toBe(
          true,
        );
        // R2 C2: `..` after a directory symlink steps up from its target.
        mkdirSync(join(dir, "repo", ".git", "sub"));
        symlinkSync(join(dir, "repo", ".git", "sub"), join(dir, "sub"));
        const up = join(dir, "sub") + "/../config";
        expect(validatePathSafety(up, "write").safe).toBe(false);
        expect(validatePathSafety(up, "delete").safe).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("does not block /root/.ssh-backup/ via prefix bug (poka-yoke)", () => {
      // /root/.ssh is a prefix of /root/.ssh-backup; the trailing slash on
      // the blocklist entry prevents the false-positive that would
      // accidentally block a legitimate sibling directory.
      const result = validatePathSafety("/root/.ssh-backup/notes.txt", "read");
      expect(result.safe).toBe(true);
    });
  });

  describe("safe paths pass all checks", () => {
    it("allows normal absolute path write", () => {
      expect(validatePathSafety("/tmp/output.txt", "write").safe).toBe(true);
    });

    it("allows normal project path write", () => {
      expect(
        validatePathSafety("/root/claude/mission-control/src/foo.ts", "write")
          .safe,
      ).toBe(true);
    });

    it("allows deep nested path", () => {
      expect(
        validatePathSafety("/root/project/src/a/b/c/file.ts", "write").safe,
      ).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// isDangerousRemovalPath
// ---------------------------------------------------------------------------

describe("isDangerousRemovalPath", () => {
  it("blocks root /", () => {
    const result = isDangerousRemovalPath("/");
    expect(result.dangerous).toBe(true);
    expect(result.reason).toContain("root");
  });

  it("blocks home directory", () => {
    const result = isDangerousRemovalPath(process.env.HOME ?? "/root");
    expect(result.dangerous).toBe(true);
    expect(result.reason).toContain("home");
  });

  it("blocks wildcard *", () => {
    const result = isDangerousRemovalPath("/tmp/*");
    expect(result.dangerous).toBe(true);
    expect(result.reason).toContain("Wildcard");
  });

  it("blocks wildcard ?", () => {
    const result = isDangerousRemovalPath("/tmp/file?");
    expect(result.dangerous).toBe(true);
  });

  describe("top-level directories", () => {
    const topLevelDirs = ["/usr", "/tmp", "/var", "/etc", "/opt", "/srv"];

    for (const dir of topLevelDirs) {
      it(`blocks deletion of ${dir}`, () => {
        const result = isDangerousRemovalPath(dir);
        expect(result.dangerous).toBe(true);
        expect(result.reason).toContain("top-level");
      });
    }
  });

  describe("safe deletion paths", () => {
    it("allows /tmp/myfile.txt", () => {
      expect(isDangerousRemovalPath("/tmp/myfile.txt").dangerous).toBe(false);
    });

    it("allows /root/claude/output/test.mp4", () => {
      expect(
        isDangerousRemovalPath("/root/claude/output/test.mp4").dangerous,
      ).toBe(false);
    });

    it("allows nested path under /var", () => {
      expect(isDangerousRemovalPath("/var/log/old/file.log").dangerous).toBe(
        false,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// isPreciousPath (v6.2 S5)
// ---------------------------------------------------------------------------

describe("isPreciousPath", () => {
  describe("precious Jarvis KB prefixes", () => {
    const preciousPaths = [
      "knowledge/domain/test.md",
      "knowledge/people/fede.md",
      "projects/agent-controller/status.md",
      "projects/crm-azteca/README.md",
      "NorthStar/goals/q2-2026.md",
      "NorthStar/visions/core.md",
      "directives/core.md",
      "directives/no-delete.md",
    ];

    for (const path of preciousPaths) {
      it(`flags ${path} as precious`, () => {
        const result = isPreciousPath(path);
        expect(result.precious).toBe(true);
        expect(result.reason).toBeTruthy();
      });
    }
  });

  describe("non-precious paths", () => {
    const safePaths = [
      "workspace/temp-report.md",
      "logs/sessions/2026-04-06.md",
      "extracted/2026-04-06-abc.md",
      "lessons/2026-04-06-def.md",
      "INDEX.md",
      "inbox/new-item.md",
    ];

    for (const path of safePaths) {
      it(`allows ${path} without confirmation`, () => {
        expect(isPreciousPath(path).precious).toBe(false);
      });
    }
  });
});

// Audit R1-C3 (2026-09-01): the disk-side twin of standingOrdersGuard used by
// file_write / code_edit so an editor write cannot reach jarvis-kb/directives/.
describe("isStandingOrdersDiskPath", () => {
  const root = "/srv/kb";

  it("refuses every spelling that resolves under <kbRoot>/directives/", async () => {
    const { isStandingOrdersDiskPath } = await import("./immutable-core.js");
    for (const p of [
      "/srv/kb/directives/core.md",
      "/srv/kb/knowledge/../directives/core.md",
      "/srv/kb/Directives/core.md",
      "/srv/kb//directives/./core.md",
      "/srv/kb/directives", // the directory itself — rmSync would take the tree (R2-C2)
      "/srv/kb/knowledge/../directives",
    ]) {
      expect(isStandingOrdersDiskPath(p, root), p).toBe(true);
    }
  });

  it("lets neighbours and escapes through (they are judged by the other guards)", async () => {
    const { isStandingOrdersDiskPath } = await import("./immutable-core.js");
    for (const p of [
      "/srv/kb/knowledge/directives-history.md",
      "/srv/kb/directive-notes/x.md",
      "/srv/kb-other/directives/core.md",
      "/srv/kb/../kb2/directives/core.md",
      "/tmp/directives/core.md",
    ]) {
      expect(isStandingOrdersDiskPath(p, root), p).toBe(false);
    }
  });

  it("tolerates a kbRoot with a trailing slash or relative segments", async () => {
    const { isStandingOrdersDiskPath } = await import("./immutable-core.js");
    expect(isStandingOrdersDiskPath("/srv/kb/directives/x.md", "/srv/kb/")).toBe(true);
    expect(isStandingOrdersDiskPath("/srv/kb/directives/x.md", "/srv/other/../kb")).toBe(true);
  });
});
