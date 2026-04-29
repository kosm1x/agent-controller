/**
 * Tests for file_read large-file behavior (Session 114).
 *
 * Mocks node:fs so the tests don't need real files. The non-truncation paths
 * (path-safety, .docx) are exercised in integration; this file focuses on the
 * Tier B contract: structured envelope on large files + lines parameter.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  mockReadFileSync: vi.fn(),
  mockExecFileSync: vi.fn(() => "main"),
  mockStatSync: vi.fn(),
}));

vi.mock("fs", () => ({
  readFileSync: mocks.mockReadFileSync,
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
  statSync: mocks.mockStatSync,
}));

vi.mock("child_process", () => ({
  execFileSync: mocks.mockExecFileSync,
}));

import { fileReadTool } from "./file.js";

describe("file_read — Session 114 large-file behavior", () => {
  beforeEach(() => {
    mocks.mockReadFileSync.mockReset();
  });

  it("returns full content + total_chars for small files", async () => {
    mocks.mockReadFileSync.mockReturnValueOnce("# small\nline 2\nline 3");

    const result = await fileReadTool.execute({ path: "/tmp/small.md" });
    const parsed = JSON.parse(result);

    expect(parsed.content).toBe("# small\nline 2\nline 3");
    expect(parsed.total_chars).toBe(21);
    expect(parsed.total_lines).toBe(3);
    expect(parsed.truncated).toBeUndefined();
  });

  it("returns structured envelope on large files (>8k)", async () => {
    const big =
      "# Top\n\n## Section A\nA body\n\n## Section B\nB body\n\n" +
      "x".repeat(10_000);
    mocks.mockReadFileSync.mockReturnValueOnce(big);

    const result = await fileReadTool.execute({ path: "/tmp/big.md" });
    const parsed = JSON.parse(result);

    expect(parsed.truncated).toBe(true);
    expect(parsed.total_chars).toBe(big.length);
    expect(parsed.total_lines).toBeGreaterThan(0);
    expect(parsed.outline).toEqual(
      expect.arrayContaining([expect.stringMatching(/^L\d+: # /)]),
    );
    expect(parsed.outline.some((h: string) => h.includes("Section A"))).toBe(
      true,
    );
    expect(parsed.preview.length).toBeLessThanOrEqual(1500);
    expect(parsed.next_steps.join(" ")).toContain("lines=");
    expect(parsed.content).toBeUndefined();
  });

  it("returns the requested slice when lines is provided", async () => {
    const content = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join(
      "\n",
    );
    mocks.mockReadFileSync.mockReturnValueOnce(content);

    const result = await fileReadTool.execute({
      path: "/tmp/x.md",
      lines: "5-7",
    });
    const parsed = JSON.parse(result);

    expect(parsed.content).toBe("line 5\nline 6\nline 7");
    expect(parsed.lines).toBe("5-7");
    expect(parsed.slice_lines).toBe(3);
    expect(parsed.total_lines).toBe(100);
    expect(parsed.truncated).toBeUndefined();
  });

  it("supports comma-separated multiple ranges", async () => {
    const content = Array.from({ length: 50 }, (_, i) => `L${i + 1}`).join(
      "\n",
    );
    mocks.mockReadFileSync.mockReturnValueOnce(content);

    const result = await fileReadTool.execute({
      path: "/tmp/x.md",
      lines: "1-2,10-11",
    });
    const parsed = JSON.parse(result);

    expect(parsed.content).toBe("L1\nL2\nL10\nL11");
    expect(parsed.slice_lines).toBe(4);
  });

  it("clamps out-of-range slices and flags clamped", async () => {
    mocks.mockReadFileSync.mockReturnValueOnce("L1\nL2\nL3");

    const result = await fileReadTool.execute({
      path: "/tmp/x.md",
      lines: "1-1000",
    });
    const parsed = JSON.parse(result);

    expect(parsed.content).toBe("L1\nL2\nL3");
    expect(parsed.clamped).toBe(true);
    expect(parsed.total_lines).toBe(3);
  });

  it("returns error envelope for malformed lines spec", async () => {
    mocks.mockReadFileSync.mockReturnValueOnce("hello");

    const result = await fileReadTool.execute({
      path: "/tmp/x.md",
      lines: "garbage",
    });
    const parsed = JSON.parse(result);

    expect(parsed.error).toContain("Invalid lines spec");
    expect(parsed.content).toBeUndefined();
  });

  it("coerces numeric `lines` arg rather than crashing (qa W3)", async () => {
    mocks.mockReadFileSync.mockReturnValueOnce("L1\nL2\nL3");
    const result = await fileReadTool.execute({
      path: "/tmp/x.md",
      lines: 2,
    });
    const parsed = JSON.parse(result);
    expect(parsed.content).toBe("L2");
    expect(parsed.lines).toBe("2");
  });

  it("normalizes CRLF in slices (qa W4)", async () => {
    mocks.mockReadFileSync.mockReturnValueOnce("L1\r\nL2\r\nL3\r\n");
    const result = await fileReadTool.execute({
      path: "/tmp/crlf.md",
      lines: "1-2",
    });
    const parsed = JSON.parse(result);
    expect(parsed.content).toBe("L1\nL2");
    expect(parsed.content).not.toMatch(/\r/);
  });

  it("caps very large slice payloads at MAX_READ to prevent payload DoS", async () => {
    // Single line that's bigger than MAX_READ; lines=1 still returns content
    // but it gets sliced down.
    const huge = "x".repeat(60_000);
    mocks.mockReadFileSync.mockReturnValueOnce(huge);

    const result = await fileReadTool.execute({
      path: "/tmp/huge.txt",
      lines: "1-1",
    });
    const parsed = JSON.parse(result);

    expect(parsed.content.length).toBeLessThanOrEqual(50_000);
    expect(parsed.slice_capped).toBe(true);
  });
});
