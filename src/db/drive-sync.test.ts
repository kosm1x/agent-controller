/**
 * Tests for Drive sync Obsidian-native transformations.
 *
 * Only tests the pure transformation functions (toObsidianContent,
 * inferSection, inferParentPath, injectContentWikilinks).
 * Drive API interactions are fire-and-forget and tested via integration.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Bulk-pass tests (reformat/backfill) need the module to see a KB folder id at
// import time, and every Drive call is mocked.
const drive = vi.hoisted(() => {
  process.env.DRIVE_KB_FOLDER_ID = "kb-root-test";
  return { googleFetch: vi.fn(), isLive: true };
});
vi.mock("../google/client.js", () => ({ googleFetch: drive.googleFetch }));
// The live-db predicate (queue 4a): tests open :memory:, which the real
// predicate refuses, so it is mocked; `drive.isLive` picks the answer.
vi.mock("./live-db.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./live-db.js")>();
  return {
    ...real,
    isLiveDatabaseFile: vi.fn(() => drive.isLive),
  };
});

import {
  toObsidianContent,
  inferSection,
  inferParentPath,
  injectContentWikilinks,
  splitFrontmatter,
  reformatDriveFiles,
  backfillToDrive,
  syncToDrive,
  syncDeleteToDrive,
  settleDriveSyncs,
  findFolder,
  getDriveMapEntry,
  recordDriveId,
} from "./drive-sync.js";
import { initDatabase, closeDatabase, getDatabase } from "./index.js";

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
    const afterFrontmatter = splitFrontmatter(result).body;
    expect(afterFrontmatter).toMatch(/^\n# Title\n\nSome content/);
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

// ---------------------------------------------------------------------------
// Frontmatter merge (rulings R1-R4, 2026-10-16)
// ---------------------------------------------------------------------------

const UPDATED_AT = "2026-10-16 18:30:00"; // UTC -> 2026-10-16 in Mexico City

/** Frontmatter lines of an output (between the first fence pair). */
function headLines(out: string): string[] {
  const split = splitFrontmatter(out);
  expect(split.block).not.toBeNull();
  return split.block ?? [];
}

/** Body of an output: what follows the closing fence and its blank line. */
function bodyOf(out: string): string {
  return splitFrontmatter(out).body.replace(/^\n/, "");
}

/**
 * Strict subset validator for the emitted frontmatter: one fence pair at
 * line 1, unique top-level keys, every line in the grammar, balanced double
 * quotes, and no second block right after the first.
 */
function assertStrictFrontmatter(out: string): void {
  expect(out.startsWith("---\n")).toBe(true);
  const lines = headLines(out);
  const keys = new Set<string>();
  let seenKey = false;
  for (const l of lines) {
    if (/^\s*$/.test(l) || /^\s*#/.test(l)) continue;
    const m = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*:(\s|$)/.exec(l);
    if (m) {
      expect(keys.has(m[1]), `duplicate key ${m[1]}`).toBe(false);
      keys.add(m[1]);
      seenKey = true;
    } else {
      expect(seenKey && (/^\s*-(\s|$)/.test(l) || /^\s+\S/.test(l)), l).toBe(true);
    }
    const quotes = l.replace(/\\./g, "").split('"').length - 1;
    expect(quotes % 2, `unbalanced quotes: ${l}`).toBe(0);
  }
  expect(splitFrontmatter(bodyOf(out)).block).toBeNull();
}

const SKILL_BLOCK = [
  "name: weekly-report",
  "description: Builds the weekly report",
  "version: 2",
  "output_type: markdown",
  "trigger_examples:",
  "  - reporte semanal",
  "  - weekly report",
  "tools_used: null",
  'inputs_json: \'{"week": "string"}\'',
  "tests_json: '[]'",
];

const MEMORY_BLOCK = [
  "name: user-pref",
  "metadata:",
  "  source: chat",
  "  confidence: alta",
];

describe("frontmatter merge — no YAML in the file", () => {
  it("emits one block and keeps the body verbatim", () => {
    const body = "# Title\n\nPlain text, no fence.\n";
    const out = toObsidianContent("knowledge/a/b.md", "B", body, {
      updatedAt: UPDATED_AT,
    });
    expect(out.match(/^---$/gm)?.length).toBe(2);
    expect(bodyOf(out).startsWith(body)).toBe(true);
    assertStrictFrontmatter(out);
  });
});

describe("frontmatter merge — valid YAML with file-owned keys", () => {
  it("appends the skill block verbatim after the sync keys inside one fence pair", () => {
    const body = "# Weekly report\n\nSteps.\n";
    const content = `---\n${SKILL_BLOCK.join("\n")}\n---\n${body}`;
    const out = toObsidianContent("skills/weekly-report/SKILL.md", "Weekly", content, {
      tags: ["skill"],
      updatedAt: UPDATED_AT,
    });
    const lines = headLines(out);
    const updatedIdx = lines.indexOf("updated: 2026-10-16");
    expect(updatedIdx).toBeGreaterThan(0);
    expect(lines.slice(updatedIdx + 1)).toEqual(SKILL_BLOCK);
    expect(lines.slice(0, 4)).toEqual([
      'title: "Weekly"',
      "qualifier: reference",
      "priority: 50",
      "section: skills",
    ]);
    expect(out.match(/^---$/gm)?.length).toBe(2);
    expect(bodyOf(out)).toBe(body);
    assertStrictFrontmatter(out);
  });

  it("keeps a nested map with its indented keys", () => {
    const content = `---\n${MEMORY_BLOCK.join("\n")}\n---\n\nRecuerda: prefiere español.\n`;
    const out = toObsidianContent("knowledge/memory/pref.md", "Pref", content, {
      updatedAt: UPDATED_AT,
    });
    const lines = headLines(out);
    expect(lines.slice(-4)).toEqual(MEMORY_BLOCK);
    expect(bodyOf(out).startsWith("Recuerda: prefiere español.\n\n\n## Related")).toBe(true);
    assertStrictFrontmatter(out);
  });
});

describe("frontmatter merge — malformed blocks", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("treats a block without a closing fence within 200 lines as body", () => {
    const filler = Array.from({ length: 250 }, (_, i) => `k${i}: v`).join("\n");
    const content = `---\n${filler}\n`;
    const split = splitFrontmatter(content);
    expect(split.block).toBeNull();
    expect(split.malformedReason).toBe("no closing fence");
    const out = toObsidianContent("notes/x.md", "X", content);
    expect(out).toContain(content);
    expect(out.indexOf(content)).toBe(out.indexOf("\n---\n\n") + 6);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toBe(
      "[drive-sync] frontmatter ignored for notes/x.md: no closing fence",
    );
  });

  it("treats a block with a line outside the grammar as body", () => {
    const content = "---\ntitle: x\nthis is not yaml\n---\n# Body\n";
    const split = splitFrontmatter(content);
    expect(split.block).toBeNull();
    expect(split.malformedReason).toMatch(/^line 3: unrecognized line "this is not yaml"$/);
    let out = "";
    expect(() => {
      out = toObsidianContent("notes/y.md", "Y", content);
    }).not.toThrow();
    expect(out).toContain(content);
    expect(headLines(out)).not.toContain("title: x");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("notes/y.md");
  });

  it("caps the echoed line at 40 characters", () => {
    const long = "x".repeat(100);
    const split = splitFrontmatter(`---\nk: v\n${long}\n---\n`);
    expect(split.malformedReason).toBe(`line 3: unrecognized line "${"x".repeat(40)}"`);
  });

  it("rejects a list item before the first key", () => {
    const split = splitFrontmatter("---\n- a\nk: v\n---\n");
    expect(split.block).toBeNull();
    expect(split.malformedReason).toMatch(/^line 2: content before the first key/);
  });
});

