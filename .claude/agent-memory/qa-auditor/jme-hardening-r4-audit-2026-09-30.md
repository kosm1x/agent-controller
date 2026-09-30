---
name: jme-hardening-r4-audit-2026-09-30
description: JME hardening R4 verification (09-30) - PASS-WITH-NOTES, R3 C1 + W1-W3 closed, 7/8 mutants RED, tsc 0, 255/255; non-preference supersede still inherits max confidence
metadata:
  type: project
---

R4 verification of the R3 folds in src/memory/jme.ts (uncommitted). Verdict: PASS-WITH-NOTES, 0 Crit.

Closed:
- C1(a) skip path: `refreshWording = (clamped.confidence ?? 1) >= stored.confidence && ...`. Repro stated 0.99 + inferred 0.7 @cos .981: wording kept, 0.99, permanent. Confirmed 1.0 + stated 0.99: kept (the 0.99 cap covers it).
- C1(b) supersede: inferred (<=0.7) preference vs a stated member (>0.7) -> skip + B3 signal, 1 row. Repro @cos .894 OK.
- W1 cutoff 0.20 (pinned by a 0.17-below test); W2 both warn lines redacted (sk-ant absent); W3 prompt REQUIRED + missing->0.7, null drops.

Notes:
- Non-preference launder (by design, low): 0.65 `project` "November" over 0.95 "October" @.894 -> superseded, new row 0.95. Confidence there only weights ranking (cos x conf) and the <0.4 prune; the TTL is text-driven. Newer wording replacing older is the intended project/event semantics. Acceptable; optional follow-up is to take the incoming confidence for non-preference categories.
- Skip on a closer INFERRED member (cos .974) while a stated member sits at .891: the inferred row is refreshed, the stated row is untouched, and no signal is written. No class launder.
- `?? 1` treats an undefined confidence as stated. Unreachable: the only caller (consolidateAll) always sets it via parseExtractedFact.
- Mutant survived: the signal sort `b.sim - a.sim` reversed (it only changes which stated id is named when there are 2 or more).

**Why:** closes the R1->R4 chain; see [[jme-hardening-r3-audit-2026-09-30]].
**How to apply:** CLASS: max-confidence inheritance is a launder only where confidence encodes a CLASS (preference stated/inferred); elsewhere it is a ranking weight.
