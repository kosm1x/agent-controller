import { describe, it, expect } from "vitest";
import {
  isImmutableCorePath,
  validatePathSafety,
  isDangerousRemovalPath,
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

    it("allows reading from dangerous directories", () => {
      const result = validatePathSafety("/root/.ssh/authorized_keys", "read");
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
