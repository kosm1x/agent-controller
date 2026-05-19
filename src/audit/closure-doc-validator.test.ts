/**
 * v7.7 Spine 1 Phase 2c — closure-doc validator tests.
 *
 * Heuristic markdown parsers are notoriously edge-case-leaky; this test
 * suite covers the cases that bit during convention authoring + the
 * realistic shapes of v7.5/v7.6 closure docs.
 */

import { describe, it, expect } from "vitest";
import {
  validateClosureDoc,
  renderReport,
  isScoreboardHeading,
  isClaimCandidate,
  isCitationLine,
  findAdjacentCitation,
} from "./closure-doc-validator.js";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("isScoreboardHeading", () => {
  it("matches the canonical patterns", () => {
    expect(isScoreboardHeading("## Scoreboard")).toBe(true);
    expect(isScoreboardHeading("## Ship summary")).toBe(true);
    expect(isScoreboardHeading("### Final tally")).toBe(true);
    expect(isScoreboardHeading("## Bundle scope")).toBe(true);
    expect(isScoreboardHeading("### Final scoreboard")).toBe(true);
    expect(isScoreboardHeading("## Closure criteria")).toBe(true);
    expect(isScoreboardHeading("## Spine-by-spine evidence")).toBe(true);
    expect(isScoreboardHeading("## Audit scoreboard")).toBe(true);
    expect(isScoreboardHeading("## v7.6 scoreboard")).toBe(true);
  });

  it("does NOT match narrative headings", () => {
    expect(isScoreboardHeading("## Status")).toBe(false);
    expect(isScoreboardHeading("## Cross-references")).toBe(false);
    expect(isScoreboardHeading("## Recommended entry point")).toBe(false);
    expect(isScoreboardHeading("## Three patterns observed")).toBe(false);
  });
});

describe("isClaimCandidate", () => {
  it("flags numbers with units", () => {
    expect(isClaimCandidate("- 188 tools annotated")).toBe(true);
    expect(isClaimCandidate("Tests: 4912 passing")).toBe(true);
    expect(isClaimCandidate("- 10 days from open")).toBe(true);
  });

  it("flags LOC claims", () => {
    expect(isClaimCandidate("+1041 / -25 LOC")).toBe(true);
    expect(isClaimCandidate("- +817 LOC across 13 files")).toBe(true);
  });

  it("flags percentages", () => {
    expect(isClaimCandidate("- 33% catch rate")).toBe(true);
    expect(isClaimCandidate("- 4.0% utility")).toBe(true);
  });

  it("flags monetary amounts", () => {
    expect(isClaimCandidate("- $0.06/turn cost")).toBe(true);
    expect(isClaimCandidate("- Recaudamos $50,000 MXN")).toBe(true);
  });

  it("flags commit-like SHAs", () => {
    expect(isClaimCandidate("- shipped in commit `8c371fe`")).toBe(true);
    expect(isClaimCandidate("Closure commits: ebf68c0, 973254c, 8c371fe")).toBe(
      true,
    );
  });

  it("flags shipped/added verbs", () => {
    expect(isClaimCandidate("- Phase 2b SHIPPED 2026-05-19")).toBe(true);
    expect(isClaimCandidate("- Added submit_report tool")).toBe(true);
  });

  it("does NOT flag narrative prose", () => {
    expect(isClaimCandidate("This was an architectural fix.")).toBe(false);
    expect(isClaimCandidate("The lesson is to instrument first.")).toBe(false);
    expect(isClaimCandidate("- run the audit before tagging")).toBe(false);
  });

  it("does NOT flag headers, comments, code fences", () => {
    expect(isClaimCandidate("# Heading 1")).toBe(false);
    expect(isClaimCandidate("## Spine 1 — Self-audit")).toBe(false);
    expect(isClaimCandidate("<!-- AUDIT: required -->")).toBe(false);
    expect(isClaimCandidate("```")).toBe(false);
  });

  it("does NOT flag verified_against citation lines (they're not claims)", () => {
    expect(
      isClaimCandidate(
        "  verified_against: { type: git, sha: 8c371fee123... }",
      ),
    ).toBe(false);
  });

  it("does NOT flag blockquotes", () => {
    expect(isClaimCandidate("> 33% catch rate")).toBe(false);
  });

  it("does NOT flag table separator rows", () => {
    expect(isClaimCandidate("|---|---|---|")).toBe(false);
    expect(isClaimCandidate("| --- | --- |")).toBe(false);
  });

  it("does NOT flag forward-looking TODO/pending lines", () => {
    expect(isClaimCandidate("- TODO: 5 more tests")).toBe(false);
    expect(isClaimCandidate("- TBD: 188 tools target")).toBe(false);
    expect(isClaimCandidate("- 12 items pending")).toBe(false);
    expect(isClaimCandidate("- 3 sprints in progress")).toBe(false);
  });

  it("does NOT flag cron/schedule lines (not closure claims)", () => {
    expect(isClaimCandidate("- runs every 60 seconds")).toBe(false);
    expect(isClaimCandidate("- schedule: every 5 minutes")).toBe(false);
  });

  it("R1-W1 regression: cron/schedule exclusion uses word boundaries", () => {
    // Operator-precedence guard: \b binds to ALL alternatives, otherwise
    // `schedule` matched anywhere via substring. "Scheduled E2E runs: 12"
    // is a legitimate scoreboard claim and must NOT be excluded.
    expect(isClaimCandidate("- Scheduled E2E runs: 12 passing")).toBe(true);
    expect(isClaimCandidate("- 5 rescheduled jobs landed")).toBe(true);
  });
});

