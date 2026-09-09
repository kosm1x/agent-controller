---
name: v82-phase4-cite-audit
description: V8.2 Phase 4 citation resolver + drop-vs-surface audit (2026-06-02) — PASS WITH WARNINGS
metadata:
  type: project
---

# V8.2 Phase 4 — Citation + [N] resolver audit (2026-06-02)

Files: src/lib/v8-2/cite.ts, should-surface.ts, +2 tests. Additive+dormant (no producer calls it).

**Verdict: PASS WITH WARNINGS.** 0 Critical. tsc clean, 26 tests pass.

Design claims all VERIFIED TRUE by probe:
- 1-indexed [K]→ledger[K-1], K∈{1..N}; [0] and K>N invalid (cite.ts:263).
- Set-dedup preserves APPEARANCE order: [3][1]→[3,1], [1][3][1]→[1,3] (cite.ts:269).
- Schema invariant holds: only resolved claims persist; toAttributedClaimRows emits all 4 evidence_* fields, status='resolved' (valid CHECK value). Unresolved never persisted (would violate NOT NULL).
- persist: transaction, getDatabase() default, parameterized, column order matches DDL, empty→0 no-op.
- prose_offset round-trips: offset=start (post-leading-ws-skip), .trim() only strips leading ws already skipped → prose.slice(offset,offset+len)===claim_text in all probed cases incl trailing-ws-before-dot.
- resolver_hit_rate excludes pure-editorial from denominator (1 resolved+1 editorial→1.0 not 0.5). VERIFIED but NOT explicitly tested (only standalone-editorial + resolved+factual tested).
- should-surface matches spec §9 line 387 exactly (posture==at_risk OR kind==recurring_blocker → surface; else drop; at_risk wins). Correctly does NOT read confidence (red is a caller precondition, not a filter). It's the §8-deferred carve-out (should-multi-option.ts:16-21 documents the handoff).

**Warnings (all by-design RECALL-bias, but real FN class):**
- W1 non-trivial-fact heuristics are word-list based → FALSE NEGATIVES: "Acme signed the contract." (proper-name first-token-exempt + verb not in list), "The renewal was cancelled.", "Their budget shrank.", "Revenue is below target.", "The account is churning." all slip through as editorial (asserts()=false). §11 critic is precision stage so this is the dangerous direction (missed > over-flagged). Documented intent at cite.ts:151-153.
- W2 resolver_hit_rate editorial-exclusion is the most non-obvious branch and is untested.

**Info / untested branches (acceptable for dormant code):**
- startClaimId tested for single claim only, not multi-claim continuation across a 2nd judgment.
- FK-violation persist path untested (foreign_keys=ON at index.ts:38, so a bad judgment_id WOULD throw — no negative test).
- transaction rollback untested.
- splitSentences over-splits abbreviations ("Inc.") — documented harmless.

Posture divergence (momentum vs has_momentum) is the known Phase-2-normalizes issue, NOT a Phase-4 bug; test correctly uses has_momentum (the Judgment TS type).