describe("frontmatter merge — duplicate and conflicting keys", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renames sync-owned keys to source_, unions tags, drops a duplicate", () => {
    const content = [
      "---",
      'title: "Own Title"',
      'tags: [x, "two words"]',
      "path: other/place.md",
      "updated: 2026-01-01",
      "description: first",
      "description: second",
      "---",
      "# Body",
      "",
    ].join("\n");
    const out = toObsidianContent("knowledge/a/b.md", "Sync Title", content, {
      tags: ["sop", "x"],
      updatedAt: UPDATED_AT,
    });
    const lines = headLines(out);
    expect(lines).toContain('title: "Sync Title"');
    expect(lines).toContain('source_title: "Own Title"');
    expect(lines).toContain('path: "knowledge/a/b.md"');
    expect(lines).toContain("source_path: other/place.md");
    expect(lines).toContain("updated: 2026-10-16");
    expect(lines).toContain("source_updated: 2026-01-01");
    expect(lines).toContain('tags: [sop, x, "two words"]');
    expect(lines.filter((l) => l.startsWith("tags:"))).toHaveLength(1);
    expect(lines).toContain("description: first");
    expect(out).not.toContain("second");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toBe(
      "[drive-sync] frontmatter duplicate keys dropped: description for knowledge/a/b.md",
    );
    assertStrictFrontmatter(out);
  });

  it("drops a file entry equal to the sync value instead of renaming it", () => {
    const content = '---\ntitle: "Same"\nqualifier: reference\nowner: me\n---\nx\n';
    const out = toObsidianContent("notes/a.md", "Same", content, {
      updatedAt: UPDATED_AT,
    });
    const lines = headLines(out);
    expect(lines.filter((l) => l.includes("title:"))).toEqual(['title: "Same"']);
    expect(lines.filter((l) => l.includes("qualifier:"))).toEqual(["qualifier: reference"]);
    expect(lines).toContain("owner: me");
    expect(warn).not.toHaveBeenCalled();
  });

  it("W4: title + source_title in the file is a collision: whole content kept as body", () => {
    const content = "---\ntitle: mine\nsource_title: older\n---\nx\n";
    const out = toObsidianContent("notes/a.md", "Sync", content);
    const lines = headLines(out);
    expect(lines).toContain('title: "Sync"');
    expect(lines.some((l) => l.startsWith("source_"))).toBe(false);
    expect(out).toContain(content); // nothing dropped
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toBe(
      "[drive-sync] frontmatter ignored for notes/a.md: source_title collision",
    );
    expect(toObsidianContent("notes/a.md", "Sync", out)).toBe(out);
  });

  it("W4: an unsupported tags shape next to source_tags is a collision too", () => {
    const content = "---\ntags: solo\nsource_tags: old\n---\nx\n";
    const out = toObsidianContent("notes/a.md", "A", content);
    expect(out).toContain(content);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("source_tags collision");
  });

  it("a file title equal to the sync value next to source_title is no collision", () => {
    const content = '---\ntitle: "A"\nsource_title: older\n---\nx\n';
    const lines = headLines(toObsidianContent("notes/a.md", "A", content));
    expect(lines).toContain("source_title: older");
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps an unsupported tags shape as source_tags (one warn)", () => {
    const content = "---\ntags: solo\n---\nx\n";
    const out = toObsidianContent("notes/a.md", "A", content, { tags: ["sop"] });
    const lines = headLines(out);
    expect(lines).toContain("tags: [sop]");
    expect(lines).toContain("source_tags: solo");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("source_tags");
  });

  it("unions a block-list tags entry", () => {
    const content = "---\ntags:\n  - alfa\n  - 'beta gamma'\n  - sop\n---\nx\n";
    const out = toObsidianContent("notes/a.md", "A", content, { tags: ["sop"] });
    expect(headLines(out)).toContain('tags: [sop, alfa, "beta gamma"]');
    expect(warn).not.toHaveBeenCalled();
  });

  it("omits tags when the union is empty", () => {
    const out = toObsidianContent("notes/a.md", "A", "---\ntags: []\n---\nx\n");
    expect(out).not.toContain("tags");
  });
});

describe("frontmatter merge — legacy plain-text head (R3)", () => {
  it("never lifts unfenced description/estado lines", () => {
    const content = "description: algo\nestado: activo\n\n# Titulo\n";
    expect(splitFrontmatter(content)).toEqual({ block: null, body: content });
    const out = toObsidianContent("projects/x/notes/a.md", "A", content);
    expect(bodyOf(out).startsWith(content)).toBe(true);
    expect(headLines(out).some((l) => l.startsWith("description"))).toBe(false);
  });
});

