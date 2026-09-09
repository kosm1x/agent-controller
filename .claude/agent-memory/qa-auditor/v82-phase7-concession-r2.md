---
name: v82-phase7-concession-r2
description: V8.2 Phase 7 §13 concession C1 evidence-gate fix R2 re-verification (2026-06-03) — C1 RESOLVED, one narrower residual FP from marker-list noun phrases
metadata:
  type: project
---

# V8.2 Phase 7 §13 Concession — C1 fix R2 re-verification (2026-06-03)

Follow-up to [[v82-phase7-concession-audit]] which raised Critical C1: `replyCarriesEvidence` (concession.ts) reused cite.ts RECALL-biased `hasStateClaim`/`hasProperName` → bare pushback restating disputed state-vocab ("I don't think the pilot is at risk") or naming subject ("you're wrong about Acme") false-read as evidence → folds WITHOUT evidence (the §13 failure).

**Verdict: C1 RESOLVED (PASS WITH WARNINGS).**

The fix: `replyCarriesEvidence` (src/lib/v8-2/concession.ts:297-306) now = ONLY `hasNumber || hasDate || QUOTED_SPAN_RE.test || EVIDENCE_MARKER_RE.test`. Dropped the 3 cite.ts helpers entirely (now only a doc comment at :283; they stay LIVE in cite.ts for the §11 citation path — correct, recall-bias harmless there). Empirically re-derived all 7 C1 regressions + 5 §14 control probes + 2 ES + empty/whitespace = all FALSE; all 8 HAS_EVIDENCE + 4 spec-legit sanity forms = all TRUE. typecheck clean; concession.test.ts 42/42, src/briefing/promote.test.ts 12/12 (= the prior audit's "54").

**Danger asymmetry (load-bearing):** in this gate a false-positive folds-without-evidence (the §13 failure, BAD); a false-negative merely HOLDS the position (operator can restate with a concrete anchor, SAFE). Drop biases toward FN = correct direction.

**W-residual-FP (narrower than original C1, dormant today):** `EVIDENCE_MARKER_RE` (concession.ts:266) includes bare noun-phrase alternatives `the\s+(client|customer|contract|report|email|invoice|document)` + ES `el/la cliente`, `el contrato`, etc. These fire on a bare disagreement that merely NAMES the artifact without citing it. Verified live: `"the client is fine, you're wrong"` → TRUE[marker]; `"that's not right, the contract claim is wrong"` → TRUE[marker]. Same §13 fold-without-real-evidence class, just a different trigger. STRICTLY narrower than original C1 (needs operator to name an artifact noun, not just any proper name / any state-vocab). Fully dormant: no `reRunJudgment` producer wired → has-evidence path defers (concession.ts:411-422). Must close before Phase-8 producer ships. Fix: gate the artifact-noun behind an attribution verb/prep (`(per|según|en|in)\s+the\s+contract`) or pair with quote/date. The CLEAN markers (said/dijo/según/per the/told me/screenshot/attached) are attribution verbs and DON'T have this problem.

**New FN class (acceptable, no action):** genuine verbal/observational evidence with NO number/date/quote/marker now HOLDS — "I just got off a call with them", "they confirmed in person", "the renewal already closed". Safe-default per the asymmetry; operator restates with an anchor.

**W2 dedup CORRECT:** appendEvidenceRef (judgments-store.ts:196-202) keys identity on `(kind, excerpt)`, EXCLUDING `id` + `retrieved_at` (both timestamp-derived, vary per retry attempt). Test concession.test.ts:457-472 mutates `id` on retry yet ledger stays length 1 — exactly the re-run-failure→operator-retry case. A genuinely DISTINCT second message has different excerpt → appends normally. Identity is right.

Doctrine confirmation: structurally-sound C1 fix surfaces a forward-looking contract residual (marker-list noun-phrase FP) that is COST-of-fix-design, not a moved regression — fold into Phase-8 producer-wiring work, don't block the dormant ship. Matches [[round2-audit-pattern]].
