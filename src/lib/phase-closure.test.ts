import { describe, expect, it } from "vitest";
import {
  auditClosureDoc,
  draftClosureDoc,
  draftTagMessage,
  draftWatchlist,
  extractCommitHashes,
  extractDocRefs,
  extractOpenQueueItems,
  parseSpineTable,
} from "./phase-closure.js";

const SAMPLE_GUIDE = `# V9.9 — Operating Guide

Some preamble.

## Spine progress

| Spine | Status | Closure commits | Audit log | Pre-existing finds | Bundle-regressions caught |
| ----- | ------ | --------------- | --------- | ------------------ | ------------------------- |
| 1 — Alpha substrate | **CLOSED 2026-06-01** ([impl](./planning/a.md)) | B1 \`abc1234\` · B2 \`def5678\` | [B1](./audit/a1.md) | 0 | +20 tests |
| 2 — Beta substrate | **CLOSED 2026-06-02** | B1 \`9999abc\` | [B1](./audit/b1.md) | 1 | +12 tests |
| 3 — Gamma | **Pending** | — | — | — | — |

## Mission

Not a table row.
`;

describe("parseSpineTable", () => {
  it("parses every data row of the spine-progress table", () => {
    const rows = parseSpineTable(SAMPLE_GUIDE);
    expect(rows).toHaveLength(3);
    expect(rows[0].spine).toBe("1 — Alpha substrate");
    // markdown-stripped status
    expect(rows[0].status).toBe("CLOSED 2026-06-01 (impl)");
    expect(rows[2].status).toBe("Pending");
  });

  it("skips a malformed row with fewer than 6 cells", () => {
    const guide = SAMPLE_GUIDE.replace(
      "| 3 — Gamma | **Pending** | — | — | — | — |",
      "| 3 — Gamma | broken |",
    );
    expect(parseSpineTable(guide)).toHaveLength(2);
  });

  it("returns [] when there is no spine table", () => {
    expect(parseSpineTable("# Doc\n\nNo table here.\n")).toEqual([]);
  });

  it("parses a table that is the last thing in the file (no trailing heading)", () => {
    const eofGuide = SAMPLE_GUIDE.slice(
      0,
      SAMPLE_GUIDE.indexOf("\n## Mission"),
    );
    expect(parseSpineTable(eofGuide)).toHaveLength(3);
  });
});

describe("extractOpenQueueItems", () => {
  const QUEUE = `# Next sessions queue

## Execution-ordered queue

| #   | Item            | Priority |
| --- | --------------- | -------- |
| 1   | AV key rotation | P0       |
| 17  | batch tools     | P1       |

## v7.7 Spine 6 deferreds

| #                       | Item     | Priority |
| ----------------------- | -------- | -------- |
| S6-recall-audit-dormant | dormant  | P2       |
| S4-B3-R2                | sql guard| P3       |

## Session log

| Session | Items | Date       |
| ------- | ----- | ---------- |
| 2026-05 | 9     | 2026-05-18 |

## Closed-item example

| 9   | ~~old task~~ ✅ DONE | P1 |
`;

  it("excludes closed (struck-through / checkmarked) rows", () => {
    expect(extractOpenQueueItems(QUEUE).join("\n")).not.toContain("old task");
  });

  it("picks numeric-ID and hyphenated-ID item rows", () => {
    const items = extractOpenQueueItems(QUEUE);
    const firstCells = items.map((l) => l.split("|")[1].trim());
    expect(firstCells).toEqual([
      "1",
      "17",
      "S6-recall-audit-dormant",
      "S4-B3-R2",
    ]);
  });

  it("excludes table headers and foreign (session-log) tables", () => {
    const joined = extractOpenQueueItems(QUEUE).join("\n");
    expect(joined).not.toContain("Session");
    expect(joined).not.toContain("Item"); // the header cell
    expect(joined).not.toContain("2026-05 "); // the session-log data row
  });

  it("returns [] for a doc with no item tables", () => {
    expect(extractOpenQueueItems("# Doc\n\nprose only\n")).toEqual([]);
  });
});

describe("extractCommitHashes", () => {
  it("finds distinct backtick-wrapped hashes", () => {
    expect(
      extractCommitHashes("shipped `abc1234` then `def5678` and `abc1234`"),
    ).toEqual(["abc1234", "def5678"]);
  });

  it("ignores non-hash backtick spans and bare words", () => {
    expect(extractCommitHashes("`hello` abc1234 `runSkill`")).toEqual([]);
  });
});

describe("extractDocRefs", () => {
  it("finds distinct docs/*.md references", () => {
    expect(
      extractDocRefs(
        "see docs/planning/x.md and docs/audit/y.md and docs/planning/x.md",
      ),
    ).toEqual(["docs/planning/x.md", "docs/audit/y.md"]);
  });
});

describe("draftClosureDoc", () => {
  it("produces a CLOSURE skeleton with a section per spine", () => {
    const rows = parseSpineTable(SAMPLE_GUIDE);
    const doc = draftClosureDoc("v9.9", rows);
    expect(doc).toContain("# v9.9 — Closure");
    expect(doc).toContain("## Status: CLOSED");
    expect(doc).toContain("2 / 3 spines closed"); // 2 of 3 rows are CLOSED
    expect(doc).toContain("### Spine 1 — Alpha substrate");
    expect(doc).toContain("### Spine 3 — Gamma");
    expect(doc).toContain("TODO(operator)"); // skeleton, not autopilot
  });
});

describe("draftWatchlist", () => {
  it("lists open items under Tier A", () => {
    const wl = draftWatchlist("v9.9", ["S9-A1 — do a thing", "#42 — another"]);
    expect(wl).toContain("# v9.9 — Post-Closure Watchlist");
    expect(wl).toContain("- S9-A1 — do a thing");
    expect(wl).toContain("Tier A");
  });

  it("handles an empty open-item list", () => {
    expect(draftWatchlist("v9.9", [])).toContain("no open queue items");
  });
});

describe("draftTagMessage", () => {
  it("summarises the spines closed", () => {
    const msg = draftTagMessage("v9.9", parseSpineTable(SAMPLE_GUIDE));
    expect(msg).toContain("v9.9 closed — 2/3 spines");
    expect(msg).toContain("git tag -a v9.9-closed");
  });
});

describe("auditClosureDoc", () => {
  const doc =
    "Shipped `abc1234` and `def5678`. See docs/planning/x.md and docs/audit/y.md.";

  it("passes when every commit + ref resolves", () => {
    const r = auditClosureDoc(doc, {
      commitExists: () => true,
      fileExists: () => true,
    });
    expect(r.verdict).toBe("pass");
    expect(r.missingCommits).toBe(0);
    expect(r.missingRefs).toBe(0);
  });

  it("reports issues when a commit is missing", () => {
    const r = auditClosureDoc(doc, {
      commitExists: (h) => h !== "def5678",
      fileExists: () => true,
    });
    expect(r.verdict).toBe("issues");
    expect(r.missingCommits).toBe(1);
    expect(r.commitChecks.find((c) => c.hash === "def5678")!.exists).toBe(
      false,
    );
  });

  it("reports issues when a doc reference is missing", () => {
    const r = auditClosureDoc(doc, {
      commitExists: () => true,
      fileExists: (p) => p !== "docs/audit/y.md",
    });
    expect(r.verdict).toBe("issues");
    expect(r.missingRefs).toBe(1);
  });
});
