import { describe, it, expect } from "vitest";
import { classifyMutation } from "./task-mutations.js";

describe("classifyMutation", () => {
  describe("filesystem tools", () => {
    it("classifies file_write as create", () => {
      const result = classifyMutation("file_write", {
        path: "/tmp/test.txt",
      });
      expect(result).toEqual({
        operation: "create",
        filePath: "/tmp/test.txt",
      });
    });

    it("classifies file_write with file_path alias", () => {
      const result = classifyMutation("file_write", {
        file_path: "/tmp/test.txt",
      });
      expect(result).toEqual({
        operation: "create",
        filePath: "/tmp/test.txt",
      });
    });

    it("classifies file_edit as modify", () => {
      const result = classifyMutation("file_edit", {
        path: "/root/claude/mission-control/src/foo.ts",
      });
      expect(result).toEqual({
        operation: "modify",
        filePath: "/root/claude/mission-control/src/foo.ts",
      });
    });

    it("classifies file_delete as delete", () => {
      const result = classifyMutation("file_delete", {
        path: "/tmp/old.txt",
      });
      expect(result).toEqual({
        operation: "delete",
        filePath: "/tmp/old.txt",
      });
    });

    it("returns null for file_write without path", () => {
      expect(classifyMutation("file_write", {})).toBeNull();
    });
  });

  describe("jarvis KB tools", () => {
    it("classifies jarvis_file_write as create with jarvis:// prefix", () => {
      const result = classifyMutation("jarvis_file_write", {
        path: "projects/test/README.md",
      });
      expect(result).toEqual({
        operation: "create",
        filePath: "jarvis://projects/test/README.md",
      });
    });

    it("classifies jarvis_file_update as modify", () => {
      const result = classifyMutation("jarvis_file_update", {
        path: "knowledge/domain/test.md",
      });
      expect(result).toEqual({
        operation: "modify",
        filePath: "jarvis://knowledge/domain/test.md",
      });
    });

    it("classifies jarvis_file_delete as delete", () => {
      const result = classifyMutation("jarvis_file_delete", {
        path: "workspace/old-report.md",
      });
      expect(result).toEqual({
        operation: "delete",
        filePath: "jarvis://workspace/old-report.md",
      });
    });
  });

  describe("git tools", () => {
    it("classifies git_commit as modify with file list", () => {
      const result = classifyMutation("git_commit", {
        files: ["src/foo.ts", "src/bar.ts"],
        message: "fix bug",
      });
      expect(result).toEqual({
        operation: "modify",
        filePath: "git:src/foo.ts,src/bar.ts",
      });
    });

    it("classifies git_push as modify", () => {
      const result = classifyMutation("git_push", {});
      expect(result).toEqual({
        operation: "modify",
        filePath: "git:push",
      });
    });

    it("returns null for git_commit without files", () => {
      expect(classifyMutation("git_commit", { message: "empty" })).toBeNull();
    });
  });

  describe("non-mutating tools", () => {
    it("returns null for file_read", () => {
      expect(
        classifyMutation("file_read", { path: "/tmp/test.txt" }),
      ).toBeNull();
    });

    it("returns null for web_search", () => {
      expect(classifyMutation("web_search", { query: "test" })).toBeNull();
    });

    it("returns null for shell_exec", () => {
      expect(classifyMutation("shell_exec", { command: "ls" })).toBeNull();
    });

    it("returns null for unknown tools", () => {
      expect(classifyMutation("unknown_tool", { foo: "bar" })).toBeNull();
    });
  });
});
