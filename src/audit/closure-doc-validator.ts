/**
 * v7.7 Spine 1 Phase 2c — closure-doc validator (library).
 *
 * Pure module: parses a CLOSURE.md string and returns a structured
 * `ValidationReport`. Identifies scoreboard sections, extracts metric or
 * factual claims, flags any claim lacking an adjacent `verified_against:`
 * citation per the convention in `docs/audit/CLOSURE-DOC-CONVENTION.md`.
 *
 * CLI wrapper: `scripts/validate-closure-doc.ts`.
 *
 * Design choice: claim detection is HEURISTIC (closure docs are free-form
 * markdown, not structured). The validator intentionally over-flags rather
 * than under-flags. A false-positive the author dismisses is cheaper than a
 * stale claim that ships.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UnverifiedClaim {
  /** 1-based line number in the source file */
  line: number;
  /** The full source line (trimmed) */
  text: string;
  /** Section heading the claim appears under (for grouping in the report) */
  section: string;
}

export interface ValidationReport {
  filePath: string;
  scoreboardSections: number;
  totalClaims: number;
  unverifiedClaims: UnverifiedClaim[];
  exitCode: 0 | 1 | 2;
  parseError?: string;
}

// ---------------------------------------------------------------------------
// Scoreboard detection
// ---------------------------------------------------------------------------

/**
 * Heading patterns that mark a section as a scoreboard. Match against the
 * heading text (case-insensitive, ignoring `## ` prefix). Conservative —
 * adding too many patterns risks over-flagging narrative sections.
 */
const SCOREBOARD_HEADING_PATTERNS = [
  /^scoreboard$/i,
  /^ship summary$/i,
  /^bundle scope$/i,
  /^final tally$/i,
  /^final scoreboard$/i,
  /^closure criteria$/i,
  /^spine-by-spine evidence$/i,
  /scoreboard/i, // catches "## Audit scoreboard", "## v7.6 scoreboard", etc.
  /scoring/i,
];

