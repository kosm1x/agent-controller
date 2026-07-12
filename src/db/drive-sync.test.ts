/**
 * Tests for Drive sync Obsidian-native transformations.
 *
 * Only tests the pure transformation functions (toObsidianContent,
 * inferSection, inferParentPath, injectContentWikilinks).
 * Drive API interactions are fire-and-forget and tested via integration.
 */

import { describe, it, expect } from "vitest";
import {
  toObsidianContent,
  inferSection,
  inferParentPath,
  injectContentWikilinks,
} from "./drive-sync.js";

describe("toObsidianContent", () => {
  it("prepends YAML frontmatter with title, qualifier, priority, path, updated", () => {
    const result = toObsidianContent(
      "directives/core.md",
      "Core Directives",
      "# Hello",
    );

    expect(result).toMatch(/^---\n/);
    expect(result).toMatch(/title: "Core Directives"/);
    expect(result).toMatch(/qualifier: reference/);
    expect(result).toMatch(/priority: 50/);
    expect(result).toMatch(/path: "directives\/core\.md"/);
    expect(result).toMatch(/updated: \d{4}-\d{2}-\d{2}/);
    expect(result).toMatch(/---\n\n# Hello/);
  });

  it("includes tags when provided", () => {
    const result = toObsidianContent("test.md", "Test", "content", {
      tags: ["sop", "directive"],
    });

    expect(result).toMatch(/tags: \[sop, directive\]/);
  });

  it("includes condition when provided", () => {
    const result = toObsidianContent("test.md", "Test", "content", {
      condition: "scope:reporting",
    });

    expect(result).toMatch(/condition: "scope:reporting"/);
  });

  it("uses provided qualifier and priority", () => {
    const result = toObsidianContent("test.md", "Test", "content", {
      qualifier: "enforce",
      priority: 10,
    });

    expect(result).toMatch(/qualifier: enforce/);
    expect(result).toMatch(/priority: 10/);
  });

  it("appends Related section with wikilinks from relatedTo", () => {
    const result = toObsidianContent(
      "projects/crm/overview.md",
      "CRM",
      "content",
      {
        relatedTo: ["NorthStar/goals.md", "projects/crm/roadmap.md"],
      },
    );

    expect(result).toContain("## Related");
    expect(result).toContain("- [[NorthStar/goals|goals]]");
    expect(result).toContain("- [[projects/crm/roadmap|roadmap]]");
  });

  it("skips Related section when relatedTo is empty", () => {
    const result = toObsidianContent("test.md", "Test", "content", {
      relatedTo: [],
    });

    expect(result).not.toContain("## Related");
  });

  it("escapes quotes in title", () => {
    const result = toObsidianContent(
      "test.md",
      'Test "quoted" title',
      "content",
    );

    expect(result).toContain('title: "Test \\"quoted\\" title"');
  });

  it("handles files without metadata gracefully", () => {
    const result = toObsidianContent("simple.md", "Simple", "Hello world");

    expect(result).toMatch(/^---\n/);
    expect(result).toContain("qualifier: reference");
    expect(result).toContain("priority: 50");
    expect(result).toContain("Hello world");
    expect(result).not.toContain("tags:");
    expect(result).not.toContain("condition:");
  });

  it("strips .md from wikilink paths", () => {
    const result = toObsidianContent("test.md", "Test", "content", {
      relatedTo: ["knowledge/fact.md"],
    });

    expect(result).toContain("[[knowledge/fact|fact]]");
    expect(result).not.toContain("[[knowledge/fact.md");
  });

  it("preserves original content between frontmatter and related", () => {
    const original = "# Title\n\nSome content\n\n## Section\nMore content";
    const result = toObsidianContent("test.md", "Test", original, {
      relatedTo: ["other.md"],
    });

    // Content should appear between frontmatter close and Related section
    const afterFrontmatter = result.split("---\n\n")[1];
    expect(afterFrontmatter).toMatch(/^# Title\n\nSome content/);
    expect(afterFrontmatter).toContain("## Related");
  });

  // --- R3: section field ---
  it("adds section field to frontmatter based on path", () => {
    expect(toObsidianContent("projects/foo/README.md", "Foo", "x")).toMatch(
      /section: projects/,
    );
    expect(toObsidianContent("knowledge/people/x.md", "X", "x")).toMatch(
      /section: knowledge/,
    );
    expect(toObsidianContent("NorthStar/goals/x.md", "X", "x")).toMatch(
      /section: NorthStar/,
    );
    expect(toObsidianContent("directives/core.md", "Core", "x")).toMatch(
      /section: directives/,
    );
    expect(toObsidianContent("top-level.md", "Top", "x")).toMatch(
      /section: root/,
    );
  });

  // --- R1+R2: parent wikilink in frontmatter ---
  it("adds parent field for nested project files", () => {
    const result = toObsidianContent("projects/tmn/notes/x.md", "X", "content");
    expect(result).toMatch(/parent: "\[\[projects\/tmn\/README\]\]"/);
  });

  it("adds parent field for direct project files (not README)", () => {
    const result = toObsidianContent("projects/tmn/overview.md", "X", "x");
    expect(result).toMatch(/parent: "\[\[projects\/tmn\/README\]\]"/);
  });

  it("does NOT add parent field to the README itself", () => {
    const result = toObsidianContent("projects/tmn/README.md", "TMN", "x");
    expect(result).not.toMatch(/parent:/);
  });

  it("adds parent for knowledge sub-files", () => {
    const result = toObsidianContent("knowledge/people/fede.md", "Fede", "x");
    expect(result).toMatch(/parent: "\[\[knowledge\/people\]\]"/);
  });

  it("adds parent for NorthStar sub-files", () => {
    const result = toObsidianContent("NorthStar/goals/foo.md", "Foo", "x");
    expect(result).toMatch(/parent: "\[\[NorthStar\/goals\]\]"/);
  });

  // --- R1+R2: parent also appears in Related section ---
  it("includes inferred parent in Related section", () => {
    const result = toObsidianContent("projects/tmn/overview.md", "Overview", "x");
    expect(result).toContain("## Related");
    expect(result).toContain("- [[projects/tmn/README|README]]");
  });

  it("does not duplicate parent in Related when already in relatedTo", () => {
    const result = toObsidianContent(
      "projects/tmn/overview.md",
      "Overview",
      "x",
      { relatedTo: ["projects/tmn/README.md"] },
    );
    const relatedSection = result.split("## Related")[1] ?? "";
    const count = (relatedSection.match(/projects\/tmn\/README/g) ?? []).length;
    expect(count).toBe(1);
  });

  // --- R5: content wikilink injection ---
  it("injects wikilinks for bare KB paths in content", () => {
    const result = toObsidianContent(
      "test.md",
      "Test",
      "See projects/tmn/README.md for details.",
    );
    expect(result).toContain("[[projects/tmn/README|README]]");
    expect(result).not.toContain("projects/tmn/README.md for");
  });

  it("does not double-wrap already wikilinked paths", () => {
    const result = toObsidianContent(
      "test.md",
      "Test",
      "See [[projects/tmn/README|TMN]] for details.",
    );
    expect(result).not.toContain("[[[[");
  });
});

// ---------------------------------------------------------------------------
// inferSection
// ---------------------------------------------------------------------------
describe("inferSection", () => {
  it("returns correct section for known tops", () => {
    expect(inferSection("projects/foo/README.md")).toBe("projects");
    expect(inferSection("knowledge/people/x.md")).toBe("knowledge");
    expect(inferSection("NorthStar/goals/x.md")).toBe("NorthStar");
    expect(inferSection("directives/core.md")).toBe("directives");
    expect(inferSection("logs/day-logs/x.md")).toBe("logs");
    expect(inferSection("workspace/x.md")).toBe("workspace");
  });

  it("returns root for unknown top-level", () => {
    expect(inferSection("index.md")).toBe("root");
    expect(inferSection("something/x.md")).toBe("root");
  });
});

// ---------------------------------------------------------------------------
// inferParentPath
// ---------------------------------------------------------------------------
describe("inferParentPath", () => {
  it("returns null for README.md of a project", () => {
    expect(inferParentPath("projects/tmn/README.md")).toBeNull();
  });

  it("returns README path for direct project files", () => {
    expect(inferParentPath("projects/tmn/overview.md")).toBe("projects/tmn/README");
  });

  it("returns README path for deeply nested project files", () => {
    expect(inferParentPath("projects/tmn/notes/meeting.md")).toBe("projects/tmn/README");
  });

  it("returns folder node for knowledge sub-files", () => {
    expect(inferParentPath("knowledge/people/fede.md")).toBe("knowledge/people");
  });

  it("returns folder node for NorthStar sub-files", () => {
    expect(inferParentPath("NorthStar/goals/liberty.md")).toBe("NorthStar/goals");
  });

  it("returns null for top-level and single-level files", () => {
    expect(inferParentPath("index.md")).toBeNull();
    expect(inferParentPath("directives/core.md")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// injectContentWikilinks
// ---------------------------------------------------------------------------
describe("injectContentWikilinks", () => {
  it("converts bare KB paths to wikilinks", () => {
    const result = injectContentWikilinks("See projects/tmn/README.md for details.");
    expect(result).toContain("[[projects/tmn/README|README]]");
  });

  it("does not convert already-wikilinked paths", () => {
    const input = "See [[projects/tmn/README|TMN]] here.";
    expect(injectContentWikilinks(input)).toBe(input);
  });

  it("ignores https URLs", () => {
    const input = "See https://docs.google.com/something for info.";
    expect(injectContentWikilinks(input)).toBe(input);
  });

  it("handles multiple bare paths in one string", () => {
    const result = injectContentWikilinks(
      "See projects/foo/a.md and knowledge/people/x.md.",
    );
    expect(result).toContain("[[projects/foo/a|a]]");
    expect(result).toContain("[[knowledge/people/x|x]]");
  });

  it("does not modify paths outside known KB sections", () => {
    const input = "See some/random/path.md here.";
    expect(injectContentWikilinks(input)).toBe(input);
  });
});

// Review fold (2026-07-12): wikilink injection must never rewrite code.
describe("injectContentWikilinks — code-safety review folds", () => {
  it("leaves fenced code blocks untouched", () => {
    const input =
      "Ver projects/tmn/README.md para contexto.\n\n```bash\ncat projects/tmn/README.md\n```\n";
    const out = injectContentWikilinks(input);
    expect(out).toContain("[[projects/tmn/README|README]] para contexto");
    expect(out).toContain("```bash\ncat projects/tmn/README.md\n```");
  });

  it("leaves inline code spans untouched", () => {
    const out = injectContentWikilinks(
      "Edita `projects/tmn/plan.md` y revisa knowledge/kb/mirror.md",
    );
    expect(out).toContain("`projects/tmn/plan.md`");
    expect(out).toContain("[[knowledge/kb/mirror|mirror]]");
  });

  it("leaves markdown-link targets untouched", () => {
    const out = injectContentWikilinks("Ver [el plan](projects/tmn/plan.md).");
    expect(out).toBe("Ver [el plan](projects/tmn/plan.md).");
  });

  it("stays idempotent across repeated runs", () => {
    const once = injectContentWikilinks("Ver projects/tmn/plan.md hoy");
    expect(injectContentWikilinks(once)).toBe(once);
  });
});
