/**
 * Phase-closure continuity tooling — v7.7 Spine 7 (Q4 absorption).
 *
 * Codifies the closure ritual run by hand for v7.5, v7.6, and v7.7 into
 * deterministic, testable primitives:
 *
 *   - `parseSpineTable`   — read the "## Spine progress" table out of a
 *                           `<NAME>-GUIDE.md`.
 *   - `draftClosureDoc`   — generate a `<NAME>-CLOSURE.md` SKELETON from the
 *                           spine rows (operator edits before tagging).
 *   - `draftWatchlist`    — generate the post-closure watchlist skeleton.
 *   - `draftTagMessage`   — generate an annotated-tag message draft.
 *   - `auditClosureDoc`   — deterministically verify a closure doc: every
 *                           commit hash exists, every `docs/` reference
 *                           resolves.
 *
 * These are PURE functions — no file I/O, no git, no LLM. The CLI
 * (`scripts/phase-ctl.ts`) injects the side effects. Per the Spine 7
 * constraint, nothing here executes a git operation; `draft*` produce text
 * the operator reviews and promotes by hand.
 */

export interface SpineRow {
  /** Column 1 verbatim, e.g. "1 — S2: Self-audit before reporting". */
  spine: string;
  /** Column 2, markdown-stripped, e.g. "CLOSED 2026-05-19". */
  status: string;
  /** Column 3 — closure commit refs. */
  closureCommits: string;
  /** Column 4 — audit-log links. */
  auditLog: string;
  /** Column 5 — pre-existing finds. */
  preExistingFinds: string;
  /** Column 6 — bundle-regressions caught / cumulative notes. */
  bundleRegressions: string;
}

export interface ClosureAuditResult {
  commitChecks: Array<{ hash: string; exists: boolean }>;
  refChecks: Array<{ path: string; exists: boolean }>;
  missingCommits: number;
  missingRefs: number;
  /** "pass" when nothing is missing; "issues" otherwise. */
  verdict: "pass" | "issues";
}

