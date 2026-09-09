---
name: hermes-ssrf-standing-orders-r3-audit
description: R3 closure audit (2026-09-01) of the Hermes SSRF + standing-orders cherry-picks — R2 folds verified. PASS WITH WARNINGS, 0 new Criticals; 3 disk-door call sites unpinned, 4 stale numbers in the review note.
metadata:
  type: project
---

# Hermes upstream R3 — closure (2026-09-01)

Verdict: **READY FOR CLOSURE / PASS WITH WARNINGS**. 428 tests GREEN across the 7 scoped
files. Both R2 Criticals closed and re-proved by live `npx tsx` probes against `src`.

## Lessons (reusable)

1. **A guard can be pinned at the FUNCTION level and still be unpinned at every CALL SITE.**
   `isStandingOrdersDiskPath` has 3 unit tests (immutable-core.test.ts:487-520) but zero test
   exercises the three wirings (`file.ts:111` isWriteAllowed, `file.ts:450` file_delete,
   `code-editing.ts:142`). `grep -rn "is a standing order" src --include=*.test.ts` → 0 hits.
   Delete any of the three `if (...)` blocks and the suite stays 428/428 GREEN. When a round
   folds "wire guard G into door D", grep the tests for D's REFUSAL MESSAGE, not for G's name.
2. **A generated `it()` does not show up as an added `it(` in the diff.** shell.test.ts
   `added_it=0` looked like an unpinned fold, but the fix added 3 ROWS to a `blocked` table
   consumed by a file-scope `for … { it(\`should block: ${cmd}\`) }` (shell.test.ts:187) — 3
   real tests. Count generated tests by the vitest per-file total, not by `grep -c '^\s*it('`.
3. **A command-text write guard inherits the extractor's blind spots, not the path's.**
   `DENY_WRITE_PATTERNS` is only consulted on paths that `WRITE_INDICATORS`
   (`/(?:>\s*|>>\s*|tee\s+|mv\s+\S+\s+|cp\s+\S+\s+)(\/[^\s]+)/g`, shell.ts:398) extracts, so a
   QUOTED path (`echo x > "/…/directives/core.md"` → allowed) and any in-place editor
   (`sed -i … /…/directives/core.md`, `python3 -c 'open(…,"w")'` → allowed) skip it. Parity
   check settles the classification: the SAME spellings also skip the pre-existing
   mission-control immutable-core deny (`echo x > "/root/claude/mission-control/src/index.ts"`
   → allowed, unquoted → blocked). Pre-existing extractor class, not a bundle regression — same
   family as the documented `cd`-then-relative-write residual.
4. **Verified-closed probes (keep as the regression spelling set).** `canonicalKbPath` maps
   `../jarvis-kb/directives/core.md`, `../../claude/jarvis-kb/directives/core.md`,
   `knowledge/../directives/core.md`, `DIRECTIVES/`, `" directives/"`, `..\jarvis-kb\…`,
   `directives`, `directives/` ALL to `directives[/core.md]` ⇒ guard fires.
   `dir%65ctives/core.md` → null, correct (join never percent-decodes).

## Stale numbers found in docs/planning/hermes-upstream-review-2026-09-01.md

- :71 call-site list "in `file_write` + `code_edit`" — missing `file_delete` and the
  `shell_exec` DENY_WRITE_PATTERNS entry (both added in R2).
- :71 `canonicalKbPath` described as "trim, `\`→`/`, `posix.normalize`, strip leading `./` `/`,
  lowercase" — that is the R1 implementation R2-C1 REPLACED with root-relative resolution.
- :74 evidence "2 file_delete" tests — zero exist.
- :214 "bundle-regression catches **4**" while the same sentence enumerates **6**.
- Correct: 19 url-safety (:51), 15 reindex (:170), 3 shell, 3 disk-path.

## Honest split (confirmed)

Pre-existing 5: C3 doors (file_write/code_edit/reindex/file_delete/shell) · pdf.ts fetch ·
gemini upload fetch · mirrorToDisk slash · hex-mapped v4.
Bundle-regression 6: R1-C1 headers · R1-C2 spellings · R2-C1 round-trip · message
interpolation · code_edit resolve · header hygiene.