export function isScoreboardHeading(text: string): boolean {
  const trimmed = text.replace(/^#+\s*/, "").trim();
  return SCOREBOARD_HEADING_PATTERNS.some((p) => p.test(trimmed));
}

// ---------------------------------------------------------------------------
// Claim detection
// ---------------------------------------------------------------------------

/**
 * A line is a "scoreboard claim candidate" if it lives in a scoreboard
 * section AND contains at least one of these patterns:
 *   - A standalone number with a unit/context (e.g. "188 tools", "4912 tests")
 *   - A percentage ("85%")
 *   - A monetary amount ("$1,000")
 *   - A commit-sha-like 7+ hex string ("8c371fe")
 *   - A SHIPPED/ADDED/REMOVED verb followed by a measurement
 *   - A line in a markdown table whose first non-empty cell contains a claim
 *
 * Exempt: prose, section headers, bullet-only items, empty lines, citation
 * lines themselves (`verified_against:`), code-fence boundaries, blockquotes,
 * table-separator rows, forward-looking TODO/pending lines, cron descriptors.
 */
// Number with surrounding context: letter/%/$ for prose ("188 tools"), or
// a table-cell boundary `|` ("| 4941 |"). Without the `|` alternative, every
// table-row claim slips through.
const NUMBER_WITH_CONTEXT =
  /(?<!\d)(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(\+?\s*[a-zA-Z%$|])/;
const PERCENTAGE = /\b\d+(?:\.\d+)?%/;
const MONEY = /\$\s*\d+/;
const COMMIT_SHA = /\b[a-f0-9]{7,40}\b/;
const SHIPPED_VERB =
  /\b(shipped|added|removed|deleted|created|fixed|landed|closed|tagged)\b/i;
const LOC_CLAIM = /[+-]\d+\s*(?:\/\s*[-+]\d+\s*)?(?:LOC|lines?|loc)\b/i;

const EXCLUSION_PATTERNS = [
  /^\s*<!--/, // HTML comments
  /^\s*```/, // code fence boundaries
  /^\s*#{1,6}\s/, // markdown headings
  /^\s*verified_against\s*:/i, // citation lines themselves
  /^\s*>/, // blockquotes
  /^\s*\|[\s-]*\|/, // table separator rows
  /TODO|TBD|pending|in progress/i, // forward-looking
  // Operator-precedence guard: \b must bind to ALL alternatives, otherwise
  // `schedule` matches inside any word containing the substring (R1-W1).
  /\b(cron|schedule|interval|every\s+\d+)\b/i, // cron-like, not a claim
];

export function isClaimCandidate(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === "") return false;
  if (EXCLUSION_PATTERNS.some((p) => p.test(trimmed))) return false;

  const hasNumber =
    NUMBER_WITH_CONTEXT.test(trimmed) ||
    PERCENTAGE.test(trimmed) ||
    MONEY.test(trimmed) ||
    LOC_CLAIM.test(trimmed);
  const hasCommit = COMMIT_SHA.test(trimmed);
  const hasShippedVerb = SHIPPED_VERB.test(trimmed);

  return hasNumber || hasCommit || hasShippedVerb;
}

// ---------------------------------------------------------------------------
// Citation detection
// ---------------------------------------------------------------------------

/**
 * A line is a citation if it begins with `verified_against:` (any case,
 * any whitespace prefix), OR contains an inline citation matching the
 * grammar `{ type: <enum>, ... }`.
 */
const CITATION_PREFIX = /^\s*verified_against\s*:/i;
const CITATION_INLINE =
  /verified_against\s*:|\{\s*type\s*:\s*(git|sqlite|file|cost_ledger|journal|recall_audit|http|tool_output)\b/i;

export function isCitationLine(text: string): boolean {
  return CITATION_PREFIX.test(text) || CITATION_INLINE.test(text);
}

// ---------------------------------------------------------------------------
// Matching: claim → adjacent citation
// ---------------------------------------------------------------------------

/**
 * SEARCH_RADIUS — how many lines after a claim to scan for the adjacent
 * citation. 3 is conservative: a citation immediately after, or after one
 * comment line, or as part of the same table row.
 *
 * For table-row claims, the citation MAY be in the same line (when the
 * table has a dedicated `verified_against` column). The forward scan
 * starts at the claim line itself, so same-line citations are also matched.
 */
const SEARCH_RADIUS = 3;

export function findAdjacentCitation(
  lines: string[],
  claimIndex: number,
): boolean {
  if (isCitationLine(lines[claimIndex])) return true;
  for (let i = 1; i <= SEARCH_RADIUS; i++) {
    const j = claimIndex + i;
    if (j >= lines.length) break;
    if (isCitationLine(lines[j])) return true;
    // Each claim "owns" the lines up to the next claim. A citation past
    // another claim belongs to that other claim, not this one. Without
    // this stop-condition, an unverified claim would be silently absorbed
    // by a verified claim further down.
    if (isClaimCandidate(lines[j].trim())) return false;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Main validator
// ---------------------------------------------------------------------------

export function validateClosureDoc(
  filePath: string,
  contents: string,
): ValidationReport {
  const lines = contents.split("\n");
  let inScoreboard = false;
  let currentSection = "(none)";
  let scoreboardSections = 0;
  let totalClaims = 0;
  const unverified: UnverifiedClaim[] = [];

  // Track code-fence state so claims inside ``` blocks don't get flagged
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (/^\s*```/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    if (/^#{1,6}\s/.test(trimmed)) {
      currentSection = trimmed;
      const isScoreboard = isScoreboardHeading(trimmed);
      if (isScoreboard) {
        inScoreboard = true;
        scoreboardSections += 1;
      } else {
        // Exit scoreboard mode on ANY non-scoreboard heading regardless of
        // depth (R1-W2). Subsections that ARE scoreboards (e.g. "### Final
        // tally" inside a parent scoreboard) keep scoreboard mode via the
        // isScoreboard branch above, so a sub-section like "### Per-spine
        // breakdown" needs to either match a scoreboard pattern or it
        // correctly exits the scoreboard.
        if (/^#{1,6}\s/.test(trimmed)) {
          inScoreboard = false;
        }
      }
      continue;
    }

    if (!inScoreboard) continue;
    if (!isClaimCandidate(trimmed)) continue;

    totalClaims += 1;
    if (!findAdjacentCitation(lines, i)) {
      unverified.push({
        line: i + 1,
        text: trimmed.slice(0, 200),
        section: currentSection,
      });
    }
  }

  let exitCode: 0 | 1 | 2 = 0;
  if (unverified.length > 0) exitCode = 1;

  return {
    filePath,
    scoreboardSections,
    totalClaims,
    unverifiedClaims: unverified,
    exitCode,
  };
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

export function renderReport(report: ValidationReport): string {
  if (report.exitCode === 2) {
    return `validate-closure-doc: PARSE ERROR for ${report.filePath}\n  ${report.parseError ?? "unknown"}\n`;
  }
  const lines: string[] = [];
  lines.push(`validate-closure-doc: ${report.filePath}`);
  lines.push(
    `  scoreboard sections: ${report.scoreboardSections}, total claims: ${report.totalClaims}, unverified: ${report.unverifiedClaims.length}`,
  );
  if (report.unverifiedClaims.length === 0) {
    lines.push(
      "  CLEAN — every scoreboard claim has an adjacent verified_against citation",
    );
  } else {
    lines.push("  UNVERIFIED CLAIMS:");
    for (const c of report.unverifiedClaims) {
      lines.push(`    L${c.line}: ${c.text}`);
      lines.push(`        (in section: ${c.section.slice(0, 80)})`);
    }
  }
  lines.push("");
  return lines.join("\n");
}
