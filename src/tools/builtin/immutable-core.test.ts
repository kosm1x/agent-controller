import { describe, it, expect } from "vitest";
import { isImmutableCorePath } from "./immutable-core.js";

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
