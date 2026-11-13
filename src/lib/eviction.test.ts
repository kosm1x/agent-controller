import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evictToFile,
  getEvictDir,
  hasEvictedPath,
  isEvictedPath,
} from "./eviction.js";
import {
  PASSWORD_WITHHELD_PLACEHOLDER,
  passwordFingerprint,
} from "./v8-4/password-gate.js";
import { _resetStoreWithhold, setStoreSeenCheck } from "./v8-4/store-withhold.js";

// Per-run scratch dir: tests never write the live eviction directory.
// The eviction dir itself does not exist yet, so evictToFile creates it.
let ROOT: string;
let TEST_DIR: string;

beforeAll(() => {
  ROOT = mkdtempSync(join(tmpdir(), "mc-evict-test-"));
  TEST_DIR = join(ROOT, "tool-results");
  vi.stubEnv("MC_TOOL_RESULTS_DIR", TEST_DIR);
});

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(ROOT, { recursive: true, force: true });
});

describe("eviction directory", () => {
  it("defaults to /root/claude/mission-control/tool-results when the env is unset", () => {
    vi.stubEnv("MC_TOOL_RESULTS_DIR", "");
    try {
      expect(getEvictDir()).toBe("/root/claude/mission-control/tool-results");
    } finally {
      vi.stubEnv("MC_TOOL_RESULTS_DIR", TEST_DIR);
    }
  });

  it("honours MC_TOOL_RESULTS_DIR and creates it root-only", () => {
    expect(getEvictDir()).toBe(TEST_DIR);
    expect(existsSync(TEST_DIR)).toBe(false);
    const { filePath } = evictToFile("x".repeat(1000), "test-env", 100);
    expect(filePath!.startsWith(TEST_DIR + "/")).toBe(true);
    expect(statSync(TEST_DIR).mode & 0o777).toBe(0o700);
  });

  it("isEvictedPath is true only inside the eviction directory", () => {
    expect(isEvictedPath(join(TEST_DIR, "web-read-1.txt"))).toBe(true);
    expect(isEvictedPath(TEST_DIR)).toBe(false);
    expect(isEvictedPath(TEST_DIR + "-sibling/x.txt")).toBe(false);
    expect(isEvictedPath(join(TEST_DIR, "..", "x.txt"))).toBe(false);
  });
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
    expect(preview).toContain(`file_read(path="${filePath}")`);
    expect(preview).toContain("kept for about one hour");
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

  it("detects the new eviction directory path", () => {
    expect(
      hasEvictedPath(`Use file_read(path="${join(TEST_DIR, "web-read-1.txt")}")`),
    ).toBe(true);
    vi.stubEnv("MC_TOOL_RESULTS_DIR", "");
    try {
      expect(
        hasEvictedPath(
          'Full content saved to: /root/claude/mission-control/tool-results/web-read-1.txt',
        ),
      ).toBe(true);
    } finally {
      vi.stubEnv("MC_TOOL_RESULTS_DIR", TEST_DIR);
    }
  });

  it("returns false for normal content", () => {
    expect(hasEvictedPath("Just a normal tool result")).toBe(false);
  });
});

describe("mailbox-password store rule on the spill file", () => {
  it("the file holds the placeholder; the preview returned to the caller keeps the text", () => {
    const pw = "FakeTestPassWordXYZ2345";
    const fp = passwordFingerprint(pw);
    setStoreSeenCheck({ size: () => 1, has: (f) => f === fp });
    try {
      const content = `password: ${pw}\n` + "y".repeat(500);
      const { preview, filePath } = evictToFile(content, "test-pw", 100);
      expect(preview).toContain(pw);
      const stored = readFileSync(filePath!, "utf-8");
      expect(stored).not.toContain(pw);
      expect(stored.startsWith(`password: ${PASSWORD_WITHHELD_PLACEHOLDER}\n`)).toBe(true);
    } finally {
      _resetStoreWithhold();
    }
  });
});
