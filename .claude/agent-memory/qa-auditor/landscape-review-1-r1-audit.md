---
name: landscape-review-1-r1-audit
description: R1 audit of S2 landscape review #1 (docs-only, uncommitted on 16fa9e4, 2026-10-03) - review note, LANDSCAPE.md register, ROADMAP rows, qa-auditor index trim
metadata:
  type: project
---

# Landscape review #1 - R1 audit (uncommitted, base 16fa9e4, 2026-10-03)

**Verdict: FAIL, 1 Crit, 8 Warn, 6 Info.** Docs-only, so there was no tsc or vitest run and no mutants.

## Clean (stated once)
- About 75 `file:line` citations opened. One had drifted: `src/a2a/agent-card.ts:66,70`, where the right lines are :67,71.
- About 40 upstream facts checked against the raw downloads plus registry re-fetches: agent SDK 0.3.288 with 35 published releases after 0.3.245 (the CHANGELOG lists 43 headings, but 35 versions are in the registry); MCP docs.json "2026-07-28 (latest)"; draft schema LATEST=2026-07-28; installed 1.29.0, 1.32.0 and v2 core 2.3.0 all LATEST=2025-11-25; A2A 1.0.1 (2026-05-26), §5.3 PascalCase methods, the `final` removal, `agent-card.json` in 0.3.0, #1396. Every quote is verbatim apart from markdown markup.
- Memory trim: 16125 B, no line over 180 characters, link set identical to HEAD, archive body cmp-identical to HEAD MEMORY.md.
- ROADMAP is 61 lines. No secrets or personal data found. 59 items counted.

## Findings
- **Crit:** headline 1 and a16 say the 0.3.273 Stop-hook change is "inert at the current pin; real after the bump". The CHANGELOG wording for the old path is "reported as a hook failure and discarding other hooks' decisions". With ONE Stop hook, the stop proceeds before and after the bump, so the gap exists TODAY. The binary was not checked.
- W: the register groups rows whose member verdicts differ (a1-a4 includes a3=ignore; a16-a22 includes a21/a22=ignore; b5,b6 "ignore" while b6 is adopt). Rows missing: a23, b10 (borrow, owner L4, but absent from the L4 scope), d7.
- W: verdicts outside the vocabulary: c6 "candidate if unused" and the register's "build (shim) or retire". a6 is a borrow with no owner ("unscheduled").
- W: the archive is gitignored but cited from the tracked ROADMAP row, so it needs `git add -f`. L4 has no ROADMAP row.

## Doctrine
- CLASS: a changelog "X now counts as no decision" entry is a behaviour change only if the OLD outcome differed for OUR hook count. Read the "was" clause and check it against our config before you call the old pin safe.
- CLASS: a grouped register row (`[a16-a22] adopt`) launders the minority verdicts inside the range. Check each member id against the note.
- learn.microsoft.com and docs.langchain.com are denied by curl egress here. WebFetch works for learn.microsoft.com.
