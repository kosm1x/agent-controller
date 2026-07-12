/**
 * Tests for Drive sync Obsidian-native transformations.
 *
 * Only tests the pure transformation function (toObsidianContent).
 * Drive API interactions are fire-and-forget and tested via integration.
 */

import { describe, it, expect } from "vitest";
import { toObsidianContent } from "./drive-sync.js";

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
});
