/**
 * Tests for grep, glob, and list_dir tools.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { grepTool, globTool, listDirTool } from "./code-search.js";

const TEST_DIR = "/tmp/mc-test-code-search";

describe("grep", () => {
  beforeEach(() => {
    mkdirSync(`${TEST_DIR}/sub`, { recursive: true });
    writeFileSync(`${TEST_DIR}/a.ts`, "const foo = 1;\nconst bar = 2;\n");
    writeFileSync(`${TEST_DIR}/b.ts`, "export function foo() {}\n");
    writeFileSync(`${TEST_DIR}/sub/c.py`, "def baz():\n    pass\n");
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("should find files containing pattern", async () => {
    const result = JSON.parse(
      await grepTool.execute({ pattern: "foo", path: TEST_DIR }),
    );

    expect(result.total).toBeGreaterThanOrEqual(2);
    expect(result.matches).toContain("a.ts");
    expect(result.matches).toContain("b.ts");
  });

  it("should return content mode with line numbers", async () => {
    const result = JSON.parse(
      await grepTool.execute({
        pattern: "bar",
        path: TEST_DIR,
        output_mode: "content",
      }),
    );

    expect(result.matches).toContain("bar");
    expect(result.total).toBe(1);
  });

  it("should filter by include_glob", async () => {
    const result = JSON.parse(
      await grepTool.execute({
        pattern: "def",
        path: TEST_DIR,
        include_glob: "*.py",
      }),
    );

    expect(result.total).toBeGreaterThanOrEqual(1);
    expect(result.matches).toContain("c.py");
  });

  it("should return empty for no matches", async () => {
    const result = JSON.parse(
      await grepTool.execute({ pattern: "zzzznonexistent", path: TEST_DIR }),
    );

    expect(result.total).toBe(0);
  });

  it("should support case-insensitive search", async () => {
    const result = JSON.parse(
      await grepTool.execute({
        pattern: "FOO",
        path: TEST_DIR,
        case_insensitive: true,
      }),
    );

    expect(result.total).toBeGreaterThanOrEqual(2);
  });
});

describe("glob", () => {
  beforeEach(() => {
    mkdirSync(`${TEST_DIR}/src/components`, { recursive: true });
    writeFileSync(`${TEST_DIR}/src/index.ts`, "");
    writeFileSync(`${TEST_DIR}/src/components/App.tsx`, "");
    writeFileSync(`${TEST_DIR}/src/components/Button.tsx`, "");
    writeFileSync(`${TEST_DIR}/package.json`, "{}");
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("should find files by extension", async () => {
    const result = JSON.parse(
      await globTool.execute({ pattern: "*.tsx", path: TEST_DIR }),
    );

    expect(result.total).toBe(2);
    expect(result.files.some((f: string) => f.includes("App.tsx"))).toBe(true);
    expect(result.files.some((f: string) => f.includes("Button.tsx"))).toBe(
      true,
    );
  });

  it("should find specific filenames", async () => {
    const result = JSON.parse(
      await globTool.execute({ pattern: "package.json", path: TEST_DIR }),
    );

    expect(result.total).toBeGreaterThanOrEqual(1);
  });

  it("should return empty for no matches", async () => {
    const result = JSON.parse(
      await globTool.execute({ pattern: "*.rb", path: TEST_DIR }),
    );

    expect(result.total).toBe(0);
  });
});

describe("list_dir", () => {
  beforeEach(() => {
    mkdirSync(`${TEST_DIR}/subdir`, { recursive: true });
    writeFileSync(`${TEST_DIR}/file1.ts`, "");
    writeFileSync(`${TEST_DIR}/file2.ts`, "");
    writeFileSync(`${TEST_DIR}/subdir/nested.ts`, "");
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("should list directory contents", async () => {
    const result = JSON.parse(await listDirTool.execute({ path: TEST_DIR }));

    expect(result.entries).toContain("file1.ts");
    expect(result.entries).toContain("file2.ts");
    expect(result.entries.some((e: string) => e.includes("subdir"))).toBe(true);
  });

  it("should list recursively", async () => {
    const result = JSON.parse(
      await listDirTool.execute({ path: TEST_DIR, recursive: true }),
    );

    expect(result.entries.some((e: string) => e.includes("nested.ts"))).toBe(
      true,
    );
  });

  it("should handle non-existent directory", async () => {
    const result = JSON.parse(
      await listDirTool.execute({ path: "/tmp/mc-test-nonexistent-dir" }),
    );

    // Either empty entries or error
    expect(result.entries?.length === 0 || result.error).toBeTruthy();
  });
});
