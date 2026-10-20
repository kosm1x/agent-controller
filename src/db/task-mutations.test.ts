import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  classifyMutation,
  getMutations,
  recordMutationFromResult,
} from "./task-mutations.js";
import { closeDatabase, initDatabase } from "./index.js";

describe("classifyMutation", () => {
  describe("filesystem tools", () => {
    it("classifies file_write as modify (may be create or overwrite)", () => {
      const result = classifyMutation("file_write", {
        path: "/tmp/test.txt",
      });
      expect(result).toEqual({
        operation: "modify",
        filePath: "/tmp/test.txt",
      });
    });

    it("classifies file_write with file_path alias", () => {
      const result = classifyMutation("file_write", {
        file_path: "/tmp/test.txt",
      });
      expect(result).toEqual({
        operation: "modify",
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

// Queue 4t: the shared "record if the call succeeded" helper used by both the
// task executor and the Claude SDK tool bridge.
describe("recordMutationFromResult", () => {
  beforeAll(() => {
    initDatabase(":memory:");
  });
  afterAll(() => {
    closeDatabase();
  });

  it("records a row for a successful file_write", () => {
    recordMutationFromResult(
      "t-ok",
      "file_write",
      { path: "/tmp/a.txt" },
      JSON.stringify({ ok: true, bytes: 3 }),
    );
    const rows = getMutations("t-ok");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tool_name: "file_write",
      operation: "modify",
      file_path: "/tmp/a.txt",
    });
  });

  it("records a row for a non-JSON success result", () => {
    recordMutationFromResult("t-plain", "file_edit", { path: "/tmp/b" }, "ok");
    expect(getMutations("t-plain")).toHaveLength(1);
  });

  it('records nothing for an {"error": …} result', () => {
    recordMutationFromResult(
      "t-err-json",
      "file_write",
      { path: "/tmp/a.txt" },
      JSON.stringify({ error: "x" }),
    );
    expect(getMutations("t-err-json")).toEqual([]);
  });

  it("records nothing for a success === false envelope", () => {
    recordMutationFromResult(
      "t-success-false",
      "file_write",
      { path: "/tmp/a.txt" },
      JSON.stringify({ success: false }),
    );
    expect(getMutations("t-success-false")).toEqual([]);
  });

  it("records nothing for an Error: result", () => {
    recordMutationFromResult(
      "t-err-text",
      "file_write",
      { path: "/tmp/a.txt" },
      "Error: disk full",
    );
    expect(getMutations("t-err-text")).toEqual([]);
  });

  it("records nothing for a non-mutating tool", () => {
    recordMutationFromResult(
      "t-read",
      "file_read",
      { path: "/tmp/a.txt" },
      JSON.stringify({ content: "x" }),
    );
    expect(getMutations("t-read")).toEqual([]);
  });
});