describe("isCitationLine", () => {
  it("matches verified_against: prefix", () => {
    expect(
      isCitationLine("  verified_against: { type: git, sha: abc... }"),
    ).toBe(true);
    expect(isCitationLine("verified_against:{type:git,sha:abc}")).toBe(true);
    expect(isCitationLine("VERIFIED_AGAINST: ...")).toBe(true);
  });

  it("matches inline citation in table cells", () => {
    expect(
      isCitationLine(
        "| Tests | 4941 | { type: tool_output, tool_name: vitest, ... } |",
      ),
    ).toBe(true);
  });

  it("matches all 8 citation types", () => {
    for (const t of [
      "git",
      "sqlite",
      "file",
      "cost_ledger",
      "journal",
      "recall_audit",
      "http",
      "tool_output",
    ]) {
      expect(isCitationLine(`| x | y | { type: ${t}, ... } |`)).toBe(true);
    }
  });

  it("does NOT match prose mentioning verified_against", () => {
    // Plain reference in narrative without colon
    expect(isCitationLine("the verified against pattern is...")).toBe(false);
  });
});

describe("findAdjacentCitation", () => {
  it("matches same-line citation (table form)", () => {
    const lines = [
      "| Tests | 4941 | { type: tool_output, tool_name: vitest, ... } |",
    ];
    expect(findAdjacentCitation(lines, 0)).toBe(true);
  });

  it("matches citation 1 line below claim", () => {
    const lines = [
      "- 188 tools annotated",
      "  verified_against: { type: sqlite, query_sha: ..., row_count: 188 }",
    ];
    expect(findAdjacentCitation(lines, 0)).toBe(true);
  });

  it("matches citation 3 lines below claim (radius cap)", () => {
    const lines = [
      "- 188 tools annotated",
      "",
      "  (some context)",
      "  verified_against: { type: sqlite, ... }",
    ];
    expect(findAdjacentCitation(lines, 0)).toBe(true);
  });

  it("does NOT match citation 5 lines below (out of radius)", () => {
    const lines = [
      "- 188 tools annotated",
      "",
      "",
      "",
      "",
      "  verified_against: { type: sqlite, ... }",
    ];
    expect(findAdjacentCitation(lines, 0)).toBe(false);
  });

  it("returns false when no citation exists", () => {
    const lines = ["- 188 tools annotated", "- 4912 tests"];
    expect(findAdjacentCitation(lines, 0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration: full doc validation
// ---------------------------------------------------------------------------

describe("validateClosureDoc — clean doc", () => {
  it("returns exit 0 with no unverified when every claim is cited", () => {
    const md = `# V7.7-CLOSURE

## Status

Closed.

## Scoreboard

| Metric | Value | verified_against |
|---|---|---|
| Tests | 4941 passing | { type: tool_output, tool_name: vitest, call_id: x, output_sha256: y, queried_at: z } |
| Tools | 249 live | { type: tool_output, tool_name: mc-ctl, call_id: x, output_sha256: y, queried_at: z } |

## Cross-references

The lesson is to instrument first.
`;
    const report = validateClosureDoc("test.md", md);
    expect(report.exitCode).toBe(0);
    expect(report.unverifiedClaims.length).toBe(0);
    expect(report.totalClaims).toBe(2);
    expect(report.scoreboardSections).toBe(1);
  });

  it("recognizes adjacent verified_against form (not inline)", () => {
    const md = `## Scoreboard

- 188 tools annotated
  verified_against: { type: sqlite, query_sha: abc..., row_count: 188 }
- shipped in commit \`8c371fe\`
  verified_against: { type: git, sha: 8c371fee }
`;
    const report = validateClosureDoc("test.md", md);
    expect(report.exitCode).toBe(0);
    expect(report.unverifiedClaims.length).toBe(0);
  });
});

describe("validateClosureDoc — unverified claims", () => {
  it("flags claims without citations", () => {
    const md = `## Scoreboard

- 188 tools annotated
- 4912 tests passing
- shipped in commit \`8c371fe\`
`;
    const report = validateClosureDoc("test.md", md);
    expect(report.exitCode).toBe(1);
    expect(report.unverifiedClaims.length).toBe(3);
    expect(report.unverifiedClaims[0].line).toBe(3);
    expect(report.unverifiedClaims[0].text).toContain("188 tools");
  });

  it("flags mix: some cited, some not", () => {
    const md = `## Scoreboard

- 188 tools annotated
  verified_against: { type: sqlite, query_sha: abc, row_count: 188 }
- 4912 tests passing
- shipped in commit \`8c371fe\`
  verified_against: { type: git, sha: 8c371fee }
`;
    const report = validateClosureDoc("test.md", md);
    expect(report.exitCode).toBe(1);
    expect(report.unverifiedClaims.length).toBe(1);
    expect(report.unverifiedClaims[0].text).toContain("4912 tests");
  });
});

describe("validateClosureDoc — section-mode discipline", () => {
  it("does NOT scan claims outside scoreboard sections", () => {
    const md = `## Status

This phase shipped 4941 tests over 13 days. Commit 8c371fe was the last.

## Recommended next steps

5 more spines remain.
`;
    const report = validateClosureDoc("test.md", md);
    expect(report.exitCode).toBe(0);
    expect(report.totalClaims).toBe(0);
    expect(report.scoreboardSections).toBe(0);
  });

  it("exits scoreboard mode when a non-scoreboard top-level heading appears", () => {
    const md = `## Scoreboard

- 188 tools
  verified_against: { type: sqlite, query_sha: x, row_count: 188 }

## Three patterns observed

- 33% catch rate
- Lesson: instrument first
`;
    const report = validateClosureDoc("test.md", md);
    // The "33% catch rate" line is OUTSIDE scoreboard mode — should not flag.
    expect(report.exitCode).toBe(0);
    expect(report.totalClaims).toBe(1);
  });

  it("R1-W2 regression: ### Cross-references exits scoreboard mode (any depth, not just ##)", () => {
    const md = `## Scoreboard

| x | 1 | { type: file, path: x, sha256: y } |

### Cross-references

- See commit 8c371fe for context
`;
    const report = validateClosureDoc("test.md", md);
    // Without the fix, "8c371fe" under ### Cross-references (depth 3) would
    // stay in scoreboard mode and get flagged. With fix, ### exits scoreboard.
    expect(report.exitCode).toBe(0);
    expect(report.totalClaims).toBe(1); // only the table row
  });

  it("scoreboard subsections that ARE scoreboards stay in scoreboard mode", () => {
    const md = `## Scoreboard

### Final tally

- 188 tools
  verified_against: { type: sqlite, query_sha: x, row_count: 188 }
`;
    const report = validateClosureDoc("test.md", md);
    // "### Final tally" matches scoreboard pattern, so it enters/keeps scoreboard.
    expect(report.scoreboardSections).toBe(2); // ## Scoreboard + ### Final tally
    expect(report.totalClaims).toBe(1);
    expect(report.exitCode).toBe(0);
  });

  it("counts multiple scoreboard sections", () => {
    const md = `## Scoreboard

| x | 1 | { type: file, path: x, sha256: y } |

## Final tally

| y | 2 | { type: file, path: x, sha256: y } |

## Audit scoreboard

| z | 3 | { type: file, path: x, sha256: y } |
`;
    const report = validateClosureDoc("test.md", md);
    expect(report.scoreboardSections).toBe(3);
  });
});

describe("validateClosureDoc — markdown edge cases", () => {
  it("ignores claims inside code fences", () => {
    const md = `## Scoreboard

\`\`\`bash
$ wc -l src/audit/*.ts
188 src/audit/report-schema.ts
\`\`\`
`;
    const report = validateClosureDoc("test.md", md);
    expect(report.totalClaims).toBe(0);
    expect(report.exitCode).toBe(0);
  });

  it("ignores HTML comments", () => {
    const md = `## Scoreboard

<!-- 188 tools annotated -->
`;
    const report = validateClosureDoc("test.md", md);
    expect(report.totalClaims).toBe(0);
  });

  it("ignores table separator rows even though they contain dashes/numbers", () => {
    const md = `## Scoreboard

| Metric | Value | verified_against |
|---|---|---|
| Tests | 4941 | { type: tool_output, tool_name: vitest, call_id: x, output_sha256: y, queried_at: z } |
`;
    const report = validateClosureDoc("test.md", md);
    expect(report.exitCode).toBe(0);
    expect(report.totalClaims).toBe(1);
  });

  it("handles malformed markdown (unclosed code fence) without crashing", () => {
    const md = `## Scoreboard

\`\`\`
- 188 tools
- 4912 tests
`;
    // Unclosed fence — everything after the open ``` is treated as code,
    // so no claims fire. Acceptable behavior (fail-open on parser confusion).
    const report = validateClosureDoc("test.md", md);
    expect(report.exitCode).toBe(0);
    expect(report.totalClaims).toBe(0);
  });

  it("handles empty file", () => {
    const report = validateClosureDoc("test.md", "");
    expect(report.exitCode).toBe(0);
    expect(report.totalClaims).toBe(0);
    expect(report.scoreboardSections).toBe(0);
  });

  it("handles file with only a heading", () => {
    const report = validateClosureDoc("test.md", "# V7.7-CLOSURE\n");
    expect(report.exitCode).toBe(0);
  });

  it("handles file with only narrative (no scoreboard)", () => {
    const md = `# Closure

## Status

All went well.

## Three patterns

Lots of insights.
`;
    const report = validateClosureDoc("test.md", md);
    expect(report.exitCode).toBe(0);
    expect(report.scoreboardSections).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

describe("renderReport", () => {
  it("renders CLEAN message when no unverified claims", () => {
    const report = validateClosureDoc(
      "test.md",
      "## Scoreboard\n\n| x | 1 | { type: file, path: x, sha256: y } |\n",
    );
    const out = renderReport(report);
    expect(out).toContain("CLEAN");
    expect(out).toContain("test.md");
  });

  it("renders unverified claims with line numbers and section", () => {
    const md = `## Scoreboard

- 188 tools annotated
- 4912 tests passing
`;
    const report = validateClosureDoc("test.md", md);
    const out = renderReport(report);
    expect(out).toContain("UNVERIFIED CLAIMS");
    expect(out).toContain("L3");
    expect(out).toContain("L4");
    expect(out).toContain("188 tools");
    expect(out).toContain("4912 tests");
    expect(out).toContain("Scoreboard");
  });
});