describe("frontmatter merge — degenerate content", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("handles empty content", () => {
    const out = toObsidianContent("notes/a.md", "A", "", { updatedAt: UPDATED_AT });
    expect(out.endsWith("updated: 2026-10-16\n---\n\n")).toBe(true);
    assertStrictFrontmatter(out);
  });

  it("handles content that is only a block", () => {
    const out = toObsidianContent("notes/a.md", "A", "---\nowner: me\n---\n", {
      updatedAt: UPDATED_AT,
    });
    expect(out.endsWith("updated: 2026-10-16\nowner: me\n---\n\n")).toBe(true);
    assertStrictFrontmatter(out);
  });

  it("handles content that is only an opening fence", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = toObsidianContent("notes/a.md", "A", "---\n", { updatedAt: UPDATED_AT });
    expect(out.endsWith("updated: 2026-10-16\n---\n\n---\n")).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("frontmatter merge — body horizontal rules", () => {
  it("does not take a mid-body rule for frontmatter", () => {
    const content = "# T\n\ntext\n\n---\n\nmore";
    expect(splitFrontmatter(content)).toEqual({ block: null, body: content });
    const out = toObsidianContent("notes/a.md", "A", content);
    expect(bodyOf(out)).toBe(content);
  });

  it("does not take a fence on line 2 (blank line 1) for frontmatter", () => {
    const content = "\n---\nk: v\n---\nbody";
    expect(splitFrontmatter(content).block).toBeNull();
    expect(splitFrontmatter(content).malformedReason).toBeUndefined();
    expect(splitFrontmatter(" ---\nk: v\n---\n").block).toBeNull();
  });

  it("leaves body rules after a real block untouched", () => {
    const body = "# T\n\n---\n\nx\n---\nend\n";
    const out = toObsidianContent("notes/a.md", "A", `---\nk: v\n---\n${body}`);
    expect(headLines(out)).toContain("k: v");
    expect(bodyOf(out)).toBe(body);
  });
});

describe("frontmatter merge — CRLF and BOM", () => {
  it("detects a CRLF block and keeps CRLF in the body", () => {
    const content = "---\r\ndescription: x\r\n---\r\n# T\r\n";
    const split = splitFrontmatter(content);
    expect(split.block).toEqual(["description: x"]);
    const out = toObsidianContent("notes/a.md", "A", content);
    expect(headLines(out)).toContain("description: x");
    expect(out).not.toMatch(/description: x\r/);
    expect(bodyOf(out)).toBe("# T\r\n");
  });

  it("tolerates a leading BOM", () => {
    const split = splitFrontmatter("﻿---\nk: v\n---\nb");
    expect(split.block).toEqual(["k: v"]);
    expect(split.body).toBe("b");
  });
});

describe("frontmatter merge — large files", () => {
  it("merges a 600 KB body with a 5-line block quickly", () => {
    const line = "Texto de relleno con projects/foo/a.md y mas palabras.\n";
    const body = line.repeat(Math.ceil(600_000 / line.length));
    const block = ["a: 1", "b: 2", "c: 3", "d: 4", "e: 5"];
    const content = `---\n${block.join("\n")}\n---\n${body}`;
    const t0 = performance.now();
    const out = toObsidianContent("notes/big.md", "Big", content, { updatedAt: UPDATED_AT });
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(5000); // generous: correctness, not a benchmark
    expect(headLines(out).slice(-5)).toEqual(block);
    expect(bodyOf(out)).toBe(injectContentWikilinks(body));
  });

  it("ignores a fence on line 300 (outside the scan window)", () => {
    const filler = Array.from({ length: 298 }, (_, i) => `k${i}: v`).join("\n");
    const content = `---\n${filler}\n---\n${"x".repeat(600_000)}`;
    const split = splitFrontmatter(content);
    expect(split.block).toBeNull();
    expect(split.malformedReason).toBe("no closing fence");
    const noFence = `# T\n${"y\n".repeat(298)}---\n${"x".repeat(600_000)}`;
    expect(splitFrontmatter(noFence)).toEqual({ block: null, body: noFence });
  });
});

describe("frontmatter merge — idempotence and the updated date", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const meta = {
    tags: ["sop", "two words"],
    relatedTo: ["NorthStar/goals.md"],
    condition: "scope:reporting",
    updatedAt: UPDATED_AT,
  };
  const content = [
    "---",
    'title: "Own"',
    "tags: [x, sop]",
    "updated: 2025-01-01",
    "owner: me",
    "---",
    "# Body with projects/foo/a.md",
    "",
  ].join("\n");

  it("is deterministic and a fixed point", () => {
    const path = "projects/x/notes/a.md";
    const once = toObsidianContent(path, "A", content, meta);
    expect(toObsidianContent(path, "A", content, meta)).toBe(once);
    const twice = toObsidianContent(path, "A", once, meta);
    expect(twice).toBe(once);
    expect(toObsidianContent(path, "A", twice, meta)).toBe(once);
    expect(once.match(/## Related/g)).toHaveLength(1);
    expect(once.match(/source_/g)).toHaveLength(2);
  });

  it("is a fixed point for a file without its own block", () => {
    const once = toObsidianContent("knowledge/a/b.md", "B", "plain body", meta);
    expect(toObsidianContent("knowledge/a/b.md", "B", once, meta)).toBe(once);
  });

  it("takes updated from updatedAt, not from today", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-01T12:00:00Z"));
    const a = toObsidianContent("notes/a.md", "A", "x", { updatedAt: UPDATED_AT });
    vi.setSystemTime(new Date("2027-02-03T12:00:00Z"));
    const b = toObsidianContent("notes/a.md", "A", "x", { updatedAt: UPDATED_AT });
    expect(a).toBe(b);
    expect(a).toContain("updated: 2026-10-16\n");
  });

  it("renders the timestamp as a Mexico City date and accepts ISO", () => {
    const early = toObsidianContent("n.md", "N", "x", { updatedAt: "2026-10-16 03:00:00" });
    expect(early).toContain("updated: 2026-10-15\n");
    const iso = toObsidianContent("n.md", "N", "x", { updatedAt: "2026-10-16T20:00:00.000Z" });
    expect(iso).toContain("updated: 2026-10-16\n");
  });

  it("falls back to today when updatedAt is absent or unparsable", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-12-24T18:00:00Z"));
    expect(toObsidianContent("n.md", "N", "x")).toContain("updated: 2026-12-24\n");
    expect(toObsidianContent("n.md", "N", "x", { updatedAt: "not a date" })).toContain(
      "updated: 2026-12-24\n",
    );
  });
});

describe("frontmatter merge — escaping", () => {
  it("escapes title, condition, path and quotes unsafe tags", () => {
    const out = toObsidianContent("projects/x/a\"b.md", 'a "b" \\ c\nd', "x", {
      condition: 'x "y"',
      tags: ["two words", "#hash", "-lead", "plain", "a:b"],
    });
    const lines = headLines(out);
    expect(lines).toContain('title: "a \\"b\\" \\\\ c\\nd"');
    expect(lines).toContain('condition: "x \\"y\\""');
    expect(lines).toContain('path: "projects/x/a\\"b.md"');
    expect(lines).toContain('parent: "[[projects/x/README]]"');
    expect(lines).toContain('tags: ["two words", "#hash", "-lead", plain, "a:b"]');
    assertStrictFrontmatter(out);
  });

  it("round-trips quoted tags through a second pass", () => {
    const meta = { tags: ['say "hi"', "it's", "back\\slash"] };
    const once = toObsidianContent("notes/a.md", "A", "x", meta);
    expect(toObsidianContent("notes/a.md", "A", once, meta)).toBe(once);
  });
});

describe("frontmatter merge — wikilinks stay in the body (R4)", () => {
  it("never rewrites the block", () => {
    const out = toObsidianContent(
      "notes/a.md",
      "A",
      "---\nsource: projects/foo/a.md\n---\nSee projects/foo/a.md\n",
    );
    expect(headLines(out)).toContain("source: projects/foo/a.md");
    expect(bodyOf(out)).toBe("See [[projects/foo/a|a]]\n");
  });

  it("leaves a path inside an open [[ ... ]] span alone", () => {
    const input = "Ver [[projects/a/knowledge/x.md|X]] hoy";
    expect(injectContentWikilinks(input)).toBe(input);
    const alias = "Ver [[projects/foo/a|ver projects/foo/a.md hoy]] y [[x| knowledge/k/y.md]]";
    expect(injectContentWikilinks(alias)).toBe(alias);
  });

  it("leaves paths glued to a longer token alone", () => {
    const url = "Ver https://github.com/o/r/blob/main/projects/x.md hoy";
    expect(injectContentWikilinks(url)).toBe(url);
    expect(injectContentWikilinks("Ver myprojects/foo.md")).toBe("Ver myprojects/foo.md");
  });

  it("wraps a plain path and keeps existing links and code spans", () => {
    expect(injectContentWikilinks("Ver projects/foo/a.md")).toBe("Ver [[projects/foo/a|a]]");
    const kept = "(projects/foo/a.md) [[projects/foo/a.md]] `projects/foo/a.md`";
    expect(injectContentWikilinks(kept)).toBe(kept);
    const once = injectContentWikilinks("a projects/foo/a.md b knowledge/k/x.md");
    expect(injectContentWikilinks(once)).toBe(once);
  });
});

describe("frontmatter merge — fixtures from several KB areas", () => {
  const fixtures: Array<{ path: string; content: string; section: string; parent: string | null }> = [
    { path: "projects/x/README.md", content: "# X\n\nResumen.\n", section: "projects", parent: null },
    { path: "projects/x/notes/a.md", content: "# Nota\n\n---\n\nmas\n", section: "projects", parent: "projects/x/README" },
    { path: "directives/core.md", content: "# Core\n\n- regla 1\n", section: "directives", parent: null },
    { path: "NorthStar/plan.md", content: "# Plan\n", section: "NorthStar", parent: null },
    { path: "knowledge/a/b.md", content: `---\n${MEMORY_BLOCK.join("\n")}\n---\n# B\n`, section: "knowledge", parent: "knowledge/a" },
    { path: "logs/day-logs/2026-10-16.md", content: "# 2026-10-16\n\n- hecho\n", section: "logs", parent: null },
    { path: "skills/x/SKILL.md", content: `---\n${SKILL_BLOCK.join("\n")}\n---\n# Skill\n`, section: "skills", parent: null },
    {
      path: "workspace/draft-post.md",
      content: '---\ntitle: "Mi borrador"\nslug: mi-borrador\ndescription: Un texto\ndraft: true\ntags: [blog, "ideas sueltas"]\n---\n\nTexto.\n',
      section: "workspace",
      parent: null,
    },
  ];

  for (const f of fixtures) {
    it(`${f.path}: section, parent, strict frontmatter, fixed point`, () => {
      const meta = { tags: ["kb"], updatedAt: UPDATED_AT };
      const out = toObsidianContent(f.path, "T", f.content, meta);
      const lines = headLines(out);
      expect(lines).toContain(`section: ${f.section}`);
      if (f.parent) expect(lines).toContain(`parent: "[[${f.parent}]]"`);
      else expect(lines.some((l) => l.startsWith("parent:"))).toBe(false);
      assertStrictFrontmatter(out);
      expect(toObsidianContent(f.path, "T", out, meta)).toBe(out);
    });
  }

  it("workspace draft keeps its keys and unions its tags", () => {
    const f = fixtures[fixtures.length - 1];
    const lines = headLines(toObsidianContent(f.path, "T", f.content, { tags: ["kb"] }));
    expect(lines).toContain('source_title: "Mi borrador"');
    expect(lines).toContain("slug: mi-borrador");
    expect(lines).toContain("draft: true");
    expect(lines).toContain('tags: [kb, blog, "ideas sueltas"]');
  });
});

// ---------------------------------------------------------------------------
// Bulk passes: pathPrefix / limit / updatedAt (in-memory DB, Drive mocked)
// ---------------------------------------------------------------------------
describe("reformatDriveFiles / backfillToDrive options", () => {
  const rows = [
    ["Skills/upper.md", "2026-10-01 12:00:00"],
    ["knowledge/a.md", "2026-10-02 12:00:00"],
    ["skills/a/SKILL.md", "2026-10-03 12:00:00"],
    ["skills/b/SKILL.md", "2026-10-04 12:00:00"],
    ["skills/c/SKILL.md", "2026-10-05 12:00:00"],
    ["skillsXa/odd.md", "2026-10-06 12:00:00"],
    ["skills_/odd.md", "2026-10-07 12:00:00"],
  ];

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    // initDatabase seeds directive rows through upsertFile -> syncToDrive;
    // those fire-and-forget calls fail against the reset mock: keep quiet.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    initDatabase(":memory:");
    const db = getDatabase();
    const ins = db.prepare(
      "INSERT INTO jarvis_files (id, path, title, content, updated_at) VALUES (?, ?, ?, ?, ?)",
    );
    for (const [path, at] of rows) ins.run(path, path, "T", "body", at);
    db.exec(
      "CREATE TABLE IF NOT EXISTS drive_file_map (path TEXT PRIMARY KEY, drive_id TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')))",
    );
    drive.googleFetch.mockReset();
  });

  afterEach(() => {
    closeDatabase();
    vi.restoreAllMocks();
  });

  function mapAll(): void {
    const ins = getDatabase().prepare("INSERT INTO drive_file_map (path, drive_id) VALUES (?, ?)");
    for (const [path] of rows) ins.run(path, `id-${path}`);
  }

  it("reformat: pathPrefix filters case-sensitively and limit caps by path order", async () => {
    mapAll();
    drive.googleFetch.mockResolvedValue({});
    const r = await reformatDriveFiles({ pathPrefix: "skills/", limit: 2 });
    expect(r).toEqual({ updated: 2, skipped: 0, failed: 0 });
    const urls = drive.googleFetch.mock.calls.map((c) => String(c[0]));
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain(encodeURI("id-skills/a/SKILL.md"));
    expect(urls[1]).toContain(encodeURI("id-skills/b/SKILL.md"));
    const body = String(drive.googleFetch.mock.calls[0][1].rawBody);
    expect(body).toContain("updated: 2026-10-03\n");
  });

  it("reformat: a prefix with LIKE wildcards matches literally", async () => {
    mapAll();
    drive.googleFetch.mockResolvedValue({});
    const r = await reformatDriveFiles({ pathPrefix: "skills_" });
    expect(r.updated).toBe(1);
    expect(String(drive.googleFetch.mock.calls[0][0])).toContain("id-skills_/odd.md");
  });

  it("reformat: no options processes every row", async () => {
    mapAll();
    drive.googleFetch.mockResolvedValue({});
    const r = await reformatDriveFiles();
    expect(r.updated).toBe(rows.length);
  });

  it("backfill: honours pathPrefix + limit and passes updated_at", async () => {
    drive.googleFetch.mockImplementation(async (url: string) =>
      url.includes("uploadType=multipart") ? { id: "new-id" } : { files: [{ id: "folder" }] },
    );
    const r = await backfillToDrive({ pathPrefix: "skills/", limit: 1 });
    expect(r).toEqual({ uploaded: 1, skipped: 0, failed: 0 });
    const uploads = drive.googleFetch.mock.calls.filter((c) =>
      String(c[0]).includes("uploadType=multipart"),
    );
    expect(uploads).toHaveLength(1);
    const body = String(uploads[0][1].rawBody);
    expect(body).toContain('path: "skills/a/SKILL.md"');
    expect(body).toContain("updated: 2026-10-03\n");
  });
});

