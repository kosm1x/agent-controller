import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { evictToFile, hasEvictedPath } from "./eviction.js";

const TEST_DIR = join(process.cwd(), "data", "tool-results");

afterEach(() => {
  // Clean up test files
  try {
    const files = require("node:fs").readdirSync(TEST_DIR);
    for (const f of files) {
      if (f.startsWith("test-")) {
        rmSync(join(TEST_DIR, f), { force: true });
      }
    }
  } catch {
    // dir may not exist
  }
});

describe("evictToFile", () => {
  it("writes content to file and returns preview with TOC", () => {
    const content =
      "# Heading 1\nSome text\n## Heading 2\nMore text\n### Heading 3\nEven more\n".repeat(
        200,
      );
    const { preview, filePath } = evictToFile(content, "test-basic", 500);

    expect(filePath).toBeDefined();
    expect(existsSync(filePath!)).toBe(true);
    expect(readFileSync(filePath!, "utf-8")).toBe(content);
    expect(preview).toContain("DOCUMENT TRUNCATED");
    expect(preview).toContain("file_read");
    expect(preview).toContain("TABLE OF CONTENTS");
    expect(preview).toContain("Heading 1");
    expect(preview).toContain("Heading 2");
    expect(preview).toContain("Heading 3");
  });

  it("limits TOC to 30 headings", () => {
    const headings = Array.from(
      { length: 50 },
      (_, i) => `# Section ${i + 1}\nText`,
    ).join("\n");
    const { preview } = evictToFile(headings, "test-toc-limit", 100);

    expect(preview).toContain("TABLE OF CONTENTS (30 sections)");
    expect(preview).not.toContain("Section 31");
  });

  it("handles content with no markdown headings", () => {
    const content = "Just plain text without headings. ".repeat(500);
    const { preview, filePath } = evictToFile(content, "test-no-headings", 200);

    expect(filePath).toBeDefined();
    expect(preview).toContain("DOCUMENT TRUNCATED");
    expect(preview).not.toContain("TABLE OF CONTENTS");
  });

  it("respects maxPreviewChars for the preview portion", () => {
    const content = "A".repeat(10000);
    const { preview } = evictToFile(content, "test-max-preview", 500);

    // Preview should start with first 500 chars of content
    expect(preview.startsWith("A".repeat(500))).toBe(true);
  });

  it("captures h4-h6 headings in TOC", () => {
    const content =
      "# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6\n" + "x".repeat(1000);
    const { preview } = evictToFile(content, "test-deep-headings", 100);

    expect(preview).toContain("H4");
    expect(preview).toContain("H5");
    expect(preview).toContain("H6");
  });

  it("uses unique filenames (no collisions)", () => {
    const content = "x".repeat(1000);
    const { filePath: path1 } = evictToFile(content, "test-unique", 100);
    const { filePath: path2 } = evictToFile(content, "test-unique", 100);

    expect(path1).not.toBe(path2);
  });
});

describe("hasEvictedPath", () => {
  it("detects full_content_path in JSON", () => {
    const result = JSON.stringify({
      full_content_path: "/data/tool-results/x.txt",
    });
    expect(hasEvictedPath(result)).toBe(true);
  });

  it("detects data/tool-results/ path reference", () => {
    expect(
      hasEvictedPath('Use file_read(path="data/tool-results/foo.txt")'),
    ).toBe(true);
  });

  it("returns false for normal content", () => {
    expect(hasEvictedPath("Just a normal tool result")).toBe(false);
  });
});
