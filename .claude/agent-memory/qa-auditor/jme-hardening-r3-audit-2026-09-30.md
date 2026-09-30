---
name: jme-hardening-r3-audit-2026-09-30
description: R3 of the JME hardening fold (09-30): FAIL, 1 Crit. A >=0.95 skip-refresh launders inferred/echo wording into a stated 0.99 row; cutoff 0.15 leaves median 3 (31% <=2), ship 0.20
metadata:
  type: project
---
# JME hardening R3 audit, 2026-09-30

Verdict: FAIL, 1 Critical. tsc 0; 245/245 on 4 scoped suites. 12/13 mutations RED (W5 `\b4a\b` re-add survived).

- **Crit W6-launder** (`jme.ts` skip path: `refreshWording = !keepWording && ...`, `confidence = Math.max(stored, ...)`). Test: a stored 0.99 permanent "prefers replies in Spanish" is hit by an inferred 0.7 echo at cos 0.981. Result: text rewritten to "...and wants every reply cc'd to ops" while the row stays 0.99 with NULL expiry. It undoes R1 C2 for stated rows. **Guard:** refresh wording only when incoming clamped confidence >= stored confidence; otherwise only extend expiry. The same laundering class exists on supersede (inherited max confidence), so route an inferred twin of a stated row to the B3 possible-correction signal.
- **Cutoff replay.** Replayed 150 router `conversation_embeddings` (user+reply embeddings, not self-matching) through `queryMemory` with the cutoff varied:

  | cutoff | median facts | share <= 2 | share == 1 |
  |---|---|---|---|
  | 0.10 | 1 | 83% | 77% |
  | 0.15 | 3 | 31% | 11% |
  | 0.20 | 4 | 1% | 0% |
  | 0.25 | 8 | 0% | 0% |

  Mechanism: the vector-only fused spread is tiny (top p50 0.435, top minus 8th = 0.031). The band therefore binds only through the gated keyword bonus (+0.3), so recall degenerates into keyword-overlap facts. **Ship 0.20.**
- **Warn W1-log:** the malformed-element `console.warn` prints the raw element (a `sk-ant` key reached journald in the test). Redact first. The pre-existing identity-inversion warn has the same issue.
- **W1-conf:** 248/248 facts in 30 d have confidence != 1.0 for non-preferences, but the 33 preferences at 0.7 cannot prove the field was present. The prompt never says "required", so add it.
- **Unknown category** now dropped instead of defaulting to decision: an undocumented behaviour change.
- **W3:** `JME_REDACT_ALLOW_EMAILS` unset means own addresses get redacted from night 1. Live rows are untouched. The operator adds the line to `.env` before deploy.
- **Standards:** prompt tests pin strings (toMatch on directive wording). Acceptable as a contract, but brittle.
