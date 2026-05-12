import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDatabase, closeDatabase } from "./index.js";
import {
  upsertFile,
  searchFiles,
  deleteFile,
  syncDeleteFromKbMirror,
} from "./jarvis-fs.js";
import { existsSync, writeFileSync } from "node:fs";

let testKbDir: string;

beforeEach(() => {
  testKbDir = mkdtempSync(join(tmpdir(), "mc-jarvis-fs-test-"));
  process.env.JARVIS_KB_MIRROR_DIR = testKbDir;
  initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
  rmSync(testKbDir, { recursive: true, force: true });
  delete process.env.JARVIS_KB_MIRROR_DIR;
});

describe("searchFiles — FTS5 tokenized search", () => {
  it("finds 'uncharted OOH' in title with em-dash separator (algebra-day incident 2026-05-07)", () => {
    // Real failure: searching "uncharted OOH" with the LIKE-substring impl
    // missed "México Uncharted — OOH Intelligence" because of the em-dash.
    upsertFile(
      "projects/data-intelligence/ooh/README.md",
      "México Uncharted — OOH Intelligence",
      "# México Uncharted — OOH Intelligence\n\nRepo: https://github.com/EurekaMD-net/mexico-uncharted-ooh\n\nOut-of-home advertising data layer.",
      ["ooh", "uncharted"],
    );
    const results = searchFiles("uncharted OOH", 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].path).toBe("projects/data-intelligence/ooh/README.md");
  });

  it("matches multiple tokens in any order (AND semantics)", () => {
    upsertFile(
      "knowledge/farmacia-scoring.md",
      "Farmacia Scoring Playbook",
      "Detailed playbook for scoring pharmacy locations using DENUE and demographic data.",
    );
    upsertFile(
      "knowledge/retail-scoring.md",
      "Retail Scoring Playbook",
      "Retail playbook unrelated to pharmacy.",
    );
    const a = searchFiles("playbook DENUE", 10);
    const b = searchFiles("DENUE playbook", 10);
    expect(a[0].path).toBe("knowledge/farmacia-scoring.md");
    expect(b[0].path).toBe("knowledge/farmacia-scoring.md");
  });

  it("is diacritic-insensitive (México matches mexico)", () => {
    upsertFile(
      "knowledge/mexico-uncharted.md",
      "México Uncharted",
      "México Uncharted — OOH program details",
    );
    const results = searchFiles("mexico uncharted", 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].path).toBe("knowledge/mexico-uncharted.md");
  });

  it("supports prefix matching (uncharted matches Uncharted_v2)", () => {
    upsertFile(
      "projects/uncharted-v2.md",
      "Uncharted_v2",
      "Next-generation uncharted_v2 data plane.",
    );
    const results = searchFiles("uncharted", 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].path).toBe("projects/uncharted-v2.md");
  });

  it("returns empty when no token matches", () => {
    upsertFile(
      "knowledge/foo.md",
      "Foo",
      "Bar baz qux content with no match for the search term.",
    );
    const results = searchFiles("zzznoexist", 10);
    expect(results).toEqual([]);
  });

  it("returns a snippet that highlights the match terms with «»", () => {
    upsertFile(
      "knowledge/snippet-test.md",
      "Snippet Test",
      "First paragraph mentions the keyword photometry briefly.\n\nSecond paragraph repeats photometry once more.",
    );
    const results = searchFiles("photometry", 10);
    expect(results.length).toBe(1);
    expect(results[0].snippet).toMatch(/«photometry»/i);
  });

  it("falls back to LIKE for short/punctuation-only queries", () => {
    upsertFile(
      "projects/x.md",
      "Title with X",
      "Short token x in content body.",
    );
    // "x" is below the 2-char minimum token length, so FTS5 path is skipped
    // and LIKE substring runs instead. Should still return at least the file.
    const results = searchFiles("x", 10);
    expect(results.length).toBeGreaterThan(0);
  });

  it("handles operator-style queries safely (parens, AND, OR are not interpreted)", () => {
    upsertFile(
      "knowledge/operators.md",
      "AND OR NOT",
      "Files containing AND, OR, NOT and parens (like this) work fine.",
    );
    // These tokens used to crash the unprotected FTS5 MATCH; we wrap each
    // token in double-quotes so they are literal.
    const results = searchFiles("(AND OR NOT)", 10);
    expect(results.length).toBeGreaterThan(0);
  });

  // 2026-05-12 orphan-resurrection incident — DB delete must clear FS mirror
  it("deleteFile() removes the FS mirror file (symmetric delete)", () => {
    upsertFile("knowledge/del-target.md", "Title", "body text");
    const fullPath = join(testKbDir, "knowledge/del-target.md");
    expect(existsSync(fullPath)).toBe(true);
    expect(deleteFile("knowledge/del-target.md")).toBe(true);
    expect(existsSync(fullPath)).toBe(false);
  });

  // qa-auditor C1 (2026-05-12): empty / "." / "/" must not wipe the mirror root
  it("syncDeleteFromKbMirror refuses to delete the mirror root itself", () => {
    // Seed a file so we can prove the root still exists after.
    upsertFile("knowledge/witness.md", "Witness", "still here");
    expect(existsSync(testKbDir)).toBe(true);
    for (const evil of ["", ".", "/", "//", "./"]) {
      syncDeleteFromKbMirror(evil);
    }
    expect(existsSync(testKbDir)).toBe(true);
    expect(existsSync(join(testKbDir, "knowledge/witness.md"))).toBe(true);
  });

  // Path-traversal guard: refuses to delete outside the mirror root
  it("syncDeleteFromKbMirror refuses path traversal attempts", () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "mc-fs-outside-"));
    const outsideFile = join(outsideDir, "victim.md");
    writeFileSync(outsideFile, "should survive", "utf-8");
    try {
      // Build a path that, if naively joined, would resolve outside testKbDir.
      syncDeleteFromKbMirror(`../${outsideDir.split("/").pop()}/victim.md`);
      expect(existsSync(outsideFile)).toBe(true);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  // Audit Rec 9 — FTS trigger contract regression
  it("AFTER UPDATE trigger: stale content stops matching after upsert", () => {
    upsertFile("knowledge/trigger-test.md", "Initial", "alpha bravo charlie");
    expect(searchFiles("bravo", 10).length).toBe(1);
    // Overwrite content — old tokens should disappear from the FTS index.
    upsertFile("knowledge/trigger-test.md", "Updated", "delta echo foxtrot");
    expect(searchFiles("bravo", 10)).toEqual([]);
    expect(searchFiles("foxtrot", 10).length).toBe(1);
  });
});
