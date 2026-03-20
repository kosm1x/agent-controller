/**
 * Tests for file_edit tool.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, readFileSync, mkdirSync, rmSync } from "fs";
import { fileEditTool } from "./code-editing.js";

const TEST_DIR = "/tmp/mc-test-code-editing";

describe("file_edit", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("should replace a unique string", async () => {
    const path = `${TEST_DIR}/test.ts`;
    writeFileSync(path, 'const x = "hello";\nconst y = "world";\n');

    const result = JSON.parse(
      await fileEditTool.execute({
        path,
        old_string: '"hello"',
        new_string: '"goodbye"',
      }),
    );

    expect(result.replacements).toBe(1);
    expect(readFileSync(path, "utf-8")).toBe(
      'const x = "goodbye";\nconst y = "world";\n',
    );
  });

  it("should error when old_string not found", async () => {
    const path = `${TEST_DIR}/test.ts`;
    writeFileSync(path, "const x = 1;\n");

    const result = JSON.parse(
      await fileEditTool.execute({
        path,
        old_string: "not in file",
        new_string: "replacement",
      }),
    );

    expect(result.error).toContain("not found");
  });

  it("should error when old_string has multiple matches without replace_all", async () => {
    const path = `${TEST_DIR}/test.ts`;
    writeFileSync(path, "foo\nbar\nfoo\n");

    const result = JSON.parse(
      await fileEditTool.execute({
        path,
        old_string: "foo",
        new_string: "baz",
      }),
    );

    expect(result.error).toContain("2 times");
    expect(result.occurrences).toBe(2);
  });

  it("should replace all occurrences when replace_all is true", async () => {
    const path = `${TEST_DIR}/test.ts`;
    writeFileSync(path, "foo\nbar\nfoo\n");

    const result = JSON.parse(
      await fileEditTool.execute({
        path,
        old_string: "foo",
        new_string: "baz",
        replace_all: true,
      }),
    );

    expect(result.replacements).toBe(2);
    expect(readFileSync(path, "utf-8")).toBe("baz\nbar\nbaz\n");
  });

  it("should error when file does not exist", async () => {
    const result = JSON.parse(
      await fileEditTool.execute({
        path: `${TEST_DIR}/nonexistent.ts`,
        old_string: "x",
        new_string: "y",
      }),
    );

    expect(result.error).toContain("not found");
  });

  it("should error when old_string equals new_string", async () => {
    const path = `${TEST_DIR}/test.ts`;
    writeFileSync(path, "hello\n");

    const result = JSON.parse(
      await fileEditTool.execute({
        path,
        old_string: "hello",
        new_string: "hello",
      }),
    );

    expect(result.error).toContain("identical");
  });

  it("should handle deletion (empty new_string)", async () => {
    const path = `${TEST_DIR}/test.ts`;
    writeFileSync(path, "line1\nline2\nline3\n");

    const result = JSON.parse(
      await fileEditTool.execute({
        path,
        old_string: "line2\n",
        new_string: "",
      }),
    );

    expect(result.replacements).toBe(1);
    expect(readFileSync(path, "utf-8")).toBe("line1\nline3\n");
  });

  it("should preserve whitespace exactly", async () => {
    const path = `${TEST_DIR}/test.ts`;
    writeFileSync(path, "  if (true) {\n    console.log('yes');\n  }\n");

    const result = JSON.parse(
      await fileEditTool.execute({
        path,
        old_string: "    console.log('yes');",
        new_string: "    console.log('no');",
      }),
    );

    expect(result.replacements).toBe(1);
    expect(readFileSync(path, "utf-8")).toBe(
      "  if (true) {\n    console.log('no');\n  }\n",
    );
  });
});