// ---------------------------------------------------------------------------
// QA round 1 folds (W1-W3, I1, I2, window / fence / timezone mutants)
// ---------------------------------------------------------------------------
describe("QA fold W1 — leading comments and blanks stay leading (fixed point)", () => {
  const meta = { tags: ["kb"], updatedAt: UPDATED_AT };
  for (const content of [
    "---\n# only a comment\n---\nbody",
    "---\n# Heading\n---\nbody",
    "---\n\nk: v\n---\nb",
    "---\n# c1\n\n# c2\nk: v\n# trailing\n---\nb\n",
  ]) {
    it(`fixed point for ${JSON.stringify(content)}`, () => {
      const once = toObsidianContent("notes/a.md", "A", content, meta);
      expect(toObsidianContent("notes/a.md", "A", once, meta)).toBe(once);
      // Lead lines sit right after the opening fence, before the sync keys.
      const lead = content.split("\n").slice(1, content.split("\n").findIndex((l, i) => i > 0 && !/^(#.*)?$/.test(l)));
      expect(headLines(once).slice(0, lead.length)).toEqual(lead);
      assertStrictFrontmatter(once);
    });
  }
});

describe("QA fold W2 — open-span guard is linear", () => {
  // 5,000 paths in 300 KB stayed under 1 s even with the old per-match
  // rescan, so this uses the audit's measured shape (20,000 paths, 320 KB:
  // about 3.6 s before the fix) to go red without it.
  it("wraps 20,000 paths on one 320 KB line quickly", () => {
    const line = "projects/f/a.md ".repeat(20_000);
    expect(line.length).toBe(320_000);
    const t0 = performance.now();
    const out = injectContentWikilinks(line);
    const ms = performance.now() - t0;
    expect(out.match(/\[\[projects\/f\/a\|a\]\]/g)).toHaveLength(20_000);
    expect(ms).toBeLessThan(1000);
  });

  it("tracks spans across lines and multiple links on one line", () => {
    const input = "[[a|x\nver projects/foo/a.md\n[[b]] projects/foo/b.md [[c| projects/foo/c.md";
    expect(injectContentWikilinks(input)).toBe(
      "[[a|x\nver [[projects/foo/a|a]]\n[[b]] [[projects/foo/b|b]] [[c| projects/foo/c.md",
    );
  });
});

describe("QA fold W3 — merged block stays valid YAML", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects a column-0 list item after a scalar value", () => {
    const content = "---\nname: x\n- a\n---\nbody\n";
    const split = splitFrontmatter(content);
    expect(split.block).toBeNull();
    expect(split.malformedReason).toMatch(/^line 3: list item after a scalar value/);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = toObsidianContent("notes/a.md", "A", content);
    expect(out).toContain(content);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("accepts a column-0 list item after an empty key (or a key with only a comment)", () => {
    expect(splitFrontmatter("---\nitems:\n- a\n- b\n---\n").block).toEqual(["items:", "- a", "- b"]);
    expect(splitFrontmatter("---\nitems: # list\n- a\n---\n").block).not.toBeNull();
  });

  it("rejects a plain value containing ': ' or ending in ':'", () => {
    for (const bad of ["description: foo: bar", "label: ends:", "note: x: y # c"]) {
      const split = splitFrontmatter(`---\n${bad}\n---\nb`);
      expect(split.block, bad).toBeNull();
      expect(split.malformedReason).toMatch(/^line 2: plain value/);
    }
  });

  it("accepts quoted, flow and block-scalar values that contain ': '", () => {
    const ok = [
      'description: "foo: bar"',
      "summary: 'a: b # c'",
      "map: {a: b}",
      "tags: [\"a: b\"]",
      "body: |",
      "  line one: with colon",
      "  # not a comment, scalar text",
      "folded: >",
      "  more: text",
    ];
    const split = splitFrontmatter(`---\n${ok.join("\n")}\n---\nb`);
    expect(split.malformedReason).toBeUndefined();
    expect(split.block).toEqual(ok);
    const meta = { tags: ["a: b"], updatedAt: UPDATED_AT };
    const once = toObsidianContent("notes/a.md", "A", `---\n${ok.join("\n")}\n---\nb`, meta);
    expect(toObsidianContent("notes/a.md", "A", once, meta)).toBe(once);
  });
});

describe("QA fold I1 — non-string sync tags", () => {
  it("coerces tags to strings (dedupe against file tags, no throw)", () => {
    const meta = { tags: [5, null, {}] as unknown as string[] };
    let out = "";
    expect(() => {
      out = toObsidianContent("notes/a.md", "A", "---\ntags: [5]\n---\nb", meta);
    }).not.toThrow();
    expect(headLines(out)).toContain('tags: [5, null, "[object Object]"]');
  });
});

describe("QA fold I2 — underscore italics", () => {
  it("wraps a path wrapped in underscore italics", () => {
    expect(injectContentWikilinks("ver _projects/x.md_ hoy")).toBe("ver _[[projects/x|x]]_ hoy");
  });
});

describe("QA mutants — scan window, '...' fence, UTC parse", () => {
  const block = (n: number): string =>
    Array.from({ length: n }, (_, i) => `k${i}: v`).join("\n");

  it("detects a 150-line block and rejects a 250-line one", () => {
    expect(splitFrontmatter(`---\n${block(150)}\n---\nb`).block).toHaveLength(150);
    expect(splitFrontmatter(`---\n${block(199)}\n---\nb`).block).toHaveLength(199);
    expect(splitFrontmatter(`---\n${block(250)}\n---\nb`).malformedReason).toBe("no closing fence");
  });

  it("accepts '...' as the closing fence", () => {
    expect(splitFrontmatter("---\nk: v\n...\nbody")).toEqual({ block: ["k: v"], body: "body" });
  });

  it("parses SQLite timestamps as UTC whatever the process TZ", () => {
    const saved = process.env.TZ;
    try {
      process.env.TZ = "Asia/Tokyo";
      const at = (u: string): string =>
        toObsidianContent("n.md", "N", "x", { updatedAt: u }).match(/updated: (\S+)/)?.[1] ?? "";
      expect(at("2026-10-16 03:00:00")).toBe("2026-10-15");
      expect(at("2026-10-16 07:00:00")).toBe("2026-10-16");
      expect(at("2026-10-16 23:30:00")).toBe("2026-10-16");
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });
});

describe("QA round 2 fold F1 — one-line value validity", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const cases: Array<[string, RegExp]> = [
    ["key: [unclosed", /unclosed flow value/],
    ["key: {a: [b}", /unclosed flow value/],
    ['key: "unterminated', /unterminated double-quoted value/],
    ['key: "esc \\" still open', /unterminated double-quoted value/],
    ["key: 'open", /unterminated single-quoted value/],
    ["key: 'it's'", /text after a quoted or flow value/],
    ['key: "a" b: c', /text after a quoted or flow value/],
    ['key: "a"# no space', /text after a quoted or flow value/],
    ["key: [a] b", /text after a quoted or flow value/],
    ["key: >foo", /bad block scalar header/],
  ];
  for (const [line, reason] of cases) {
    it(`rejects ${JSON.stringify(line)} and keeps the whole content as body`, () => {
      const content = `---\n${line}\n---\nbody\n`;
      const split = splitFrontmatter(content);
      expect(split.block).toBeNull();
      expect(split.malformedReason).toMatch(reason);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const out = toObsidianContent("notes/a.md", "A", content);
      expect(out).toContain(content);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(/^\[drive-sync\] frontmatter ignored for notes\/a\.md: line 2: /);
    });
  }

  it("rejects an indented line after a plain or quoted scalar", () => {
    for (const head of ["name: x", 'name: "x"', "name: [x]"]) {
      const split = splitFrontmatter(`---\n${head}\n  sub: y\n---\nb`);
      expect(split.block, head).toBeNull();
      expect(split.malformedReason).toMatch(/^line 3: indented line after a scalar value/);
    }
  });

  it("accepts the valid shapes", () => {
    const ok = [
      'quoted: "say \\"hi\\" there" # trailing comment',
      "single: 'it''s fine'",
      "outer:",
      "  middle:",
      "    inner:",
      "      leaf: 1",
      "text: |-",
      "  first line: with colon",
      "",
      "  second line",
      "folded: >2 # header comment",
      "  more",
      "tags: [\"a: b\", 'c']",
      "flow: {k: [1, 2], s: \"x]\"}",
      "plain: it's [not] {flow}",
      "apos: [it's, fine]",
    ];
    const split = splitFrontmatter(`---\n${ok.join("\n")}\n---\nb`);
    expect(split.malformedReason).toBeUndefined();
    expect(split.block).toEqual(ok);
    const meta = { tags: ["kb"], updatedAt: UPDATED_AT };
    const once = toObsidianContent("notes/a.md", "A", `---\n${ok.join("\n")}\n---\nb`, meta);
    // The file's tags entry is unioned into the sync tags line; the rest is verbatim.
    const fileOwn = ok.filter((l) => !l.startsWith("tags:"));
    expect(headLines(once).slice(-fileOwn.length)).toEqual(fileOwn);
    expect(headLines(once)).toContain('tags: [kb, "a: b", c]');
    expect(toObsidianContent("notes/a.md", "A", once, meta)).toBe(once);
  });

  it("accepts our own emitted output (fixed point with escapes and quoted tags)", () => {
    const meta = {
      tags: ['say "hi"', "it's", "a: b", "[x]", "back\\slash"],
      condition: 'scope:"x" # y',
      relatedTo: ["NorthStar/goals.md"],
      updatedAt: UPDATED_AT,
    };
    const once = toObsidianContent("projects/x/a.md", 'T "q" \\ n\nl', "---\nk: v\n---\nb", meta);
    const split = splitFrontmatter(once);
    expect(split.malformedReason).toBeUndefined();
    expect(split.block).not.toBeNull();
    expect(toObsidianContent("projects/x/a.md", 'T "q" \\ n\nl', once, meta)).toBe(once);
  });
});

describe("QA round 2 fold F2 — a plain value may carry a comment", () => {
  it("accepts and keeps 'key: foo # comment' and 'key: a #b' verbatim (fixed point)", () => {
    const lines = ["key: foo # comment", "other: a #b", "third: x # see: this"];
    const content = `---\n${lines.join("\n")}\n---\nbody\n`;
    expect(splitFrontmatter(content).block).toEqual(lines);
    const meta = { updatedAt: UPDATED_AT };
    const once = toObsidianContent("notes/a.md", "A", content, meta);
    expect(headLines(once).slice(-3)).toEqual(lines);
    expect(toObsidianContent("notes/a.md", "A", once, meta)).toBe(once);
  });
});

describe("QA round 3 — block scalar list item and flow-quote escapes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects a column-0 list item after a block scalar header", () => {
    const content = "---\nkey: |\n- item\n---\nbody\n";
    const split = splitFrontmatter(content);
    expect(split.block).toBeNull();
    expect(split.malformedReason).toMatch(/^line 3: list item after a scalar value/);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = toObsidianContent("notes/a.md", "A", content);
    expect(out).toContain(content);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("accepts an escaped double quote inside a flow item", () => {
    const content = '---\ntags: [a, "b\\"]"]\n---\nbody\n';
    expect(splitFrontmatter(content).malformedReason).toBeUndefined();
    const out = toObsidianContent("notes/a.md", "A", content, { tags: ["kb"] });
    expect(headLines(out)).toContain('tags: [kb, a, "b\\"]"]');
  });

  it("accepts a single-quote escape inside a flow item", () => {
    const content = "---\ntags: ['it''s]', b]\n---\nbody\n";
    expect(splitFrontmatter(content).malformedReason).toBeUndefined();
    const out = toObsidianContent("notes/a.md", "A", content, { tags: ["kb"] });
    expect(headLines(out)).toContain('tags: [kb, "it\'s]", b]');
  });
});

// ---------------------------------------------------------------------------
// Queue 4a — Drive writes refuse unless the open db is the live mc.db
// ---------------------------------------------------------------------------
describe("Drive live-db guard", () => {
  const DISABLED = "[drive-sync] Drive sync DISABLED for this process";
  const flush = () => new Promise((r) => setTimeout(r, 0));
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    drive.googleFetch.mockReset();
    drive.googleFetch.mockImplementation(async (url: string) =>
      url.includes("uploadType=multipart") ? { id: "new-id" } : { files: [{ id: "folder" }] },
    );
  });

  afterEach(() => {
    drive.isLive = true;
    closeDatabase();
    vi.restoreAllMocks();
  });

  it("predicate false: no write path calls googleFetch and DISABLED logs once", async () => {
    // A fresh module instance, so the once-per-process flag starts unset.
    vi.resetModules();
    const ds = await import("./drive-sync.js");
    const idx = await import("./index.js");
    const liveDb = await import("./live-db.js");
    drive.isLive = false;
    idx.initDatabase(":memory:");
    const db = idx.getDatabase();
    db.prepare(
      "INSERT INTO jarvis_files (id, path, title, content) VALUES ('x', 'knowledge/x.md', 'X', 'body')",
    ).run();
    db.exec(
      "CREATE TABLE IF NOT EXISTS drive_file_map (path TEXT PRIMARY KEY, drive_id TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')))",
    );
    db.prepare("INSERT OR REPLACE INTO drive_file_map (path, drive_id) VALUES ('knowledge/x.md', 'id-x')").run();
    // No mockClear: initDatabase's seed upserts (-> syncToDrive) count too.

    for (let round = 0; round < 2; round++) {
      ds.syncToDrive("knowledge/new.md", "New", "body");
      ds.syncToDrive("knowledge/x.md", "X", "body");
      ds.syncDeleteToDrive("knowledge/x.md");
      expect(await ds.backfillToDrive()).toEqual({ uploaded: 0, skipped: 0, failed: 0, refused: true });
      expect(await ds.reformatDriveFiles()).toEqual({ updated: 0, skipped: 0, failed: 0, refused: true });
      await flush();
    }

    expect(drive.googleFetch).not.toHaveBeenCalled();
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith(DISABLED));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("is not the live /root/claude/mission-control/data/mc.db");
    // Bulk passes log their refusal on EVERY call (the admin route's caller
    // must not read all-zero counts as "nothing to do").
    const all = warn.mock.calls.map((c) => String(c[0]));
    expect(all.filter((l) => l.startsWith("[drive-sync] backfillToDrive REFUSED"))).toHaveLength(2);
    expect(all.filter((l) => l.startsWith("[drive-sync] reformatDriveFiles REFUSED"))).toHaveLength(2);
    // The guard asks the shared predicate about the live path, not a copy of it.
    expect(liveDb.isLiveDatabaseFile).toHaveBeenCalledWith(
      expect.any(String),
      liveDb.LIVE_DB_PATH,
    );
    // The map row is untouched (the trash path did not run).
    expect(
      db.prepare("SELECT drive_id FROM drive_file_map WHERE path = 'knowledge/x.md'").get(),
    ).toEqual({ drive_id: "id-x" });
    idx.closeDatabase(); // the fresh instance's db; afterEach closes the original's
  });

  it("predicate true: syncToDrive creates and syncDeleteToDrive trashes as before", async () => {
    drive.isLive = true;
    initDatabase(":memory:");
    await flush(); // let the seed's fire-and-forget calls settle
    drive.googleFetch.mockClear();
    warn.mockClear();

    syncToDrive("knowledge/guard/new.md", "New", "body");
    await vi.waitFor(() => {
      const posts = drive.googleFetch.mock.calls.filter((c) =>
        String(c[0]).includes("uploadType=multipart"),
      );
      expect(posts).toHaveLength(1);
    });
    const db = getDatabase();
    expect(
      db.prepare("SELECT drive_id FROM drive_file_map WHERE path = 'knowledge/guard/new.md'").get(),
    ).toEqual({ drive_id: "new-id" });

    drive.googleFetch.mockClear();
    syncDeleteToDrive("knowledge/guard/new.md");
    await vi.waitFor(() => expect(drive.googleFetch).toHaveBeenCalledTimes(1));
    const [url, init] = drive.googleFetch.mock.calls[0];
    expect(String(url)).toContain("/files/new-id");
    expect(init).toEqual({ method: "PATCH", body: { trashed: true } });
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith(DISABLED));
    expect(lines).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2026-10-20 — operator scripts drain Drive writes before closeDatabase
// ---------------------------------------------------------------------------
describe("settleDriveSyncs / findFolder / map helpers", () => {
  const ticks = async (n: number) => {
    for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
  };

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    drive.isLive = true;
    drive.googleFetch.mockReset();
    drive.googleFetch.mockImplementation(async (url: string) =>
      url.includes("uploadType=multipart") ? { id: "seed-id" } : { files: [{ id: "folder" }] },
    );
    initDatabase(":memory:");
  });

  afterEach(() => {
    closeDatabase();
    vi.restoreAllMocks();
  });

  it("resolves only after an in-flight CREATE has recorded its drive_file_map row", async () => {
    await settleDriveSyncs(); // the seed upserts' syncs
    let upload!: (v: { id: string }) => void;
    drive.googleFetch.mockImplementation((url: string) =>
      url.includes("uploadType=multipart")
        ? new Promise((r) => (upload = r))
        : Promise.resolve({ files: [{ id: "folder" }] }),
    );
    syncToDrive("knowledge/settle/new.md", "New", "body");
    let settled = false;
    const done = settleDriveSyncs().then(() => (settled = true));
    await vi.waitFor(() => expect(upload).toBeTypeOf("function"));
    await ticks(20);
    expect(settled).toBe(false);
    expect(getDriveMapEntry("knowledge/settle/new.md")).toBeNull();
    upload({ id: "created-id" });
    await done;
    expect(getDriveMapEntry("knowledge/settle/new.md")?.driveId).toBe("created-id");
  });

  it("waits for a CREATE started while it is already waiting", async () => {
    await settleDriveSyncs();
    const uploads: Array<(v: { id: string }) => void> = [];
    drive.googleFetch.mockImplementation((url: string) =>
      url.includes("uploadType=multipart")
        ? new Promise((r) => uploads.push(r))
        : Promise.resolve({ files: [{ id: "folder" }] }),
    );
    syncToDrive("knowledge/settle/a.md", "A", "body");
    let settled = false;
    const done = settleDriveSyncs().then(() => (settled = true));
    await vi.waitFor(() => expect(uploads).toHaveLength(1));
    syncToDrive("knowledge/settle/b.md", "B", "body");
    await vi.waitFor(() => expect(uploads).toHaveLength(2));
    uploads[0]!({ id: "id-a" });
    await ticks(20);
    expect(settled).toBe(false);
    expect(getDriveMapEntry("knowledge/settle/b.md")).toBeNull();
    uploads[1]!({ id: "id-b" });
    await done;
    expect(getDriveMapEntry("knowledge/settle/a.md")?.driveId).toBe("id-a");
    expect(getDriveMapEntry("knowledge/settle/b.md")?.driveId).toBe("id-b");
  });

  it("also waits for writes started while it is waiting, and for deletes", async () => {
    await settleDriveSyncs();
    recordDriveId("knowledge/settle/old.md", "old-id");
    let trash!: () => void;
    drive.googleFetch.mockImplementation((_url: string, init?: { body?: unknown }) =>
      init?.body && (init.body as { trashed?: boolean }).trashed
        ? new Promise((r) => (trash = () => r({})))
        : Promise.resolve({ files: [{ id: "folder" }] }),
    );
    syncDeleteToDrive("knowledge/settle/old.md");
    let settled = false;
    const done = settleDriveSyncs().then(() => (settled = true));
    await vi.waitFor(() => expect(trash).toBeTypeOf("function"));
    await ticks(20);
    expect(settled).toBe(false);
    trash();
    await done;
    expect(getDriveMapEntry("knowledge/settle/old.md")).toBeNull();
  });

  it("findFolder walks existing levels read-only and returns null on a missing one", async () => {
    drive.googleFetch.mockReset();
    drive.googleFetch.mockImplementation(async (url: string) => {
      const q = decodeURIComponent(url);
      if (q.includes("name='a' and 'kb-root-test' in parents")) return { files: [{ id: "id-a" }] };
      if (q.includes("name='b' and 'id-a' in parents")) return { files: [{ id: "id-b" }] };
      return { files: [] };
    });
    expect(await findFolder("")).toBe("kb-root-test");
    expect(await findFolder("a/b")).toBe("id-b");
    expect(await findFolder("a/missing")).toBeNull();
    expect(await findFolder("zz/b")).toBeNull();
    for (const [, init] of drive.googleFetch.mock.calls) expect(init).toBeUndefined(); // GETs only
  });

  it("searchFolder escapes ' and \\ in the folder name and asks oldest-first", async () => {
    drive.googleFetch.mockReset();
    drive.googleFetch.mockResolvedValue({ files: [] });
    expect(await findFolder("it's")).toBeNull();
    expect(await findFolder("back\\slash")).toBeNull();
    const urls = drive.googleFetch.mock.calls.map((c) => String(c[0]));
    const qs = urls.map((u) => decodeURIComponent(u));
    expect(qs[0]).toContain("name='it\\'s' and 'kb-root-test' in parents");
    expect(qs[1]).toContain("name='back\\\\slash' and 'kb-root-test' in parents");
    for (const u of urls) {
      expect(u).toContain("&orderBy=createdTime&pageSize=2");
      expect(u).not.toContain("pageSize=1");
    }
  });

  it("searchFolder: two same-named folders resolve to the oldest and warn once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    drive.googleFetch.mockReset();
    drive.googleFetch.mockResolvedValue({ files: [{ id: "id-old" }, { id: "id-new" }] });
    expect(await findFolder("dup")).toBe("id-old");
    const dupWarns = warn.mock.calls.filter((c) => String(c[0]).includes("duplicate Drive folder"));
    expect(dupWarns).toHaveLength(1);
    expect(String(dupWarns[0]![0])).toBe(
      '[drive-sync] duplicate Drive folder name="dup" parent=kb-root-test: using oldest id=id-old, also found id=id-new',
    );
    warn.mockRestore();
  });

  it("searchFolder: one folder, no duplicate warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    drive.googleFetch.mockReset();
    drive.googleFetch.mockResolvedValue({ files: [{ id: "id-only" }] });
    expect(await findFolder("single")).toBe("id-only");
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("duplicate Drive folder"))).toHaveLength(0);
    warn.mockRestore();
  });

  it("ensureFolder (via syncToDrive) files under the oldest of two duplicate folders", async () => {
    await settleDriveSyncs();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    drive.googleFetch.mockReset();
    drive.googleFetch.mockImplementation(async (url: string) => {
      if (url.includes("uploadType=multipart")) return { id: "file-dup" };
      if (url.includes("vnd.google-apps.folder")) return { files: [{ id: "dup-old" }, { id: "dup-new" }] };
      return { files: [] };
    });
    syncToDrive("dupfold/x.md", "X", "body");
    await settleDriveSyncs();
    const upload = drive.googleFetch.mock.calls.find((c) => String(c[0]).includes("uploadType=multipart"));
    expect(String(upload?.[1]?.rawBody)).toContain('"parents":["dup-old"]');
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("duplicate Drive folder"))).toHaveLength(1);
    warn.mockRestore();
  });

  /** Fake Drive for folder creation: every folder search misses; folder POSTs are counted. */
  function folderCreateDrive(
    opts: { failFirstCreate?: boolean; attempts?: string[]; onCreate?: (name: string) => void } = {},
  ) {
    const folderPosts: string[] = [];
    let fail = opts.failFirstCreate ?? false;
    drive.googleFetch.mockReset();
    drive.googleFetch.mockImplementation(async (url: string, init?: { body?: { mimeType?: string; name?: string } }) => {
      await ticks(2);
      if (url.includes("uploadType=multipart")) return { id: `file-${Math.random()}` };
      if (init?.body?.mimeType === "application/vnd.google-apps.folder") {
        opts.attempts?.push(init.body.name!);
        opts.onCreate?.(init.body.name!);
        if (fail) {
          fail = false;
          throw new Error("500 create failed");
        }
        folderPosts.push(init.body.name!);
        return { id: `folder-${init.body.name}-${folderPosts.length}` };
      }
      return { files: [] };
    });
    return folderPosts;
  }
  const uploadParents = () =>
    drive.googleFetch.mock.calls
      .filter((c) => String(c[0]).includes("uploadType=multipart"))
      .map((c) => /"parents":\["([^"]+)"\]/.exec(String(c[1]?.rawBody))?.[1]);

  it("ensureFolder: two concurrent writes under one new directory create it ONCE", async () => {
    await settleDriveSyncs();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const folderPosts = folderCreateDrive();
    syncToDrive("concnew/sub/a.md", "A", "body");
    syncToDrive("concnew/sub/b.md", "B", "body");
    await settleDriveSyncs();
    expect(folderPosts).toEqual(["concnew", "sub"]);
    expect(uploadParents()).toEqual(["folder-sub-2", "folder-sub-2"]);
    vi.restoreAllMocks();
  });

  it("ensureFolder: a LATE caller arriving just after the create settled reuses the folder (no gap between map and cache)", async () => {
    await settleDriveSyncs();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let late = false;
    const folderPosts = folderCreateDrive({
      onCreate: (name) => {
        if (name !== "sub" || late) return;
        late = true;
        // Runs after this create's promise chain has settled (well past ensureFolder's
        // .then handler) but before any timer tick.
        let p: Promise<void> = Promise.resolve();
        for (let i = 0; i < 30; i++) p = p.then(() => {});
        void p.then(() => syncToDrive("concnew2/sub/c.md", "C", "body"));
      },
    });
    syncToDrive("concnew2/sub/a.md", "A", "body");
    syncToDrive("concnew2/sub/b.md", "B", "body");
    await settleDriveSyncs();
    expect(late).toBe(true);
    expect(folderPosts).toEqual(["concnew2", "sub"]);
    expect(uploadParents()).toEqual(["folder-sub-2", "folder-sub-2", "folder-sub-2"]);
    vi.restoreAllMocks();
  });

  it("ensureFolder: concurrent writes share ONE rejected create; a later write creates it once", async () => {
    await settleDriveSyncs();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const attempts: string[] = [];
    const folderPosts = folderCreateDrive({ failFirstCreate: true, attempts });
    syncToDrive("sharedfail/a.md", "A", "body");
    syncToDrive("sharedfail/b.md", "B", "body");
    await settleDriveSyncs();
    expect(attempts).toEqual(["sharedfail"]);
    expect(uploadParents()).toEqual([]);
    const failed = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[drive-sync] Failed for"));
    expect(failed).toEqual(["[drive-sync] Failed for sharedfail/a.md:", "[drive-sync] Failed for sharedfail/b.md:"]);
    syncToDrive("sharedfail/c.md", "C", "body");
    await settleDriveSyncs();
    expect(attempts).toEqual(["sharedfail", "sharedfail"]);
    expect(folderPosts).toEqual(["sharedfail"]);
    expect(uploadParents()).toEqual(["folder-sharedfail-1"]);
    vi.restoreAllMocks();
  });

  it("ensureFolder: a rejected folder create does not poison the next attempt", async () => {
    await settleDriveSyncs();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const folderPosts = folderCreateDrive({ failFirstCreate: true });
    syncToDrive("retrynew/a.md", "A", "body");
    await settleDriveSyncs();
    expect(folderPosts).toEqual([]);
    expect(uploadParents()).toEqual([]);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("Failed for retrynew/a.md"))).toBe(true);
    syncToDrive("retrynew/b.md", "B", "body");
    await settleDriveSyncs();
    expect(folderPosts).toEqual(["retrynew"]);
    expect(uploadParents()).toEqual(["folder-retrynew-1"]);
    vi.restoreAllMocks();
  });

  it("searchFolder follows nextPageToken past an empty page (bounded), and an empty last page is missing", async () => {
    drive.googleFetch.mockReset();
    drive.googleFetch.mockImplementation(async (url: string) => {
      const q = decodeURIComponent(url);
      if (q.includes("name='paged'")) {
        return q.includes("pageToken=a+b/c=") ? { files: [{ id: "id-paged" }] } : { files: [], nextPageToken: "a+b/c=" };
      }
      if (q.includes("name='endless'")) return { files: [], nextPageToken: "tok-more" };
      return { files: [] };
    });
    expect(await findFolder("paged")).toBe("id-paged");
    expect(decodeURIComponent(String(drive.googleFetch.mock.calls[0]![0]))).toContain("&fields=nextPageToken,files(id,name)&");
    expect(drive.googleFetch).toHaveBeenCalledTimes(2);
    expect(String(drive.googleFetch.mock.calls[1]![0])).toContain("&pageToken=a%2Bb%2Fc%3D");

    drive.googleFetch.mockClear();
    expect(await findFolder("emptyend")).toBeNull();
    expect(drive.googleFetch).toHaveBeenCalledTimes(1);

    drive.googleFetch.mockClear();
    expect(await findFolder("endless")).toBeNull();
    expect(drive.googleFetch).toHaveBeenCalledTimes(5);
  });

  it("getDriveMapEntry reads without creating the table; recordDriveId creates + upserts", () => {
    const db = getDatabase();
    db.exec("DROP TABLE IF EXISTS drive_file_map");
    expect(getDriveMapEntry("knowledge/x.md")).toBeNull();
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'drive_file_map'").get(),
    ).toBeUndefined();
    recordDriveId("knowledge/x.md", "id-1");
    recordDriveId("knowledge/x.md", "id-2");
    expect(getDriveMapEntry("knowledge/x.md")).toMatchObject({ driveId: "id-2" });
    expect(getDriveMapEntry("knowledge/x.md")?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2} /);
  });
});
