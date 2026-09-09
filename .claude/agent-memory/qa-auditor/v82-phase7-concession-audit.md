---
name: v82-phase7-concession-audit
description: V8.2 Phase 7 §13 concession handler audit (2026-06-03) — evidence-gate FP class folds-without-evidence once producer ships
metadata:
  type: project
---

# V8.2 Phase 7 — §13 Concession handler audit (2026-06-03)

Verdict: PASS WITH WARNINGS. Dormant + additive; all 8 stated invariants hold for CURRENT traffic. The one load-bearing finding is forward-looking (bites when the producer + ReRunJudgmentFn ship).

**Why:** Phase-closing bundle on the messaging hot path (router.ts:1167). 46 scoped tests pass. typecheck clean.

**How to apply:** When auditing the producer phase that wires `reRunJudgment`, the evidence-gate FP below becomes the §13-defining failure (folding without evidence). Re-check it then.

## W1 (load-bearing) — replyCarriesEvidence FP class: bare disagreement that echoes the judgment's own state-vocabulary reads as EVIDENCE
- `concession.ts:280 replyCarriesEvidence` reuses `cite.ts:247 assertsNonTrivialFact` → `cite.ts:235 hasStateClaim`. cite.ts is RECALL-biased on purpose (over-flag → critic queue, harmless). The concession gate INVERTS the risk: over-flag → fold-with-evidence path.
- FP examples (all should be no-evidence holds): `"I don't think the pilot is at risk"` (THE classifier prompt's own pushback example, concession.ts:78) · `"the deal is not lost"` · `"I disagree it's slipping"` · `"no, it didn't fail"` · `"it hasn't churned"` · `"you're wrong about Acme"` (proper-name branch) · `"it is not blocked"`.
- Root: `hasStateClaim` 2nd regex `/(is|are|was|were|has|have)\s+(at\s+risk|...|blocked|...)/` matches NEGATED/disputed restatements. Pushback NATURALLY restates the disputed claim → guaranteed FP.
- Prod impact today: dormant (reRunJudgment absent → routes deferred_no_rerun not held). Once producer ships: triggers full §9+§11+§12 re-run + writes concession_kind='updated_with_evidence' + appends operator msg as evidence = system folds without evidence. Exact failure §13 exists to prevent.
- FN direction (`"John confirmed it"`, `"per our call"`) is SAFE-by-design (missed evidence → hold, conservative). Only FP is dangerous. Don't flag FNs.
- Fix: gate needs evidence-SPECIFIC signal (number/date/quote/source-marker/proper-name), NOT the citation recall heuristic. Drop the bare `is/are + state-adjective` branch from the evidence path; keep marker/quote/number/date/name. Or add a negation/disagreement guard.

## Confirmed-correct invariants (challenged, held)
- conceded_without_evidence NEVER written by live handler (setConcessionKind type only accepts held_position|updated_with_evidence; cite test asserts COUNT=0). #1 ✓
- held path: no re-run, no ledger mutation, no soften (concession.ts:384-392). #2 ✓
- updated path writes concession_kind ONLY after successful re-run; throw → appendEvidenceRef ran but no concession, no followup (ordering 421→422→424→436). #3 ✓
- classifier fail → cls=null → caller DISCARD_RE fallback, never fabricated pushback. #4 ✓
- unresolvable judgment_id: single-brief repair / multi-brief downgrade-to-promote, never guess. #5 ✓
- SQL all parameterized; appendEvidenceRef parses evidence_refs_json defensively + EvidenceRefSchema.parse on append. #7 ✓
- router fire-and-forget + .catch; sendToChannel(channel,to,text) arg order matches (msg.channel,msg.from,res.reply); res.reply undefined for all V8.1 outcomes. #8 ✓
- DORMANCY chain: every owner inbound → getResolvablePendingBriefing (1 indexed SELECT, same as V8.1) → null early-return; even with pending brief countJudgmentsForBriefing=0 → V8.1 regex, ZERO new LLM. Delivery itself gated off (V81_BRIEF_DELIVERY_ENABLED). ✓
- Only sync caller of now-async resolveBriefingOnOperatorReply = router + test. ✓ FK enforced (foreign_keys=ON for :memory:); tests seed parent first. ✓

## W2 (low, forward-looking) — re-run throw leaves brief pending with evidence appended; operator retry re-appends (no dedup in appendEvidenceRef). Dormant today. Inflates distinct_sources via dup operator_message refs once producer ships.

## Nits
- classifyReply ignores an already-aborted caller signal (no upfront `if(signal.aborted)`); only caller passes none → theoretical.
- dispatch-by-shape mock (concession.test) calls submit.handler directly, bypassing SDK Zod validation of `class`/`rationale` (same documented Phase 3 gap). judgment_id re-guarded in handler; class/rationale trusted. Test-coverage only.
- updated reply interpolates raw triggeringEvidenceText into `"..."` — capped at 600 (EVIDENCE_TEXT_CAP), goes to messaging adapter not SQL/HTML; cosmetic only.
