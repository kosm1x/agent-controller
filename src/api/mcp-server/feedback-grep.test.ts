/**
 * Tests for the feedback grep helper. Uses a tmpdir-backed fixture so
 * we don't depend on the real memory directory.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchFeedback } from "./feedback-grep.js";

let fixtureDir: string;

beforeEach(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), "mcp-feedback-"));
  writeFileSync(
    join(fixtureDir, "feedback_autoreason.md"),
    "# Autoreason\n\nThe k=2 stability rule prevents replan thrashing on transient noise.\nPaper Table 23 shows k=1 is premature on 94% of runs.",
  );
  writeFileSync(
    join(fixtureDir, "feedback_phantom_evolution.md"),
    "Triple-judge with minority veto rejects any delta where confidence > 0.7.\nSame spirit as autoreason incumbent-survives-ties.",
  );
  writeFileSync(
    join(fixtureDir, "feedback_scope.md"),
    "Scope classifier uses semantic + regex fallback.\nNo mention of the pattern here.",
  );
  // Noise: non-feedback file should be ignored.
  writeFileSync(
    join(fixtureDir, "project_v77.md"),
    "autoreason is mentioned here too but this is not a feedback file",
  );
});

afterEach(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

describe("searchFeedback", () => {
  it("finds matches across feedback_*.md files and ignores others", () => {
    const results = searchFeedback({
      query: "autoreason",
      memoryDir: fixtureDir,
    });
    expect(results).toHaveLength(2);
    const files = results.map((r) => r.file);
    expect(files).toContain("feedback_autoreason.md");
    expect(files).toContain("feedback_phantom_evolution.md");
    // project_v77.md is not a feedback_*.md file so must be excluded.
    expect(files).not.toContain("project_v77.md");
  });

  it("orders results by match count (descending)", () => {
    const results = searchFeedback({
      query: "the",
      memoryDir: fixtureDir,
    });
    // The autoreason fixture contains "The k=2" and "Paper" — at least 1 match.
    // The scope fixture contains "The" twice. Orderings vary by corpus; assert monotonicity.
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].matchCount).toBeGreaterThanOrEqual(
        results[i].matchCount,
      );
    }
  });

  it("returns empty array for empty query", () => {
    expect(searchFeedback({ query: "", memoryDir: fixtureDir })).toEqual([]);
  });

  it("returns empty array when directory does not exist", () => {
    expect(
      searchFeedback({
        query: "anything",
        memoryDir: join(fixtureDir, "nonexistent"),
      }),
    ).toEqual([]);
  });

  it("respects the limit option", () => {
    const results = searchFeedback({
      query: "autoreason",
      limit: 1,
      memoryDir: fixtureDir,
    });
    expect(results).toHaveLength(1);
  });

  it("returns a snippet around the first match", () => {
    const results = searchFeedback({
      query: "k=2",
      memoryDir: fixtureDir,
    });
    expect(results).toHaveLength(1);
    expect(results[0].file).toBe("feedback_autoreason.md");
    expect(results[0].snippet.toLowerCase()).toContain("k=2");
  });

  it("is case-insensitive", () => {
    const lower = searchFeedback({
      query: "autoreason",
      memoryDir: fixtureDir,
    });
    const upper = searchFeedback({
      query: "AUTOREASON",
      memoryDir: fixtureDir,
    });
    expect(lower.map((r) => r.file).sort()).toEqual(
      upper.map((r) => r.file).sort(),
    );
  });

  // v7.7.1 M4 regression — symlink refusal. A symlink inside the memory
  // dir pointing outside of it (or to a sensitive file like /etc/shadow)
  // must NOT be followed. The filename filter alone is insufficient
  // because feedback_evil.md can be a symlink.
  it("refuses to follow symlinked feedback_*.md files", () => {
    // Create a target file OUTSIDE the fixtureDir with a secret-looking string
    const otherDir = mkdtempSync(join(tmpdir(), "mcp-symlink-target-"));
    const secretPath = join(otherDir, "secret.txt");
    writeFileSync(secretPath, "AUTOREASON_SECRET_MARKER_SHOULD_NOT_LEAK");

    // Place a symlink inside fixtureDir that looks like a legitimate
    // feedback file but points at the external secret
    const symPath = join(fixtureDir, "feedback_evil.md");
    symlinkSync(secretPath, symPath);

    try {
      const results = searchFeedback({
        query: "AUTOREASON_SECRET_MARKER",
        memoryDir: fixtureDir,
      });
      // Must not find the marker — the symlinked file should have been skipped
      expect(results).toHaveLength(0);
      // And must not list the symlinked filename in any result
      const files = results.map((r) => r.file);
      expect(files).not.toContain("feedback_evil.md");
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });
});