/** Strip markdown links and emphasis to plain text. */
function stripMarkdown(cell: string): string {
  return cell
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // [text](url) → text
    .replace(/[*`]/g, "")
    .trim();
}

/**
 * Split a markdown table row into trimmed cells (drops the outer pipes).
 * Contract: cells must not contain a literal `|` (e.g. a pipe inside a link
 * URL) — such a row over-splits. Closure-doc tables are operator-authored
 * and do not do this; documented rather than escaped.
 */
function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((c) => c.trim());
}

/** True for a markdown table separator row (`| --- | --- |`). */
function isSeparatorRow(line: string): boolean {
  return /^\|?[\s:|-]+\|?$/.test(line.trim()) && line.includes("-");
}

/**
 * Parse the spine-progress table out of a `<NAME>-GUIDE.md`.
 *
 * Locates the first markdown table whose header's first column is `Spine`,
 * then returns one `SpineRow` per data row. Rows that do not split into ≥6
 * cells are skipped (defensive — a malformed row never throws or produces a
 * silently-wrong draft; the caller can compare counts).
 */
export function parseSpineTable(guideMarkdown: string): SpineRow[] {
  const lines = guideMarkdown.split("\n");
  const rows: SpineRow[] = [];

  let inTable = false;
  let headerSeen = false;
  for (const line of lines) {
    const isTableLine = line.trim().startsWith("|");
    if (!inTable) {
      if (isTableLine && splitRow(line)[0]?.toLowerCase() === "spine") {
        inTable = true;
        headerSeen = true;
      }
      continue;
    }
    // Inside the table.
    if (!isTableLine) break; // table ended
    if (isSeparatorRow(line)) continue;
    if (headerSeen && splitRow(line)[0]?.toLowerCase() === "spine") {
      continue; // the header row itself
    }
    const cells = splitRow(line);
    if (cells.length < 6) continue; // malformed — skip defensively
    rows.push({
      spine: cells[0],
      status: stripMarkdown(cells[1]),
      closureCommits: cells[2],
      auditLog: cells[3],
      preExistingFinds: cells[4],
      bundleRegressions: cells[5],
    });
  }
  return rows;
}

/** Every distinct backtick-wrapped git short/long hash in a blob. */
export function extractCommitHashes(text: string): string[] {
  const out = new Set<string>();
  const re = /`([0-9a-f]{7,40})`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.add(m[1]);
  return [...out];
}

/** Every distinct in-repo `docs/…​.md` reference in a blob. */
export function extractDocRefs(text: string): string[] {
  const out = new Set<string>();
  const re = /\bdocs\/[A-Za-z0-9._/-]+\.md\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.add(m[0]);
  return [...out];
}

/**
 * Extract OPEN queue-item rows from a `next-sessions-queue.md`-style doc.
 *
 * A queue item is a markdown table row whose FIRST cell is an item ID — a
 * number (`1`, `#2`) or a hyphenated tag (`S4-B3-R2`,
 * `S6-recall-audit-dormant`). This deliberately EXCLUDES:
 *   - table headers (`Item`, `Priority`, `Session`, `Date` — not numeric,
 *     no hyphen) and separator rows — so a session-log or changelog table
 *     elsewhere in the file is never ingested;
 *   - CLOSED items — rows struck through (`~~…~~`) or checkmarked (`✅`),
 *     this codebase's convention for a done queue line.
 * Returns each matching open row verbatim (trimmed).
 */
export function extractOpenQueueItems(queueMarkdown: string): string[] {
  const idCell = /^(#?\d+|[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+)$/;
  const out: string[] = [];
  for (const line of queueMarkdown.split("\n")) {
    if (!line.trim().startsWith("|")) continue;
    if (isSeparatorRow(line)) continue;
    if (line.includes("~~") || line.includes("✅")) continue; // closed
    const cells = splitRow(line);
    if (cells.length > 0 && idCell.test(cells[0])) out.push(line.trim());
  }
  return out;
}

/**
 * Draft a `<NAME>-CLOSURE.md` skeleton from the parsed spine rows. This is a
 * SKELETON — per the Spine 7 design, the operator edits it (fills the
 * scoreboard, the patterns, the residual triggers) before tagging.
 */
export function draftClosureDoc(phase: string, rows: SpineRow[]): string {
  const today = new Date().toISOString().slice(0, 10);
  const closed = rows.filter((r) => /closed/i.test(r.status)).length;

  const spineSections = rows
    .map(
      (r) =>
        `### Spine ${r.spine}\n\n` +
        `- **Status**: ${r.status}\n` +
        `- **Closure commits**: ${stripMarkdown(r.closureCommits)}\n` +
        `- **Audit log**: ${stripMarkdown(r.auditLog)}\n` +
        `- **Pre-existing finds**: ${stripMarkdown(r.preExistingFinds)}\n` +
        `- **Notes**: ${stripMarkdown(r.bundleRegressions)}\n` +
        `\n<!-- TODO(operator): expand into a prose paragraph. -->`,
    )
    .join("\n\n");

  return `# ${phase} — Closure

<!-- DRAFT generated by \`mc-ctl close-phase ${phase}\` on ${today}.
     EDIT before tagging — the scoreboard, patterns, and residual triggers
     below are skeletons. The annotated tag is a separate operator step. -->

## Status: CLOSED ${today}

${closed} / ${rows.length} spines closed.

## What ${phase} shipped (spine-by-spine)

${spineSections}

## Cumulative scoreboard at closure

| Metric                 | At closure                          |
| ---------------------- | ----------------------------------- |
| Spines closed          | ${closed} / ${rows.length}          |
| New tests              | <!-- TODO(operator): sum --> |
| Production regressions | <!-- TODO(operator) --> |
| Net LOC                | <!-- TODO(operator): sum --> |

<!-- TODO(operator): add the metric rows this phase tracked. -->

## Patterns observed in ${phase}

<!-- TODO(operator): the 2-3 transferable patterns. -->

## Residual items — re-open triggers

<!-- TODO(operator): Tier A open queue items, Tier B anti-mission deferrals. -->

## Recommended next phase entry point

<!-- TODO(operator). -->
`;
}

/**
 * Draft the post-closure watchlist from the active queue's open items.
 * `openItems` is the caller-extracted list of still-open queue lines.
 */
export function draftWatchlist(phase: string, openItems: string[]): string {
  const today = new Date().toISOString().slice(0, 10);
  const body =
    openItems.length > 0
      ? openItems.map((i) => `- ${i}`).join("\n")
      : "_(no open queue items at closure)_";
  return `# ${phase} — Post-Closure Watchlist

> **Status**: Watchlist, NOT actionable backlog.
> **Origin**: Created at ${phase} closure (${today}) by \`mc-ctl close-phase\`.
>
> Items here have explicit re-open triggers. Until a trigger fires, nothing
> here requires engineering effort.

## Tier A — open queue items inherited from \`next-sessions-queue.md\`

${body}

## Tier B — anti-mission deferrals

<!-- TODO(operator): items this phase declared out-of-scope, each with a forward-anchor. -->
`;
}

/** Draft an annotated-tag message. The operator runs the actual `git tag`. */
export function draftTagMessage(phase: string, rows: SpineRow[]): string {
  const closed = rows.filter((r) => /closed/i.test(r.status)).length;
  return (
    `${phase} closed — ${closed}/${rows.length} spines.\n\n` +
    rows
      .map((r) => `- Spine ${r.spine.split("—")[0].trim()}: ${r.status}`)
      .join("\n") +
    `\n\n<!-- review, then: git tag -a ${phase.toLowerCase()}-closed -m "<this message>" -->`
  );
}

/**
 * Deterministically verify a closure doc: every commit hash it cites must
 * exist, every `docs/` path it references must resolve. The existence
 * predicates are injected so this stays pure and testable; the CLI passes
 * real `git cat-file` / `fs.existsSync` implementations.
 */
export function auditClosureDoc(
  closureMarkdown: string,
  predicates: {
    commitExists: (hash: string) => boolean;
    fileExists: (path: string) => boolean;
  },
): ClosureAuditResult {
  const commitChecks = extractCommitHashes(closureMarkdown).map((hash) => ({
    hash,
    exists: predicates.commitExists(hash),
  }));
  const refChecks = extractDocRefs(closureMarkdown).map((path) => ({
    path,
    exists: predicates.fileExists(path),
  }));
  const missingCommits = commitChecks.filter((c) => !c.exists).length;
  const missingRefs = refChecks.filter((r) => !r.exists).length;
  return {
    commitChecks,
    refChecks,
    missingCommits,
    missingRefs,
    verdict: missingCommits + missingRefs === 0 ? "pass" : "issues",
  };
}
